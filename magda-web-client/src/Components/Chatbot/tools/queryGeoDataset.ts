/**
 * GeoSQL tool orchestration entrypoint.
 *
 * Relationship with submodules in `tools/queryGeoDataset/`:
 * - `distribution.ts`: selects spatial-compatible distributions and resolves URLs.
 * - `description.ts`: builds deterministic tool description + per-file YAML schema metadata.
 * - `schema.ts`: samples `features.properties` keys for runtime hints.
 * - `placeResolver.ts`: resolves `placeName` to lon/lat (dataset-first, then Nominatim).
 * - `sql.ts`: sanitizes SQL, provides error suggestions, and runs model-based one-shot repair.
 *
 * Execution chain:
 * 1) createQueryGeoDatasetTool -> detect valid spatial distributions.
 * 2) createQueryGeoDatasetTool -> assemble prompt/metadata for LLM tool-calling.
 * 3) queryGeoSpatialWithSQLQuery -> import features, resolve place token, sanitize SQL.
 * 4) Execute SQL with one retry path (self-correction) on failure, then return markdown table.
 */
import {
    createChatEventMessageCompleteMsg,
    createChatEventMessageErrorMsg,
    createChatEventRunLogMsg
} from "../Messaging";
import { ChainInput, DatasetProfile } from "../commons";
import {
    DEFAULT_SPATIAL_IMPORT_FEATURE_LIMIT,
    formatImportSpatialResult,
    getLoadedDistribution,
    importSpatialFromDistribution,
    runPostgisQuery
} from "../../../libs/pglitePostgis";
import { WebLLMTool } from "../ChatWebLLM";
import { webLlmChatCompletion, webLlmResetChat } from "../webLlmSerial";
import { markdownTable } from "markdown-table";
import { ParsedDistribution } from "helpers/record";
import { config } from "../../../config";
import { resolveReferencePoint } from "./queryGeoDataset/placeResolver";
import { buildGeoFileDescriptionsAndIntro } from "./queryGeoDataset/description";
import {
    getDistributionUrl,
    isGeoSpatialDistribution
} from "./queryGeoDataset/distribution";
import { sampleGeoPropertyKeys } from "./queryGeoDataset/schema";
import {
    chooseCoreDisplayKeys,
    formatGeoSqlPropertyProjection,
    getGeoSqlErrorSuggestion,
    repairGeoSqlWithModel,
    sanitizeGeoSql
} from "./queryGeoDataset/sql";
import {
    extractGeoQueryScope,
    GeoQueryScope
} from "./queryGeoDataset/scopeExtractor";
import {
    buildDeterministicTaskSpec,
    buildSqlFromExecutionPlan,
    formatTaskSpecExecutionPlanForPlanner,
    formatTaskSpecForPlanner,
    GeoQueryTaskSpec,
    resolveGeoQueryTaskSpec
} from "./queryGeoDataset/geoQueryTaskInterpreter";
import {
    astFromTaskSpec,
    shouldUseDeterministicRenderer
} from "./queryGeoDataset/executableAst";
import { renderSqlFromAst } from "./queryGeoDataset/sqlRenderer";
import { tryRenderSpatialSql } from "./queryGeoDataset/spatialSqlRenderer";
import {
    extractListRowLimitFromQuestion,
    questionImpliesGeomPredicateCount,
    questionImpliesPropertyAttributeAggregate
} from "./queryGeoDataset/geoQueryQuestionPatterns";
import type { GeoReference, SpatialIntentResult } from "../chatRouteRouter";

/** TEMP: screenshot / repair demo — revert to `false` before merge or release. */
const TEMP_FORCE_FULL_PLANNER = true;

type GeoSqlPlanContext = {
    scope: GeoQueryScope;
    reference: GeoReference;
    referenceSource: string;
    coverageMentions: string[];
    propertyKeys: string[];
    profileValues: ReturnType<typeof collectProfileAttributeValues>;
};

type GeoSqlPlan =
    | {
          type: "query";
          distributionIndex: number;
          sqlQuery: string;
          placeName?: string;
          countrycodes?: string;
          context: GeoSqlPlanContext;
      }
    | {
          type: "not_applicable";
          reason: string;
      };

function pushGeoUserMessage(input: ChainInput, msg: string) {
    input.queue.push(createChatEventMessageCompleteMsg(msg));
}

function pushGeoRunLog(input: ChainInput, msg: string) {
    input.queue.push(createChatEventRunLogMsg(msg, "System Logs"));
}

function formatFinalGeoSqlMessage(sql: string): string {
    return `Final GeoSQL executed:\n\`\`\`sql\n${sql}\n\`\`\``;
}

function formatGeoSqlLog(label: string, sql: string): string {
    return `${label}:\n\`\`\`sql\n${sql}\n\`\`\``;
}

function normalizeRefPointToken(sql: string): string {
    return sql
        .replace(/\b_{0,2}REF_POINT_{2,}(?:geom|geometry)\b/gi, "__REF_POINT__")
        .replace(/\b_{0,2}REF_POINT_(?:geom|geometry)\b/gi, "__REF_POINT__")
        .replace(
            /(^|[^A-Za-z0-9_])_{0,2}REF_POINT_{0,2}(?=$|[^A-Za-z0-9_])/gi,
            "$1__REF_POINT__"
        )
        .replace(
            /ST_SetSRID\s*\(\s*ST_MakePoint\s*\(\s*__REF_POINT__\s*\.\s*(?:lon|lng|x)\s*,\s*__REF_POINT__\s*\.\s*(?:lat|y)\s*\)\s*,\s*4326\s*\)/gi,
            "__REF_POINT__"
        )
        .replace(
            /ST_MakePoint\s*\(\s*__REF_POINT__\s*\.\s*(?:lon|lng|x)\s*,\s*__REF_POINT__\s*\.\s*(?:lat|y)\s*\)/gi,
            "__REF_POINT__"
        )
        .replace(
            /__REF_POINT__\s*\.\s*(?:lon|lng|lat|x|y|geom|geometry)\b/gi,
            "__REF_POINT__"
        );
}

function sanitizeCandidatePlaceName(placeName?: string): string | undefined {
    const value = (placeName || "").trim();
    if (!value) {
        return undefined;
    }
    const lowered = value.toLowerCase();
    if (
        [
            "none",
            "null",
            "n/a",
            "na",
            "unknown",
            "undefined",
            "nil",
            "-",
            "--"
        ].includes(lowered)
    ) {
        return undefined;
    }
    return value;
}

function hasRefPointToken(sql: string): boolean {
    return /(^|[^A-Za-z0-9_])__REF_POINT__(?=$|[^A-Za-z0-9_])/i.test(sql);
}

function formatGeoReferenceForPlanner(reference: GeoReference | undefined) {
    if (!reference || reference.type === "none") {
        return "none";
    }
    if (reference.type === "internal") {
        return `internal key=${reference.key}, value=${reference.value}`;
    }
    return `external place=${reference.place}`;
}

function buildSpatialInstructionFromPlan(
    taskSpec: GeoQueryTaskSpec,
    scope: GeoQueryScope
): string {
    const spatial = taskSpec.plan.spatial;
    if (spatial.mode === "NONE") {
        return "No forced spatial operator family (plan spatial.mode=NONE).";
    }
    const lines: string[] = [
        "[CRITICAL SPATIAL INSTRUCTION — from execution plan]"
    ];
    lines.push(`spatial.mode=${spatial.mode}`);
    if (spatial.operator_family_hint) {
        lines.push(`- Operator family: ${spatial.operator_family_hint}`);
    }
    if (spatial.mode === "DISTANCE_BUFFER") {
        const meters = spatial.parameters?.distance_meters;
        lines.push(
            `- Use ST_DWithin(...) for buffer/distance filtering${
                meters ? ` with distance=${meters} meters` : ""
            }.`
        );
    } else if (spatial.mode === "NEAREST_K") {
        const k = spatial.parameters?.k ?? 1;
        lines.push(
            "- Use KNN nearest-neighbor ordering: ORDER BY geom <-> target_geom."
        );
        lines.push(`- MUST include LIMIT ${k}.`);
    } else if (spatial.mode === "TOPOLOGY") {
        lines.push(
            "- Use topological predicates: ST_Intersects / ST_Contains / ST_Within as appropriate."
        );
    } else if (spatial.mode === "MEASURE") {
        lines.push(
            "- Use SUM/AVG/MIN/MAX on ST_Area / ST_Length / ST_Perimeter per plan operations — never COUNT(*)."
        );
    } else if (spatial.mode === "GEOM_PREDICATE") {
        lines.push(
            "- WHERE must use geometry predicates: ST_IsValid / ST_Length / ST_Perimeter / ST_Area / NOT ST_IsValid as in the question."
        );
    }
    const anchor = scope.spatialIntent.anchor;
    if (anchor?.type === "internal_feature") {
        lines.push(
            `- Anchor "${anchor.value}" is internal; use CTE/subquery from features, not external geocoding.`
        );
    } else if (anchor?.type === "external_poi") {
        lines.push(
            `- Anchor "${anchor.value}" is external; resolve as placeName and use __REF_POINT__.`
        );
    }
    return lines.join("\n");
}

function buildPlanContractInstruction(
    scope: GeoQueryScope,
    taskSpec: GeoQueryTaskSpec,
    question: string
): string {
    const p = taskSpec.plan;
    const lines: string[] = [
        "[CRITICAL PLAN CONTRACT]",
        `target_pattern=${p.target_pattern}`,
        `spatial.mode=${p.spatial.mode}`,
        `operations=${p.operations.map((o) => o.operator).join("; ")}`
    ];
    if (p.target_pattern === "MEASUREMENT") {
        lines.push(
            "- MEASUREMENT: use SUM/AVG/MIN/MAX on ST_Area/ST_Length/ST_Perimeter (or property aggregate from operations).",
            "- Do NOT use COUNT(*) or COUNT(*) WHERE TRUE as the answer."
        );
    }
    if (
        p.target_pattern === "AGGREGATE_GROUP_BY" &&
        p.spatial.mode === "NONE"
    ) {
        lines.push(
            "- Attribute-only GROUP BY: use bound filters and GROUP BY keys; do NOT add ST_Within/ST_Intersects unless spatial.mode changes."
        );
    }
    if (p.target_pattern === "LIST_ROWS") {
        const limit = extractListRowLimitFromQuestion(question);
        lines.push(
            "- LIST_ROWS: SELECT multiple columns (id + properties + optional ST_AsText(geom)).",
            limit
                ? `- MUST include LIMIT ${limit}.`
                : "- MUST include LIMIT N (infer from question if numeric)."
        );
        if (
            /\b(sort|sorted|order|ascending|descending|highest|lowest|top|largest|smallest)\b/i.test(
                question
            )
        ) {
            lines.push("- Include ORDER BY when sort wording is present.");
        }
    }
    if (p.spatial.mode !== "NONE") {
        lines.push(buildSpatialInstructionFromPlan(taskSpec, scope));
    }
    return lines.join("\n");
}

function wantsCountContract(
    scope: GeoQueryScope,
    taskSpec?: GeoQueryTaskSpec
): boolean {
    const pattern = taskSpec?.plan.target_pattern;
    if (
        pattern === "AGGREGATE_GROUP_BY" ||
        pattern === "LIST_ROWS" ||
        pattern === "MEASUREMENT"
    ) {
        return false;
    }
    if (
        taskSpec?.plan.operations.some((o) =>
            /^(SUM|AVG|MIN|MAX)\(/i.test(o.operator)
        )
    ) {
        return false;
    }
    return (
        scope.intentType === "count" ||
        (!!taskSpec && taskSpec.answerShape === "count")
    );
}

function buildCountInstructionFromScope(
    scope: GeoQueryScope,
    taskSpec: GeoQueryTaskSpec
): string {
    if (!wantsCountContract(scope, taskSpec)) {
        return "No forced count contract.";
    }
    return [
        "[CRITICAL COUNT INSTRUCTION]",
        "- The user asks for a COUNT-style answer (scope and/or interpreted task).",
        "- SQL MUST return aggregated count (e.g. COUNT(*) AS total_count).",
        "- Do NOT return row-level listing unless user explicitly asks for details."
    ].join("\n");
}

function getMeasurementContractViolation(
    sql: string,
    taskSpec?: GeoQueryTaskSpec
): string | null {
    if (taskSpec?.plan.target_pattern !== "MEASUREMENT") {
        return null;
    }
    const query = sql || "";
    if (/\bcount\s*\(\s*\*\s*\)/i.test(query)) {
        return "MEASUREMENT plan forbids COUNT(*); use SUM/AVG/MIN/MAX on ST_Area/ST_Length/ST_Perimeter per operations";
    }
    const hasScalarAgg = /\b(sum|avg|min|max)\s*\(/i.test(query);
    const hasGeomFn = /st_(area|length|perimeter)\s*\(/i.test(query);
    const hasPropAgg = taskSpec.plan.operations.some((o) =>
        /^(SUM|AVG|MIN|MAX)\(/i.test(o.operator)
    );
    if (!hasScalarAgg && !hasGeomFn && !hasPropAgg) {
        return "MEASUREMENT query must include SUM/AVG/MIN/MAX(ST_Area|Length|Perimeter) or planned property aggregate";
    }
    return null;
}

function getGeomPredicateContractViolation(
    sql: string,
    taskSpec?: GeoQueryTaskSpec,
    question?: string
): string | null {
    const mode = taskSpec?.plan.spatial.mode;
    const pattern = taskSpec?.plan.target_pattern;
    const q = question || "";
    const needs =
        mode === "GEOM_PREDICATE" ||
        (pattern === "FILTER_COUNT" && questionImpliesGeomPredicateCount(q));
    if (!needs) {
        return null;
    }
    const query = sql || "";
    if (
        !/st_(isvalid|length|perimeter|area)\s*\(/i.test(query) &&
        !/not\s+st_isvalid\s*\(/i.test(query)
    ) {
        return "geom_predicate query must use ST_IsValid/ST_Length/ST_Perimeter/ST_Area in WHERE";
    }
    return null;
}

function getListRowsContractViolation(
    sql: string,
    taskSpec?: GeoQueryTaskSpec,
    question?: string
): string | null {
    if (taskSpec?.plan.target_pattern !== "LIST_ROWS") {
        return null;
    }
    const query = sql || "";
    if (!/\blimit\s+\d+\b/i.test(query)) {
        const expected = extractListRowLimitFromQuestion(question || "");
        return expected
            ? `LIST_ROWS query must include LIMIT ${expected}`
            : "LIST_ROWS query must include LIMIT";
    }
    if (
        /^\s*select\s+count\s*\(/i.test(query.replace(/\s+/g, " ").trim()) &&
        !/properties\s*->>/i.test(query)
    ) {
        return "LIST_ROWS must not be a scalar COUNT(*) query";
    }
    const selectBody = query.match(/select\s+([\s\S]+?)\s+from\s+features/i);
    if (selectBody) {
        const cols = selectBody[1]
            .split(",")
            .map((c) => c.trim())
            .filter((c) => c && !/^\*$/i.test(c));
        if (cols.length < 2) {
            return "LIST_ROWS should SELECT at least two columns (e.g. id and properties)";
        }
    }
    if (
        /\b(sort|sorted|order by|ascending|descending|highest|lowest|top|largest|smallest)\b/i.test(
            question || ""
        ) &&
        !/\border\s+by\b/i.test(query)
    ) {
        return "LIST_ROWS with sort wording must include ORDER BY";
    }
    return null;
}

function getSpatialContractViolation(
    sql: string,
    scope: GeoQueryScope,
    taskSpec?: GeoQueryTaskSpec,
    question?: string
): string | null {
    const q = question || "";
    const pattern = taskSpec?.plan.target_pattern;
    const spatialMode = taskSpec?.plan.spatial.mode ?? "NONE";
    const query = sql || "";

    const measurementViolation = getMeasurementContractViolation(sql, taskSpec);
    if (measurementViolation) {
        return measurementViolation;
    }

    const listViolation = getListRowsContractViolation(sql, taskSpec, q);
    if (listViolation) {
        return listViolation;
    }

    const geomViolation = getGeomPredicateContractViolation(sql, taskSpec, q);
    if (geomViolation) {
        return geomViolation;
    }

    if (pattern === "AGGREGATE_GROUP_BY" && spatialMode === "NONE") {
        return null;
    }
    if (pattern === "LIST_ROWS" && spatialMode === "NONE") {
        return null;
    }
    if (spatialMode === "NONE") {
        return null;
    }

    if (spatialMode === "DISTANCE_BUFFER") {
        if (!/st_dwithin\s*\(/i.test(query)) {
            return "distance_buffer query must use ST_DWithin(...)";
        }
        return null;
    }
    if (spatialMode === "NEAREST_K") {
        if (!/order\s+by[\s\S]{0,200}<->/i.test(query)) {
            return "nearest_neighbor query must use ORDER BY ... <-> ...";
        }
        if (!/\blimit\s+\d+\b/i.test(query)) {
            return "nearest_neighbor query must include LIMIT";
        }
        const expectedLimit = taskSpec?.plan.spatial.parameters?.k;
        if (expectedLimit) {
            const match = query.match(/\blimit\s+(\d+)\b/i);
            const actual = match?.[1] ? Number(match[1]) : undefined;
            if (actual && actual !== expectedLimit) {
                return `nearest_neighbor query LIMIT should be ${expectedLimit}`;
            }
        }
        return null;
    }
    if (spatialMode === "TOPOLOGY") {
        if (!/st_(intersects|contains|within)\s*\(/i.test(query)) {
            return "topological query must use ST_Intersects/ST_Contains/ST_Within";
        }
        return null;
    }
    if (spatialMode === "MEASURE") {
        if (
            !/st_(area|length|perimeter)\s*\(/i.test(query) &&
            !/\b(sum|avg|min|max)\s*\(/i.test(query)
        ) {
            return "measurement query must use ST_Area/ST_Length/ST_Perimeter with SUM/AVG/MIN/MAX";
        }
        return null;
    }

    if (
        questionImpliesPropertyAttributeAggregate(q) &&
        pattern === "FILTER_COUNT"
    ) {
        return null;
    }
    return null;
}

function getCountContractViolation(
    sql: string,
    scope: GeoQueryScope,
    taskSpec?: GeoQueryTaskSpec
): string | null {
    if (!wantsCountContract(scope, taskSpec)) {
        return null;
    }
    if (!/count\s*\(/i.test(sql || "")) {
        return "count intent query must include COUNT(...) aggregation";
    }
    return null;
}

const SCHEMA_KEY_BUDGET = 15;

function rankPropertyKeysForQuestion(
    allKeys: string[],
    question: string,
    boundFilters: { key: string }[]
): string[] {
    if (allKeys.length <= SCHEMA_KEY_BUDGET) {
        return allKeys;
    }
    const qTokens = question
        .toLowerCase()
        .split(/[^a-z0-9\u4e00-\u9fff]+/)
        .filter((t) => t.length >= 2);

    const scores = new Map<string, number>();
    for (const key of allKeys) {
        let score = 0;
        const kLow = key.toLowerCase();
        if (boundFilters.some((f) => f.key === key)) {
            score += 100;
        }
        for (const tok of qTokens) {
            if (kLow.includes(tok) || tok.includes(kLow)) {
                score += 50;
            }
        }
        if (
            /^(name|id|type|status|class|suburb|city|state|region|category)$/i.test(
                key
            )
        ) {
            score += 10;
        }
        scores.set(key, score);
    }
    const sorted = [...allKeys].sort(
        (a, b) => (scores.get(b) || 0) - (scores.get(a) || 0)
    );
    return sorted.slice(0, SCHEMA_KEY_BUDGET);
}

function pruneSchemaYaml(yaml: string, relevantKeys: Set<string>): string {
    const lines = yaml.split("\n");
    const result: string[] = [];
    let insideKeys = false;
    let currentKeyRelevant = true;
    let skippedCount = 0;
    for (const line of lines) {
        if (/^\s+keys:\s*$/.test(line)) {
            insideKeys = true;
            result.push(line);
            continue;
        }
        if (insideKeys) {
            const keyMatch = line.match(/^\s{4}(\S+):\s*$/);
            if (keyMatch) {
                const keyName = keyMatch[1];
                currentKeyRelevant = relevantKeys.has(keyName);
                if (currentKeyRelevant) {
                    result.push(line);
                } else {
                    skippedCount++;
                }
                continue;
            }
            const isSubField = /^\s{6}\S/.test(line);
            if (isSubField) {
                if (currentKeyRelevant) {
                    result.push(line);
                }
                continue;
            }
            insideKeys = false;
            currentKeyRelevant = true;
            if (skippedCount > 0) {
                result.push(
                    `    # ...${skippedCount} more field(s) omitted for brevity`
                );
                skippedCount = 0;
            }
        }
        result.push(line);
    }
    if (insideKeys && skippedCount > 0) {
        result.push(
            `    # ...${skippedCount} more field(s) omitted for brevity`
        );
    }
    return result.join("\n");
}

function getPlannerPropertyKeys(input: ChainInput): string[] {
    const keys = new Set<string>();
    input.keyContextData?.datasetProfile?.spatial?.items?.forEach((item) => {
        item.propertyKeys?.forEach((key) => {
            if (key?.trim()) {
                keys.add(key.trim());
            }
        });
    });
    return [...keys];
}

async function generateGeoDatasetIntro(
    input: ChainInput,
    introContext: string | null
): Promise<string | null> {
    if (!introContext) {
        return null;
    }
    try {
        const engine = await input.model.getEngine();
        console.log("[generateGeoDatasetIntro] resetChat before intro LLM…");
        await webLlmResetChat(engine);
        console.log("[generateGeoDatasetIntro] resetChat done.");
        const reply = await webLlmChatCompletion(engine, {
            messages: [
                {
                    role: "system",
                    content:
                        "You are Magda, a helpful data assistant. Write a short, natural introduction for the current spatial dataset before running GeoSQL. " +
                        "Use the same language as the user where possible. Do not use YAML-style labels, markdown fences, or mention internal schema binding. " +
                        "Summarise what the dataset appears to contain and suggest the kinds of geo questions the user can ask."
                },
                {
                    role: "user",
                    content:
                        `User request:\n${input.question}\n\n` +
                        `Spatial dataset context:\n${introContext}`
                }
            ]
        });
        if (reply?.usage) {
            pushGeoRunLog(
                input,
                `Intro LLM usage: prompt=${reply.usage.prompt_tokens} completion=${reply.usage.completion_tokens} total=${reply.usage.total_tokens} tokens.`
            );
        }
        const text = reply?.choices?.[0]?.message?.content?.trim();
        return text || null;
    } catch {
        return null;
    }
}

export async function planGeoSqlQuery(
    this: ChainInput,
    dists: { idx: number; dist: ParsedDistribution }[],
    metadataBrief?: string,
    fileDescItems?: string[]
): Promise<GeoSqlPlan> {
    const engine = await this.model.getEngine();
    console.log("[planGeoSqlQuery] calling engine.resetChat() before planner…");
    await webLlmResetChat(engine);
    console.log("[planGeoSqlQuery] engine.resetChat() completed.");
    const distList = dists
        .map((item) => `${item.idx}: ${item.dist.title} (${item.dist.format})`)
        .join("\n");
    const plannerSystemInstruction = [
        "## Role",
        "You are a GeoSQL **executor**. Upstream task-spec has already fixed intent (target_pattern, bindings, spatial mode). Your job is ONLY to emit JSON with executable `sqlQuery` for table `features`.",
        "",
        "## Database (CRITICAL)",
        "- Table: `features` only (`id`, `geom` SRID 4326, `properties` JSONB). Never invent table names.",
        "- Business fields: `properties->>'key'` only; keys must appear in the execution plan bindings or schema YAML.",
        "- Do not re-classify the question (e.g. do not turn AGGREGATE_GROUP_BY / LIST_ROWS into scalar COUNT).",
        "",
        "## Implement the execution plan",
        "- Follow `target_pattern`, `operations`, `spatial`, `output_columns`, and `draft_sql_sketch` in the USER message JSON.",
        "- Use operators listed in `operations` (e.g. COUNT(*), COUNT(DISTINCT …), ST_Perimeter, ST_Length, ST_Area, GROUP BY keys from bindings).",
        "- Polygon/MultiPolygon perimeter: prefer ST_Perimeter(geom::geography) in meters; do not use ST_Length for closed polygon boundaries unless the question asks for a polyline length.",
        "- If `spatial.needs_external_geocode` is true, set `placeName` and use `__REF_POINT__` in sqlQuery; for internal anchors use CTE/subquery per reference note, not invented coordinates.",
        "- LIST_ROWS / multi-row answers: include needed columns; optional `ST_AsText(geom) AS geom_wkt` for map preview.",
        "- LIST_ROWS: always include LIMIT; add ORDER BY when the question implies sorting.",
        "- MEASUREMENT: implement `operations` with SUM/AVG/MIN/MAX on ST_Area/ST_Length/ST_Perimeter (or property aggregate). Never use COUNT(*) for MEASUREMENT.",
        "- AGGREGATE_GROUP_BY with spatial.mode NONE: attribute filters + GROUP BY only; do not add ST_Within/ST_Intersects.",
        "",
        "## Output",
        "Return **ONLY** raw JSON (no markdown).",
        '{"type":"query","distributionIndex":<int>,"sqlQuery":"<SELECT or WITH...SELECT>","placeName":"<optional>","countrycodes":"<optional>"}',
        "If the plan cannot be implemented without changing target_pattern or inventing keys:",
        '{"type":"not_applicable","reason":"<cite plan field>"}'
    ].join("\n");
    const plannerPropertyKeys = getPlannerPropertyKeys(this);
    if (plannerPropertyKeys.length) {
        pushGeoRunLog(
            this,
            `Sample attribute keys in properties (JSON) injected into planner context: ${plannerPropertyKeys.join(
                ", "
            )}`
        );
    }
    const scope = extractGeoQueryScope({
        question: this.question,
        propertyKeys: plannerPropertyKeys,
        valueSamplesByKey: collectValueSamplesByKey(
            this.keyContextData?.datasetProfile
        ),
        datasetScopeTerms: buildCoverageTerms(
            this.keyContextData?.datasetProfile
        )
    });
    const coverageAndReference = resolveGeoReferenceForQuery(
        this,
        plannerPropertyKeys
    );
    if (coverageAndReference.coverageMentions.length) {
        pushGeoRunLog(
            this,
            `Detected dataset scope mentions: ${coverageAndReference.coverageMentions.join(
                ", "
            )}.`
        );
    }
    if (scope.boundFilters.length) {
        pushGeoRunLog(
            this,
            `Scope extractor bound filters: ${scope.boundFilters
                .map((f) => `${f.key}=${f.value}`)
                .join(", ")}.`
        );
    }
    pushGeoRunLog(
        this,
        `Reference resolution: ${
            coverageAndReference.source
        }; ${formatGeoReferenceForPlanner(coverageAndReference.reference)}.`
    );
    const taskSpec = await resolveGeoQueryTaskSpec({
        question: this.question,
        scope,
        propertyKeys: plannerPropertyKeys,
        getEngine: () => this.model.getEngine()
    });
    (this as ChainInput & {
        __geoQueryTaskSpec?: GeoQueryTaskSpec;
    }).__geoQueryTaskSpec = taskSpec;
    pushGeoRunLog(
        this,
        `Interpreted executable query problem (${
            taskSpec.source
        }):\n${formatTaskSpecForPlanner(taskSpec)}`
    );
    const profileValues = collectProfileAttributeValues(
        this.keyContextData?.datasetProfile
    );
    const planContext: GeoSqlPlanContext = {
        scope,
        reference: coverageAndReference.reference,
        referenceSource: coverageAndReference.source,
        coverageMentions: coverageAndReference.coverageMentions,
        propertyKeys: plannerPropertyKeys,
        profileValues
    };
    const relevantKeys = rankPropertyKeysForQuestion(
        plannerPropertyKeys,
        this.question,
        scope.boundFilters
    );
    const plannerSchemaKeys = new Set(relevantKeys);
    for (const b of taskSpec.plan.bindings) {
        plannerSchemaKeys.add(b.physical_key);
    }
    const prunedFileDescItems = fileDescItems?.length
        ? fileDescItems.map((yaml) => pruneSchemaYaml(yaml, plannerSchemaKeys))
        : undefined;
    if (plannerPropertyKeys.length > plannerSchemaKeys.size) {
        pushGeoRunLog(
            this,
            `Planner schema pruned to plan/bindings: ${
                plannerSchemaKeys.size
            }/${plannerPropertyKeys.length} keys (${[...plannerSchemaKeys].join(
                ", "
            )}).`
        );
    }

    const skipDeterministicRenderer =
        TEMP_FORCE_FULL_PLANNER ||
        !!(this as ChainInput & {
            __geoEvalDisableDeterministicRenderer?: boolean;
        }).__geoEvalDisableDeterministicRenderer;
    if (skipDeterministicRenderer) {
        pushGeoRunLog(
            this,
            TEMP_FORCE_FULL_PLANNER
                ? "TEMP: full-planner mode (deterministic SQL renderer disabled); using Planner LLM for every case."
                : "Eval mode: deterministic SQL renderer disabled; using Planner LLM for every case."
        );
    }

    if (!skipDeterministicRenderer) {
        if (shouldUseDeterministicRenderer(taskSpec, this.question)) {
            const ast = astFromTaskSpec(
                taskSpec,
                this.question,
                plannerPropertyKeys
            );
            const deterministicSql = ast ? renderSqlFromAst(ast) : null;
            if (deterministicSql) {
                pushGeoRunLog(
                    this,
                    `Deterministic SQL renderer (${taskSpec.plan.target_pattern}): skipping Planner LLM.`
                );
                (this as ChainInput & {
                    __geoDeterministicSql?: boolean;
                }).__geoDeterministicSql = true;
                const distIdx = dists[0]?.idx ?? 0;
                return {
                    type: "query",
                    distributionIndex: distIdx,
                    sqlQuery: deterministicSql,
                    context: planContext
                };
            }
            pushGeoRunLog(
                this,
                `Deterministic renderer skipped for ${taskSpec.plan.target_pattern} (AST/SQL not built).`
            );
        }

        const spatialSql = tryRenderSpatialSql(
            this.question,
            taskSpec,
            plannerPropertyKeys
        );
        if (spatialSql) {
            pushGeoRunLog(
                this,
                `Spatial deterministic SQL renderer: skipping Planner LLM.`
            );
            (this as ChainInput & {
                __geoDeterministicSql?: boolean;
            }).__geoDeterministicSql = true;
            const distIdx = dists[0]?.idx ?? 0;
            return {
                type: "query",
                distributionIndex: distIdx,
                sqlQuery: spatialSql,
                context: planContext
            };
        }
    }

    const executionPlanJson = formatTaskSpecExecutionPlanForPlanner(taskSpec);
    const geoRef = coverageAndReference.reference;
    const referenceNote = formatGeoReferenceForPlanner(geoRef);
    const externalPlace = geoRef.type === "external" ? geoRef.place.trim() : "";
    const needsExternalPlace =
        taskSpec.plan.spatial.needs_external_geocode && !!externalPlace;
    const plannerUserPrompt = [
        "## Authoritative execution plan (JSON — do not change target_pattern)",
        executionPlanJson,
        "",
        "## User question (wording only; intent is already in the plan above)",
        this.question,
        "",
        "## Spatial distributions (pick distributionIndex)",
        distList,
        "",
        "## Reference (apply only as required by plan.spatial)",
        `source: ${coverageAndReference.source}`,
        referenceNote,
        needsExternalPlace
            ? `If plan requires geocode: set placeName to "${externalPlace}" and use __REF_POINT__ in sqlQuery.`
            : "No external placeName unless plan.spatial.needs_external_geocode is true.",
        "",
        "## Schema samples (binding keys only — do not invent other properties keys)",
        prunedFileDescItems?.length
            ? prunedFileDescItems.join("\n---\n")
            : "N/A"
    ].join("\n");

    pushGeoRunLog(
        this,
        "Planner executor mode: slim prompt (plan JSON + binding-key schema only; no duplicate scope/count instructions)."
    );
    const systemTokenEst = Math.ceil(plannerSystemInstruction.length / 3.5);
    const userTokenEst = Math.ceil(plannerUserPrompt.length / 3.5);
    const totalTokenEst = systemTokenEst + userTokenEst;
    pushGeoRunLog(
        this,
        `Calling WebLLM for GeoSQL JSON plan (non-streaming; ~${totalTokenEst} prompt tokens estimated)…`
    );
    const PLANNER_TIMEOUT_MS = 5 * 60 * 1000;
    let reply: Awaited<ReturnType<typeof webLlmChatCompletion>> | null = null;
    try {
        reply = await Promise.race([
            webLlmChatCompletion(engine, {
                messages: [
                    {
                        role: "system",
                        content: plannerSystemInstruction
                    },
                    {
                        role: "user",
                        content: plannerUserPrompt
                    }
                ]
            }),
            new Promise<never>((_, reject) =>
                setTimeout(
                    () =>
                        reject(
                            new Error(
                                `WebLLM planner timed out after ${
                                    PLANNER_TIMEOUT_MS / 1000
                                }s (prompt ~${totalTokenEst} tokens).`
                            )
                        ),
                    PLANNER_TIMEOUT_MS
                )
            )
        ]);
    } catch (e) {
        pushGeoRunLog(this, `Planner LLM call failed: ${String(e)}`);
        return {
            type: "not_applicable" as const,
            reason: `Planner LLM error: ${String(e)}`
        };
    }
    const usage = reply?.usage;
    if (usage) {
        pushGeoRunLog(
            this,
            `Planner LLM usage: prompt=${usage.prompt_tokens} completion=${usage.completion_tokens} total=${usage.total_tokens} tokens.`
        );
    }
    const raw = reply?.choices?.[0]?.message?.content?.trim();
    if (!raw) {
        pushGeoRunLog(this, "Planner rejected: empty LLM reply.");
        return {
            type: "not_applicable",
            reason: "Planner did not return any result."
        };
    }
    try {
        const parsed = JSON.parse(raw) as Partial<GeoSqlPlan>;
        if (
            parsed?.type === "query" &&
            typeof (parsed as any).distributionIndex === "number" &&
            typeof (parsed as any).sqlQuery === "string" &&
            (parsed as any).sqlQuery.trim()
        ) {
            return {
                type: "query",
                distributionIndex: (parsed as any).distributionIndex,
                sqlQuery: (parsed as any).sqlQuery,
                placeName:
                    typeof (parsed as any).placeName === "string"
                        ? (parsed as any).placeName
                        : undefined,
                countrycodes:
                    typeof (parsed as any).countrycodes === "string"
                        ? (parsed as any).countrycodes
                        : undefined,
                context: planContext
            };
        }
        if (
            parsed?.type === "not_applicable" &&
            typeof (parsed as any).reason === "string"
        ) {
            pushGeoRunLog(this, `Planner rejected: ${(parsed as any).reason}`);
            return {
                type: "not_applicable",
                reason: (parsed as any).reason
            };
        }
    } catch {
        // Fall through to safe not-applicable path.
    }
    pushGeoRunLog(
        this,
        "Planner rejected: invalid JSON (expected query or not_applicable)."
    );
    return {
        type: "not_applicable",
        reason:
            "Planner returned invalid JSON. Please ask a more specific spatial question."
    };
}

function hasProximityIntent(question: string): boolean {
    const text = (question || "").toLowerCase();
    return (
        /(附近|周边|最近|最近的|离.+最近)/.test(question) ||
        /\b(near|nearby|nearest|closest|distance)\b/.test(text)
    );
}

function inferPlaceNameFromQuestion(question: string): string | null {
    const q = (question || "").trim();
    if (!q) {
        return null;
    }
    // Chinese style: "<place>附近/周边/附近的..."
    const zhMatch = q.match(
        /在?(?:当前数据集下，?)?(.+?)(?:附近|周边|附近的|最近的)/
    );
    if (zhMatch?.[1]) {
        const place = zhMatch[1].trim().replace(/[，。！？?]+$/g, "");
        if (place && place.length >= 2) {
            return place;
        }
    }
    // English style: "near <place>" / "closest to <place>"
    const enMatch = q.match(
        /\b(?:near|nearby to|closest to|nearest to)\s+(.+?)$/i
    );
    if (enMatch?.[1]) {
        const place = enMatch[1].trim().replace(/[.,!?]+$/g, "");
        if (place && place.length >= 2) {
            return place;
        }
    }
    return null;
}

function normalizeFreeText(input: string): string {
    return (input || "").toLowerCase().replace(/\s+/g, " ").trim();
}

function hasExplicitReferenceAnchorCue(question: string): boolean {
    const q = normalizeFreeText(question);
    if (!q) {
        return false;
    }
    return (
        /(附近|周边|最近|最近的|距离|离.+(近|远)|周围|半径|范围内|以.+为中心)/.test(
            question
        ) ||
        /\b(near|nearby|nearest|closest|distance|within|radius|around|from)\b/i.test(
            q
        )
    );
}

function isLikelyDatasetScopePlace(
    placeName: string,
    datasetProfile?: DatasetProfile
): boolean {
    const place = normalizeFreeText(placeName);
    if (!place || place.length < 3 || !datasetProfile) {
        return false;
    }
    const contextTexts = [
        datasetProfile.datasetTitle || "",
        datasetProfile.datasetDescription || "",
        ...(datasetProfile.datasetTags || []),
        ...(datasetProfile.datasetThemes || [])
    ]
        .map(normalizeFreeText)
        .filter((txt) => !!txt);
    if (!contextTexts.length) {
        return false;
    }
    return contextTexts.some(
        (txt) => txt.includes(place) || place.includes(txt)
    );
}

function inferTopNFromQuestion(question: string, defaultValue = 5): number {
    const q = (question || "").toLowerCase();
    const numMatch = q.match(/(\d+)\s*(个|条|个公园|places|items)?/i);
    if (numMatch?.[1]) {
        const n = Number(numMatch[1]);
        if (Number.isInteger(n) && n > 0 && n <= 50) {
            return n;
        }
    }
    if (/五个|5个|top\s*5|five/.test(q)) return 5;
    if (/三个|3个|top\s*3|three/.test(q)) return 3;
    if (/十个|10个|top\s*10|ten/.test(q)) return 10;
    return defaultValue;
}

function inferReferenceFeatureIdFromQuestion(question: string): number | null {
    const match = (question || "").match(
        /\b(?:id|ID)\s*(?:=|为|是|:)?\s*(\d+)\b/
    );
    if (!match?.[1]) {
        return null;
    }
    const id = Number(match[1]);
    return Number.isInteger(id) && id > 0 ? id : null;
}

type ReferenceFeatureFilter = {
    label: string;
    whereSql: string;
    excludeSql: string;
    localId?: number;
};

function escapeRegExp(input: string): string {
    return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function quoteSqlLiteral(input: string): string {
    return `'${input.replace(/'/g, "''")}'`;
}

function inferValueForPropertyKey(
    question: string,
    key: string
): string | null {
    const keyPattern = escapeRegExp(key);
    const patterns = [
        new RegExp(
            `\\b${keyPattern}\\b\\s*(?:=|:|is|equals|为|是)\\s*["']?([^"',，。;；?？]+)`,
            "i"
        ),
        new RegExp(`\\b${keyPattern}\\b\\s+["']?([^"',，。;；?？]+)`, "i")
    ];
    for (const pattern of patterns) {
        const match = question.match(pattern);
        const value = match?.[1]?.trim();
        if (value) {
            return value.replace(/["']$/g, "").trim();
        }
    }
    return null;
}

function inferReferenceFeatureFilterFromQuestion(
    question: string,
    propKeys?: string[] | null
): ReferenceFeatureFilter | null {
    const localId = inferReferenceFeatureIdFromQuestion(question);
    if (localId) {
        return {
            label: `features.id=${localId}`,
            whereSql: `id = ${localId}`,
            excludeSql: `f.id <> ${localId}`,
            localId
        };
    }

    for (const key of propKeys || []) {
        const value = inferValueForPropertyKey(question, key);
        if (!value) {
            continue;
        }
        const literal = quoteSqlLiteral(value);
        return {
            label: `properties->>'${key}' = ${literal}`,
            whereSql: `properties->>'${key}' = ${literal}`,
            excludeSql: `COALESCE(f.properties->>'${key}', '') <> ${literal}`
        };
    }
    return null;
}

function buildReferenceFeatureFilterFromParser(
    reference: GeoReference | undefined,
    propKeys?: string[] | null
): ReferenceFeatureFilter | null {
    if (reference?.type !== "internal") {
        return null;
    }
    if (!(propKeys || []).includes(reference.key) || !reference.value.trim()) {
        return null;
    }
    const literal = quoteSqlLiteral(reference.value.trim());
    return {
        label: `properties->>'${reference.key}' = ${literal}`,
        whereSql: `properties->>'${reference.key}' = ${literal}`,
        excludeSql: `COALESCE(f.properties->>'${reference.key}', '') <> ${literal}`
    };
}

function getParserReference(input: ChainInput): GeoReference | undefined {
    return (input as ChainInput & { __geoIntent?: SpatialIntentResult })
        .__geoIntent?.reference;
}

function buildCoverageTerms(datasetProfile?: DatasetProfile): string[] {
    if (!datasetProfile) {
        return [];
    }
    const raw = [
        datasetProfile.datasetTitle || "",
        datasetProfile.datasetDescription || "",
        ...(datasetProfile.datasetTags || []),
        ...(datasetProfile.datasetThemes || [])
    ]
        .join(" ")
        .toLowerCase();
    if (!raw.trim()) {
        return [];
    }
    const terms = raw
        .split(/[^a-z0-9\u4e00-\u9fff]+/g)
        .map((item) => item.trim())
        .filter((item) => item.length >= 2);
    return [...new Set(terms)];
}

function detectCoverageMentions(
    question: string,
    datasetProfile?: DatasetProfile
): string[] {
    const q = normalizeFreeText(question);
    if (!q) {
        return [];
    }
    const terms = buildCoverageTerms(datasetProfile);
    if (!terms.length) {
        return [];
    }
    return terms.filter((term) => q.includes(term)).slice(0, 12);
}

function collectValueSamplesByKey(
    datasetProfile?: DatasetProfile
): Record<
    string,
    {
        mode: "full" | "partial";
        values: string[];
        approxDistinct?: number;
    }
> {
    const result: Record<
        string,
        {
            mode: "full" | "partial";
            values: string[];
            approxDistinct?: number;
        }
    > = {};
    datasetProfile?.spatial?.items?.forEach((item) => {
        Object.entries(item.valueSamples || {}).forEach(([key, profile]) => {
            if (!profile?.values?.length) {
                return;
            }
            if (
                !result[key] ||
                (result[key].mode === "partial" && profile.mode === "full")
            ) {
                result[key] = {
                    mode: profile.mode,
                    values: profile.values,
                    approxDistinct: profile.approxDistinct
                };
            }
        });
    });
    return result;
}

function collectProfileAttributeValues(
    datasetProfile?: DatasetProfile
): {
    enumValues: Set<string>;
    sampleRowValues: Set<string>;
} {
    const enumValues = new Set<string>();
    const sampleRowValues = new Set<string>();
    datasetProfile?.spatial?.items?.forEach((item) => {
        Object.values(item.valueSamples || {}).forEach((valueProfile) => {
            (valueProfile?.values || []).forEach((value) => {
                const norm = normalizeFreeText(String(value));
                if (norm.length >= 2 && norm.length <= 120) {
                    enumValues.add(norm);
                }
            });
        });
        (item.sampleRows || []).forEach((row) => {
            Object.values(row || {}).forEach((value) => {
                if (value === null || typeof value === "undefined") {
                    return;
                }
                const norm = normalizeFreeText(String(value));
                if (norm.length >= 2 && norm.length <= 120) {
                    sampleRowValues.add(norm);
                }
            });
        });
    });
    return { enumValues, sampleRowValues };
}

function isLikelyAttributeValueReference(
    candidate: string,
    profileValues: ReturnType<typeof collectProfileAttributeValues>
): boolean {
    const place = normalizeFreeText(candidate);
    const enumValues = profileValues.enumValues;
    const sampleRowValues = profileValues.sampleRowValues;
    if (
        !place ||
        place.length < 2 ||
        (!enumValues.size && !sampleRowValues.size)
    ) {
        return false;
    }
    // Highest priority: sampled enum/top values from valueSamples.
    if (enumValues.has(place)) {
        return true;
    }
    for (const sample of enumValues) {
        if (sample.length < 3) {
            continue;
        }
        if (
            place === sample ||
            place.includes(sample) ||
            sample.includes(place)
        ) {
            return true;
        }
    }
    // Fallback: sample rows may be noisy/partial, so only exact match.
    if (sampleRowValues.has(place)) {
        return true;
    }
    return false;
}

function extractInternalReferenceFromQuestion(
    question: string,
    propKeys?: string[] | null
): GeoReference | null {
    for (const key of propKeys || []) {
        const value = inferValueForPropertyKey(question, key);
        if (value) {
            return {
                type: "internal",
                key,
                value
            };
        }
    }
    return null;
}

function resolveGeoReferenceForQuery(
    input: ChainInput,
    propKeys?: string[] | null
): { reference: GeoReference; source: string; coverageMentions: string[] } {
    const datasetProfile = input.keyContextData?.datasetProfile;
    const parserReference = getParserReference(input);
    const coverageMentions = detectCoverageMentions(
        input.question,
        datasetProfile
    );
    const anchorCue = hasExplicitReferenceAnchorCue(input.question);
    const profileValues = collectProfileAttributeValues(datasetProfile);

    const internalFromQuestion = extractInternalReferenceFromQuestion(
        input.question,
        propKeys
    );
    if (internalFromQuestion) {
        return {
            reference: internalFromQuestion,
            source: "question_internal",
            coverageMentions
        };
    }

    const inferredPlace = inferPlaceNameFromQuestion(input.question);
    if (
        inferredPlace &&
        anchorCue &&
        !isLikelyDatasetScopePlace(inferredPlace, datasetProfile) &&
        !isLikelyAttributeValueReference(inferredPlace, profileValues)
    ) {
        return {
            reference: { type: "external", place: inferredPlace },
            source: "question_external",
            coverageMentions
        };
    }

    if (parserReference?.type === "internal") {
        const validKey = (propKeys || []).includes(parserReference.key);
        if (validKey && parserReference.value.trim()) {
            return {
                reference: parserReference,
                source: "parser_internal",
                coverageMentions
            };
        }
    }
    if (parserReference?.type === "external") {
        const parserPlace = parserReference.place.trim();
        if (
            parserPlace &&
            anchorCue &&
            !isLikelyDatasetScopePlace(parserPlace, datasetProfile) &&
            !isLikelyAttributeValueReference(parserPlace, profileValues)
        ) {
            return {
                reference: { type: "external", place: parserPlace },
                source: "parser_external",
                coverageMentions
            };
        }
    }

    return {
        reference: { type: "none" },
        source: "none",
        coverageMentions
    };
}

function buildReferenceOutputColumns(propKeys?: string[] | null): string {
    const selected = chooseCoreDisplayKeys(propKeys, 4);
    return selected.length
        ? selected
              .map((key) => `  ${formatGeoSqlPropertyProjection(key, "f")},`)
              .join("\n")
        : "";
}

function buildNearestToReferenceFeatureSql(
    question: string,
    filter: ReferenceFeatureFilter,
    propKeys?: string[] | null
): string {
    const limit = inferTopNFromQuestion(question, 10);
    return `WITH target AS (
  SELECT geom
  FROM features
  WHERE ${filter.whereSql}
  LIMIT 1
)
SELECT
  f.id,
${buildReferenceOutputColumns(propKeys)}
  ST_Distance(f.geom::geography, target.geom::geography) AS distance_m,
  ST_AsText(f.geom) AS geom_wkt
FROM features f
CROSS JOIN target
WHERE ${filter.excludeSql}
  AND f.geom IS NOT NULL
ORDER BY f.geom <-> target.geom
LIMIT ${limit}`;
}

function extractReferencedJsonbKeys(sql: string): string[] {
    const keys = new Set<string>();
    const regex = /properties\s*->>?\s*'([^']+)'/gi;
    let match: RegExpExecArray | null = null;
    while ((match = regex.exec(sql)) !== null) {
        if (match[1]?.trim()) {
            keys.add(match[1].trim());
        }
    }
    return [...keys];
}

function isLikelyHexWkbText(value: string): boolean {
    const txt = value.trim();
    if (!txt) {
        return false;
    }
    return (
        /^\\x[0-9a-f]+$/i.test(txt) ||
        (/^[0-9a-f]+$/i.test(txt) && txt.length > 24 && txt.length % 2 === 0)
    );
}

/** Map-only geometry columns: kept in queryResult, omitted from chat markdown table. */
function isChatTableHiddenColumn(key: string): boolean {
    return /^(geom_wkt|geom_geojson)$/i.test(key.trim());
}

function formatRecordValueForDisplay(key: string, value: unknown): string {
    if (value === null || typeof value === "undefined") {
        return "";
    }
    const keyLower = key.toLowerCase();
    const isGeomLikeKey =
        keyLower === "geom" ||
        keyLower.includes("geometry") ||
        keyLower.includes("geojson");

    if (typeof value === "string") {
        const txt = value.trim();
        if (isGeomLikeKey && isLikelyHexWkbText(txt)) {
            return "[Geometry binary omitted; use ST_AsText(geom) AS geom_wkt or ST_AsGeoJSON(geom) AS geom_geojson]";
        }
        return txt;
    }

    if (typeof value === "object") {
        if (isGeomLikeKey) {
            const maybeGeoJson = value as Record<string, unknown>;
            const type = maybeGeoJson?.type;
            if (typeof type === "string") {
                const coords = maybeGeoJson?.coordinates;
                return `GeoJSON ${type}: ${JSON.stringify(coords)}`;
            }
            return `Geometry object: ${JSON.stringify(value)}`;
        }
        return JSON.stringify(value);
    }

    return `${value}`;
}

export async function queryGeoSpatialWithSQLQuery(
    this: ChainInput,
    distributionIndex: number,
    sqlQuery: string,
    placeName?: string,
    countrycodes?: string,
    planCtx?: GeoSqlPlanContext
) {
    this.keyContextData.queryResult = undefined;

    (this as any).__geoEvalExecutedSqlFirst = undefined;
    (this as any).__geoEvalExecutedSqlFinal = undefined;
    (this as any).__geoEvalSanitizerFixes = undefined;

    const ctx = (this as any).__geoDistItems as
        | { idx: number; dist: ParsedDistribution }[]
        | undefined;
    const metadataBrief = (this as any).__geoMetadataBrief as
        | string
        | undefined;
    const fileDescItems = (this as any).__geoFileDescItems as
        | string[]
        | undefined;
    const schemaContext = fileDescItems?.length
        ? fileDescItems.join("\n---\n")
        : undefined;
    const profilePropertyKeysByIdx = (this as any)
        .__geoProfilePropertyKeysByIdx as Record<number, string[]> | undefined;
    if (!ctx?.length) {
        pushGeoUserMessage(
            this,
            "GeoSQL tool is not configured for this page."
        );
        return null;
    }

    const validIdxList = ctx.map((x) => x.idx);
    const hasExplicitIndex =
        typeof distributionIndex === "number" &&
        Number.isInteger(distributionIndex);
    const targetIdx =
        hasExplicitIndex && distributionIndex >= 0
            ? distributionIndex
            : validIdxList.length === 1
            ? validIdxList[0]
            : Number.NaN;
    const item = ctx.find((x) => x.idx === targetIdx);
    if (!item || !Number.isInteger(targetIdx) || targetIdx < 0) {
        const allowed = ctx.map((x) => x.idx).join(", ");
        pushGeoUserMessage(
            this,
            `Invalid distributionIndex ${distributionIndex}. Use one of the listed spatial file ids: ${allowed}.`
        );
        return null;
    }
    if (!hasExplicitIndex && validIdxList.length === 1) {
        pushGeoRunLog(
            this,
            `distributionIndex not provided; auto-selected the only available spatial file id: ${targetIdx}.`
        );
    }

    const { dist } = item;
    const targetUrl = getDistributionUrl(dist);
    if (!targetUrl) {
        pushGeoUserMessage(
            this,
            "The selected distribution has no download/access URL."
        );
        return null;
    }

    const evalSkipImport = !!(this as any).__geoEvalSkipImport;
    const maxFeat = (this as any).__geoEvalMaxImportFeatures as
        | number
        | undefined;
    const requiredLimit =
        typeof maxFeat === "number"
            ? maxFeat
            : DEFAULT_SPATIAL_IMPORT_FEATURE_LIMIT;
    const loaded = getLoadedDistribution();
    const alreadyLoaded =
        !evalSkipImport &&
        loaded &&
        loaded.inserted > 0 &&
        loaded.maxFeatures >= requiredLimit;

    pushGeoUserMessage(
        this,
        `Preparing a spatial query for "${dist.title}"...`
    );

    let insertedFeatureCount: number | null = null;
    if (evalSkipImport) {
        pushGeoRunLog(
            this,
            `Eval mode: using existing PostGIS \`features\` table (skip re-import for "${dist.title}").`
        );
        try {
            const cntRows = await runPostgisQuery(
                `SELECT COUNT(*)::int AS c FROM features`
            );
            insertedFeatureCount = cntRows[0]?.c ?? 0;
        } catch (e) {
            pushGeoUserMessage(
                this,
                `Failed to read PostGIS feature count: ${String(e)}`
            );
            return null;
        }
    } else if (alreadyLoaded) {
        insertedFeatureCount = loaded.inserted;
        pushGeoRunLog(
            this,
            `Reusing already-loaded "${dist.title}" (${insertedFeatureCount} features, imported during profile stage).`
        );
    } else {
        pushGeoRunLog(
            this,
            `Importing spatial data for "${dist.title}" into PostGIS (PGlite).`
        );
        try {
            const importResult = await importSpatialFromDistribution(
                targetUrl,
                dist.format,
                dist.title,
                typeof maxFeat === "number"
                    ? { maxFeatures: maxFeat }
                    : undefined
            );
            insertedFeatureCount = importResult.inserted;
            if (importResult.truncated) {
                pushGeoRunLog(this, formatImportSpatialResult(importResult));
            }
        } catch (e) {
            pushGeoUserMessage(
                this,
                `Failed to import spatial data: ${String(e)}`
            );
            return null;
        }
    }

    const propKeys =
        planCtx?.propertyKeys ??
        (await (async () => {
            const fromProfile =
                typeof targetIdx === "number" && Number.isInteger(targetIdx)
                    ? profilePropertyKeysByIdx?.[targetIdx]
                    : undefined;
            return fromProfile?.length
                ? fromProfile
                : await sampleGeoPropertyKeys();
        })());

    const scope =
        planCtx?.scope ??
        extractGeoQueryScope({
            question: this.question,
            propertyKeys: propKeys || [],
            valueSamplesByKey: collectValueSamplesByKey(
                this.keyContextData?.datasetProfile
            ),
            datasetScopeTerms: buildCoverageTerms(
                this.keyContextData?.datasetProfile
            )
        });
    const parserReference =
        planCtx?.reference ??
        resolveGeoReferenceForQuery(this, propKeys).reference;
    const profileValues =
        planCtx?.profileValues ??
        collectProfileAttributeValues(this.keyContextData?.datasetProfile);
    const taskSpecForContract =
        (this as ChainInput & { __geoQueryTaskSpec?: GeoQueryTaskSpec })
            .__geoQueryTaskSpec ??
        buildDeterministicTaskSpec(scope, this.question, propKeys || []);
    const parserPlaceName =
        parserReference.type === "external" && parserReference.place.trim()
            ? parserReference.place.trim()
            : undefined;
    const shouldIgnoreParserExternalPlace =
        !!parserPlaceName &&
        isLikelyDatasetScopePlace(
            parserPlaceName,
            this.keyContextData?.datasetProfile
        ) &&
        !hasExplicitReferenceAnchorCue(this.question);
    if (shouldIgnoreParserExternalPlace && parserPlaceName) {
        pushGeoRunLog(
            this,
            `Parser external reference "${parserPlaceName}" looks like dataset coverage context without explicit anchor intent; treating as non-reference.`
        );
    }
    const plannerPlaceName = sanitizeCandidatePlaceName(placeName);
    const shouldIgnorePlannerPlaceName =
        !!plannerPlaceName &&
        ((isLikelyDatasetScopePlace(
            plannerPlaceName,
            this.keyContextData?.datasetProfile
        ) &&
            !hasExplicitReferenceAnchorCue(this.question)) ||
            isLikelyAttributeValueReference(plannerPlaceName, profileValues));
    if (shouldIgnorePlannerPlaceName && plannerPlaceName) {
        pushGeoRunLog(
            this,
            `Planner place "${plannerPlaceName}" looks like dataset scope/attribute value; ignoring external geocode reference.`
        );
    }
    if (parserPlaceName) {
        pushGeoRunLog(
            this,
            `SQL planner used parser external reference context: "${parserPlaceName}".`
        );
    }
    let finalSqlQuery = normalizeRefPointToken(sqlQuery);
    if (finalSqlQuery !== sqlQuery) {
        pushGeoRunLog(
            this,
            "Normalized reference placeholder in planner GeoSQL to __REF_POINT__."
        );
    }
    pushGeoRunLog(
        this,
        formatGeoSqlLog("Planner generated GeoSQL", finalSqlQuery)
    );
    const proximityIntent = hasProximityIntent(this.question);
    const scopeReferenceFeatureFilter: ReferenceFeatureFilter | null =
        scope.boundFilters.length && proximityIntent
            ? {
                  label: `properties->>'${
                      scope.boundFilters[0].key
                  }' = ${quoteSqlLiteral(scope.boundFilters[0].value)}`,
                  whereSql: `properties->>'${
                      scope.boundFilters[0].key
                  }' = ${quoteSqlLiteral(scope.boundFilters[0].value)}`,
                  excludeSql: `COALESCE(f.properties->>'${
                      scope.boundFilters[0].key
                  }', '') <> ${quoteSqlLiteral(scope.boundFilters[0].value)}`
              }
            : null;
    const parserReferenceFeatureFilter = buildReferenceFeatureFilterFromParser(
        parserReference,
        propKeys
    );
    const referenceFeatureFilter =
        parserReferenceFeatureFilter ||
        scopeReferenceFeatureFilter ||
        inferReferenceFeatureFilterFromQuestion(this.question, propKeys);
    const alreadyCompleteSpatialSql = /\bST_DWithin\b|\bST_Distance\b|\bWITH\s+ref\b/i.test(
        finalSqlQuery
    );
    if (
        proximityIntent &&
        referenceFeatureFilter &&
        !alreadyCompleteSpatialSql
    ) {
        if (
            typeof insertedFeatureCount === "number" &&
            referenceFeatureFilter.localId &&
            referenceFeatureFilter.localId > insertedFeatureCount
        ) {
            pushGeoRunLog(
                this,
                `features.id is a browser-local serial id for the imported sample. Current imported id range is 1-${insertedFeatureCount}; requested id ${referenceFeatureFilter.localId} is outside that range.`
            );
            pushGeoUserMessage(
                this,
                `I can't find feature id ${referenceFeatureFilter.localId} in the current browser-loaded sample. The spatial import currently contains local feature ids 1-${insertedFeatureCount}.`
            );
            return null;
        }
        finalSqlQuery = buildNearestToReferenceFeatureSql(
            this.question,
            referenceFeatureFilter,
            propKeys
        );
        pushGeoRunLog(
            this,
            `${
                parserReferenceFeatureFilter ? "Parser detected" : "Detected"
            } dataset-field proximity request; using ${
                referenceFeatureFilter.label
            } as the reference geometry instead of place geocoding.`
        );
    }
    let effectivePlaceName = referenceFeatureFilter
        ? undefined
        : parserPlaceName && !shouldIgnoreParserExternalPlace
        ? parserPlaceName
        : plannerPlaceName && !shouldIgnorePlannerPlaceName
        ? plannerPlaceName
        : proximityIntent && scope.needsExternalReference
        ? inferPlaceNameFromQuestion(this.question) || undefined
        : undefined;
    effectivePlaceName = sanitizeCandidatePlaceName(effectivePlaceName);
    if (!parserPlaceName && !placeName && effectivePlaceName) {
        pushGeoRunLog(
            this,
            `Auto-inferred reference place from question: "${effectivePlaceName}".`
        );
    }

    let requiresRefPointToken = hasRefPointToken(finalSqlQuery);
    if (effectivePlaceName && requiresRefPointToken) {
        pushGeoRunLog(
            this,
            "Planner GeoSQL already uses __REF_POINT__; skipping reference rewrite."
        );
    }
    if (effectivePlaceName && !requiresRefPointToken) {
        const rewiredSql = await repairGeoSqlWithModel(
            this,
            finalSqlQuery,
            "An external reference place is available as __REF_POINT__. Rewrite the SQL to use __REF_POINT__ while preserving the user's requested spatial operation. Do not force a nearest-neighbor query unless the user asked for nearest/closest, and do not add dataset-specific category filters.",
            propKeys,
            metadataBrief,
            schemaContext
        );
        if (rewiredSql) {
            finalSqlQuery = normalizeRefPointToken(rewiredSql);
            requiresRefPointToken = hasRefPointToken(finalSqlQuery);
            pushGeoRunLog(
                this,
                formatGeoSqlLog(
                    "Rewrote GeoSQL to use __REF_POINT__",
                    finalSqlQuery
                )
            );
        }
    }
    if (effectivePlaceName && !requiresRefPointToken) {
        pushGeoRunLog(
            this,
            `Reference place "${effectivePlaceName}" was detected, but GeoSQL could not be rewritten to use __REF_POINT__ without changing the requested operation.`
        );
        pushGeoUserMessage(
            this,
            "I couldn't generate a valid GeoSQL query that uses the reference place while preserving your question. Please rephrase the spatial operation more explicitly."
        );
        return null;
    }

    if (effectivePlaceName && requiresRefPointToken) {
        const place = effectivePlaceName;
        const resolvedLonLat = await resolveReferencePoint(place, countrycodes);

        if (!resolvedLonLat) {
            pushGeoUserMessage(
                this,
                `Failed to resolve reference place "${place}" from current dataset and Nominatim.`
            );
            return null;
        }

        const refPointExpr = `ST_SetSRID(ST_MakePoint(${resolvedLonLat.lon}, ${resolvedLonLat.lat}), 4326)`;
        finalSqlQuery = finalSqlQuery.replace(/__REF_POINT__/gi, refPointExpr);
        pushGeoRunLog(
            this,
            `Resolved reference place "${place}" from ${resolvedLonLat.source}: (${resolvedLonLat.lon}, ${resolvedLonLat.lat}). Substituted __REF_POINT__ before execution.`
        );
    } else if (effectivePlaceName && !requiresRefPointToken) {
        pushGeoRunLog(
            this,
            `Ignored placeName "${effectivePlaceName}" because SQL does not use __REF_POINT__.`
        );
    }

    let spatialContractViolation = getSpatialContractViolation(
        finalSqlQuery,
        scope,
        taskSpecForContract,
        this.question
    );
    if (spatialContractViolation) {
        const planFallback = buildSqlFromExecutionPlan(
            taskSpecForContract,
            this.question,
            propKeys || []
        );
        if (planFallback) {
            finalSqlQuery = normalizeRefPointToken(planFallback);
            pushGeoRunLog(
                this,
                formatGeoSqlLog(
                    "GeoSQL from deterministic plan fallback",
                    finalSqlQuery
                )
            );
            spatialContractViolation = getSpatialContractViolation(
                finalSqlQuery,
                scope,
                taskSpecForContract,
                this.question
            );
        }
    }
    const usedDeterministicSql = !!(this as ChainInput & {
        __geoDeterministicSql?: boolean;
    }).__geoDeterministicSql;
    if (spatialContractViolation && !usedDeterministicSql) {
        pushGeoRunLog(
            this,
            `Spatial contract violation before execution: ${spatialContractViolation}. Attempting contract-aware rewrite.`
        );
        const contractRepaired = await repairGeoSqlWithModel(
            this,
            finalSqlQuery,
            `${buildPlanContractInstruction(
                scope,
                taskSpecForContract,
                this.question
            )}\n\n[NON-NEGOTIABLE]\n- Rewrite SQL to satisfy target_pattern, spatial.mode, and operations from the plan.\n- Keep all existing bound attribute filters.\n- Return SQL only.`,
            propKeys,
            metadataBrief,
            schemaContext
        );
        if (contractRepaired) {
            finalSqlQuery = normalizeRefPointToken(contractRepaired);
            pushGeoRunLog(
                this,
                formatGeoSqlLog(
                    "GeoSQL after spatial-contract rewrite",
                    finalSqlQuery
                )
            );
            spatialContractViolation = getSpatialContractViolation(
                finalSqlQuery,
                scope,
                taskSpecForContract,
                this.question
            );
        }
    }
    if (spatialContractViolation) {
        pushGeoUserMessage(
            this,
            `Unable to build SQL that satisfies required spatial intent: ${spatialContractViolation}. Please rephrase with explicit distance/nearest/intersection wording.`
        );
        return null;
    }
    let countContractViolation = getCountContractViolation(
        finalSqlQuery,
        scope,
        taskSpecForContract
    );
    if (countContractViolation) {
        pushGeoRunLog(
            this,
            `Count contract violation before execution: ${countContractViolation}. Attempting count-aware rewrite.`
        );
        const countRepaired = await repairGeoSqlWithModel(
            this,
            finalSqlQuery,
            `${buildCountInstructionFromScope(
                scope,
                taskSpecForContract
            )}\n\n[NON-NEGOTIABLE]\n- Rewrite SQL into a COUNT aggregation answer.\n- Keep all existing bound filters.\n- Return SQL only.`,
            propKeys,
            metadataBrief,
            schemaContext
        );
        if (countRepaired) {
            finalSqlQuery = normalizeRefPointToken(countRepaired);
            pushGeoRunLog(
                this,
                formatGeoSqlLog(
                    "GeoSQL after count-contract rewrite",
                    finalSqlQuery
                )
            );
            countContractViolation = getCountContractViolation(
                finalSqlQuery,
                scope,
                taskSpecForContract
            );
        }
    }
    if (countContractViolation) {
        pushGeoUserMessage(
            this,
            `Unable to build SQL that satisfies count intent: ${countContractViolation}. Please rephrase your counting condition.`
        );
        return null;
    }

    const sanitized = sanitizeGeoSql(finalSqlQuery, propKeys);
    finalSqlQuery = sanitized.query;
    (this as any).__geoEvalSanitizerFixes = sanitized.fixes;
    if (sanitized.fixes.length) {
        pushGeoRunLog(
            this,
            "GeoSQL self-check applied automatic fixes:\n- " +
                sanitized.fixes.join("\n- ")
        );
        pushGeoRunLog(
            this,
            formatGeoSqlLog("GeoSQL after self-check", finalSqlQuery)
        );
    }

    if (propKeys?.length) {
        const referencedKeys = extractReferencedJsonbKeys(finalSqlQuery);
        const allowed = new Set(propKeys);
        const unknownKeys = referencedKeys.filter((k) => !allowed.has(k));
        if (unknownKeys.length) {
            pushGeoUserMessage(
                this,
                `No suitable fields found for: ${unknownKeys.join(
                    ", "
                )}. Please use existing fields only: ${propKeys.join(", ")}`
            );
            return null;
        }
    }
    let records: Record<string, any>[] | null = null;
    let sqlToRun = finalSqlQuery;
    const maxAttempts = 2;
    let failureFromPreflight = false;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            if (attempt === 1) {
                (this as any).__geoEvalExecutedSqlFirst = sqlToRun;
                if (this.geoEvalCaptureExecutedSql) {
                    this.evalCapturedExecutedSqlFirst = sqlToRun;
                }
                // Preflight parse to catch syntax errors before first execution.
                try {
                    await runPostgisQuery(`EXPLAIN ${sqlToRun}`);
                } catch (e) {
                    failureFromPreflight = true;
                    throw e;
                }
            }
            failureFromPreflight = false;
            pushGeoRunLog(
                this,
                formatGeoSqlLog(`Executing GeoSQL attempt ${attempt}`, sqlToRun)
            );
            records = await runPostgisQuery(sqlToRun);
            (this as any).__geoEvalExecutedSqlFinal = sqlToRun;
            if (this.geoEvalCaptureExecutedSql) {
                this.evalCapturedExecutedSql = sqlToRun;
                const fx = (this as any).__geoEvalSanitizerFixes;
                this.evalCapturedSanitizerFixes = Array.isArray(fx)
                    ? fx
                    : undefined;
            }
            break;
        } catch (e) {
            const errText = String(e);
            const suggestion = getGeoSqlErrorSuggestion(errText);
            if (attempt >= maxAttempts) {
                pushGeoRunLog(
                    this,
                    `GeoSQL execution failed: ${errText}${
                        suggestion ? `\n${suggestion}` : ""
                    }`
                );
                pushGeoUserMessage(
                    this,
                    "GeoSQL execution failed. Open System Logs for technical details."
                );
                return null;
            }

            pushGeoRunLog(
                this,
                `${
                    failureFromPreflight
                        ? "GeoSQL preflight syntax check failed"
                        : "GeoSQL execution failed"
                } on attempt ${attempt}: ${errText}${
                    suggestion ? `\n${suggestion}` : ""
                }\nStarting one self-correction retry...`
            );

            const repairedByModel = await repairGeoSqlWithModel(
                this,
                sqlToRun,
                errText,
                propKeys,
                metadataBrief,
                schemaContext
            );
            if (!repairedByModel) {
                pushGeoRunLog(
                    this,
                    "Self-correction retry could not generate a valid SQL fix."
                );
                pushGeoUserMessage(
                    this,
                    "GeoSQL self-correction could not generate a valid SQL fix."
                );
                return null;
            }
            const repairedSanitized = sanitizeGeoSql(repairedByModel, propKeys);
            sqlToRun = repairedSanitized.query;
            pushGeoRunLog(
                this,
                "Retrying with auto-corrected GeoSQL:\n```sql\n" +
                    sqlToRun +
                    "\n```" +
                    (repairedSanitized.fixes.length
                        ? "\nAdditional self-check fixes:\n- " +
                          repairedSanitized.fixes.join("\n- ")
                        : "")
            );
        }
    }

    if (!records?.length) {
        pushGeoUserMessage(
            this,
            "The query returned no rows. Try relaxing filters or check SRID/units (e.g. use geography for meter distances)."
        );
        return null;
    }

    pushGeoUserMessage(this, formatFinalGeoSqlMessage(sqlToRun));
    this.keyContextData.queryResult = records;
    const tableHeaders = Object.keys(records[0]).filter(
        (key) => !isChatTableHiddenColumn(key)
    );
    const table = markdownTable([
        tableHeaders,
        ...records.map((item) =>
            tableHeaders.map((key) =>
                formatRecordValueForDisplay(key, item[key])
            )
        )
    ]);
    return `Query returned ${records.length} row(s).\n\n${table}`;
}

export async function createQueryGeoDatasetTool(
    input: ChainInput
): Promise<WebLLMTool | null> {
    if (!config.enablePglitePostgis) {
        return null;
    }

    const { dataset, distribution } = input;
    const distributions = distribution?.identifier
        ? [distribution]
        : dataset?.distributions?.length
        ? dataset.distributions
        : [];
    if (!distributions?.length) {
        return null;
    }

    const dists = distributions
        .map((dist, idx) => ({
            idx,
            dist
        }))
        .filter((item) => {
            if (!getDistributionUrl(item.dist)) {
                return false;
            }
            return isGeoSpatialDistribution(item.dist);
        });

    if (!dists.length) {
        return null;
    }

    const spatialProfileItems =
        input.keyContextData?.datasetProfile?.spatial?.items;
    const distTitleList = dists
        .map((item) => {
            const profile = spatialProfileItems?.find(
                (x) => x.distributionIndex === item.idx
            );
            const geomHint =
                profile?.geometryTypes?.length &&
                profile.geometryTypes.length > 0
                    ? ` geom=${profile.geometryTypes
                          .map((x) => `${x.type}:${x.count}`)
                          .join(", ")}`
                    : "";
            const keyHint =
                profile?.propertyKeys?.length && profile.propertyKeys.length > 0
                    ? ` keys=${profile.propertyKeys.slice(0, 10).join(", ")}`
                    : "";
            return `- ${item.dist.title}${
                geomHint || keyHint
                    ? ` (${[geomHint, keyHint]
                          .filter((x) => !!x)
                          .join("; ")
                          .trim()})`
                    : ""
            }`;
        })
        .join("\n");

    async function queryGeoDataset(this: ChainInput) {
        pushGeoUserMessage(
            this,
            "Preparing a spatial dataset query with GeoSQL..."
        );
        pushGeoRunLog(
            this,
            "Spatial (GeoSQL) data files are available on this dataset page. Preparing PostGIS tools."
        );
        (this as ChainInput & {
            __geoDistItems?: typeof dists;
            __geoMetadataBrief?: string;
            __geoProfilePropertyKeysByIdx?: Record<number, string[]>;
        }).__geoDistItems = dists;
        const propertyKeysByIdx = (spatialProfileItems || []).reduce(
            (acc, item) => {
                if (item?.propertyKeys?.length) {
                    acc[item.distributionIndex] = item.propertyKeys;
                }
                return acc;
            },
            {} as Record<number, string[]>
        );
        (this as ChainInput & {
            __geoProfilePropertyKeysByIdx?: Record<number, string[]>;
        }).__geoProfilePropertyKeysByIdx = propertyKeysByIdx;
        const prepared = await buildGeoFileDescriptionsAndIntro(
            dists,
            dataset,
            spatialProfileItems,
            this.geoEvalCaptureExecutedSql
                ? { skipSpatialImportForSample: true }
                : undefined
        );
        (this as ChainInput & {
            __geoMetadataBrief?: string;
        }).__geoMetadataBrief = prepared.metadataBrief;
        (this as ChainInput & {
            __geoFileDescItems?: string[];
        }).__geoFileDescItems = prepared.fileDescItems;
        const introKey =
            this.keyContextData?.datasetProfileVersionKey ||
            dataset?.identifier ||
            "__default__";
        const introShownKey = (this as ChainInput & {
            __geoIntroShownKey?: string;
        }).__geoIntroShownKey;
        if (introShownKey !== introKey && !this.geoEvalCaptureExecutedSql) {
            const generatedIntro = await generateGeoDatasetIntro(
                this,
                prepared.introContext
            );
            if (generatedIntro) {
                pushGeoUserMessage(this, generatedIntro);
                (this as ChainInput & {
                    __geoIntroShownKey?: string;
                }).__geoIntroShownKey = introKey;
            }
        }
        try {
            const plan = await planGeoSqlQuery.call(
                this,
                dists,
                prepared.metadataBrief,
                prepared.fileDescItems
            );
            if (plan.type === "not_applicable") {
                return `The current request does not require GeoSQL analysis: ${plan.reason}`;
            }
            const value = await queryGeoSpatialWithSQLQuery.call(
                this,
                plan.distributionIndex,
                plan.sqlQuery,
                plan.placeName,
                plan.countrycodes,
                plan.context
            );
            if (typeof value === "undefined" || value === null) {
                return;
            }
            return `${value}`;
        } catch (e) {
            this.queue.push(createChatEventMessageErrorMsg(e as Error));
            return;
        }
    }

    return {
        name: "queryGeoDataset",
        func: queryGeoDataset,
        description:
            "Answer using PostGIS (PGlite) GeoSQL on spatial distributions of the current dataset page. " +
            "Use this when the user asks map/location/distance/buffer/area/geometry questions and a spatial file below is relevant:\n" +
            distTitleList
    };
}
