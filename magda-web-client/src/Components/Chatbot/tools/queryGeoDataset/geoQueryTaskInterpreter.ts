import type { ServiceWorkerMLCEngine } from "@mlc-ai/web-llm/lib/extension_service_worker";
import type { GeoQueryScope } from "./scopeExtractor";

/** High-level SQL intent — drives contracts and planner hints. */
export type ExecutionTargetPattern =
    | "FILTER_COUNT"
    | "LIST_ROWS"
    | "AGGREGATE_GROUP_BY"
    | "SPATIAL_FILTER"
    | "SPATIAL_NEAREST"
    | "SPATIAL_TOPOLOGY"
    | "MEASUREMENT"
    | "MIXED"
    | "UNKNOWN";

export type ColumnBindingRole = "FILTER" | "GROUP_BY" | "SELECT" | "ORDER_BY";

/**
 * Every business attribute must use JSONB access on `features.properties`.
 * physical_key MUST be one of the keys in `properties_schema.keys`.
 */
export type SchemaColumnBinding = {
    logical_term?: string;
    physical_key: string;
    sql_access: string;
    role: ColumnBindingRole;
    filter_literal?: string;
    source: "bound_filter" | "inferred_group_by" | "llm_suggested";
    confidence?: number;
};

export type PlanOperation = {
    label: string;
    operator: string;
    alias: string;
};

export type SpatialConstraintSummary = {
    mode:
        | "NONE"
        | "DISTANCE_BUFFER"
        | "NEAREST_K"
        | "TOPOLOGY"
        | "MEASURE"
        | "VIEWPORT";
    operator_family_hint?: string;
    parameters?: Record<string, number | string>;
    anchor_hint?: string;
    needs_external_geocode: boolean;
    external_place?: string;
};

export type SchemaLinkedExecutionPlan = {
    schema_table: "features";
    target_pattern: ExecutionTargetPattern;
    /** Intent guardrail for result shape — not a SQL type, a planner contract. */
    answer_shape_guardrail: string;
    bindings: SchemaColumnBinding[];
    operations: PlanOperation[];
    spatial: SpatialConstraintSummary;
    output_columns: string[];
    logic_trace: string[];
    /** Pseudocode only; real SQL must use `features` and JSONB access. */
    draft_sql_sketch: string;
};

export type GeoQueryAnswerShape =
    | "count"
    | "list_rows"
    | "aggregate"
    | "spatial_relation"
    | "mixed"
    | "unknown";

export type GeoQueryTaskSpec = {
    plan: SchemaLinkedExecutionPlan;
    answerShape: GeoQueryAnswerShape;
    source: "deterministic" | "merged";
};

type LlmPlanPatch = {
    target_pattern?: ExecutionTargetPattern;
    group_by_keys?: string[];
    logic_trace?: string;
    /** Optional extra bindings — keys MUST exist in propertyKeys (validated). */
    extra_bindings?: Array<{
        physical_key: string;
        role: ColumnBindingRole;
        logical_term?: string;
    }>;
};

function sqlAccessForPropertyKey(key: string): string {
    const k = key.replace(/'/g, "''");
    return `properties->>'${k}'`;
}

function normToken(s: string): string {
    return (s || "").toLowerCase().replace(/\s+/g, " ").trim();
}

function answerShapeFromPattern(
    p: ExecutionTargetPattern
): GeoQueryAnswerShape {
    switch (p) {
        case "FILTER_COUNT":
            return "count";
        case "LIST_ROWS":
            return "list_rows";
        case "AGGREGATE_GROUP_BY":
            return "aggregate";
        case "SPATIAL_FILTER":
        case "SPATIAL_NEAREST":
        case "SPATIAL_TOPOLOGY":
        case "MEASUREMENT":
            return "spatial_relation";
        case "MIXED":
            return "mixed";
        default:
            return "unknown";
    }
}

/** Pick schema key whose normalized form best matches a natural-language hint. */
export function matchPropertyKeyFromHint(
    hint: string,
    propertyKeys: string[]
): string | undefined {
    const h = normToken(hint).replace(/[^a-z0-9\u4e00-\u9fff]+/g, "");
    if (!h || h.length < 2) {
        return undefined;
    }
    let best: { key: string; score: number } | undefined;
    for (const key of propertyKeys) {
        const kn = normToken(key).replace(/[^a-z0-9\u4e00-\u9fff]+/g, "");
        if (!kn) {
            continue;
        }
        let score = 0;
        if (kn === h) {
            score = 100;
        } else if (kn.includes(h) || h.includes(kn)) {
            score = 60;
        } else if (h.length >= 4 && kn.includes(h.slice(0, 4))) {
            score = 40;
        }
        if (score > 0 && (!best || score > best.score)) {
            best = { key, score };
        }
    }
    return best && best.score >= 40 ? best.key : undefined;
}

function inferGroupByKeysFromQuestion(
    question: string,
    propertyKeys: string[]
): string[] {
    const q = question || "";
    const keys = new Set<string>();

    const patterns: RegExp[] = [
        /\b(?:group\s+by|grouped\s+by)\s+([a-z0-9_]+)\b/i,
        /\b(?:per|by|each|for\s+each)\s+([a-z0-9_\s]{2,40}?)(?:\s*[,.?]|$)/i,
        /\b(?:in\s+each)\s+([a-z0-9_\s]{2,40}?)(?:\s*[,.?]|$)/i,
        /(?:按|每个|各(?:个)?|每一(?:个)?)([^\s，。]{2,24}?)(?:的|统计|分组|计算|数量)/u
    ];
    for (const re of patterns) {
        const m = q.match(re);
        const raw = m?.[1]?.trim();
        if (!raw) {
            continue;
        }
        const matched = matchPropertyKeyFromHint(raw, propertyKeys);
        if (matched) {
            keys.add(matched);
        }
    }
    return [...keys].slice(0, 6);
}

function resolveTargetPattern(
    scope: GeoQueryScope,
    question: string,
    groupByKeys: string[]
): ExecutionTargetPattern {
    const si = scope.spatialIntent;
    if (si.type === "measurement") {
        return "MEASUREMENT";
    }
    if (si.type === "nearest_neighbor") {
        return "SPATIAL_NEAREST";
    }
    if (si.type === "distance_buffer" || si.type === "topological") {
        return si.type === "topological"
            ? "SPATIAL_TOPOLOGY"
            : "SPATIAL_FILTER";
    }

    if (scope.intentType === "aggregate" || groupByKeys.length > 0) {
        return "AGGREGATE_GROUP_BY";
    }
    if (scope.intentType === "count") {
        return "FILTER_COUNT";
    }
    if (scope.intentType === "list") {
        return "LIST_ROWS";
    }
    if (scope.intentType === "spatial") {
        return "SPATIAL_FILTER";
    }

    if (/(how many|number of|count|多少|几个|几条|总数)/i.test(question)) {
        return "FILTER_COUNT";
    }
    if (/(group\s*by|per\b|each\b|按|每个|各)/i.test(question)) {
        return "AGGREGATE_GROUP_BY";
    }
    return "UNKNOWN";
}

function buildSpatialSummary(scope: GeoQueryScope): SpatialConstraintSummary {
    const si = scope.spatialIntent;
    if (si.type === "none") {
        return {
            mode: "NONE",
            needs_external_geocode: !!scope.needsExternalReference,
            external_place: scope.externalPlace
        };
    }
    if (si.type === "distance_buffer") {
        return {
            mode: "DISTANCE_BUFFER",
            operator_family_hint: "ST_DWithin",
            parameters: si.parameters?.distance_meters
                ? { distance_meters: si.parameters.distance_meters }
                : undefined,
            anchor_hint: si.anchor?.value,
            needs_external_geocode: !!scope.needsExternalReference,
            external_place: scope.externalPlace
        };
    }
    if (si.type === "nearest_neighbor") {
        return {
            mode: "NEAREST_K",
            operator_family_hint: "KNN_ORDER_BY_<->",
            parameters: si.parameters?.limit
                ? { k: si.parameters.limit }
                : { k: 1 },
            anchor_hint: si.anchor?.value,
            needs_external_geocode: !!scope.needsExternalReference,
            external_place: scope.externalPlace
        };
    }
    if (si.type === "topological") {
        return {
            mode: "TOPOLOGY",
            operator_family_hint:
                (si.operatorFamily || []).join(" | ") || "ST_Intersects",
            anchor_hint: si.anchor?.value,
            needs_external_geocode: !!scope.needsExternalReference,
            external_place: scope.externalPlace
        };
    }
    if (si.type === "measurement") {
        return {
            mode: "MEASURE",
            operator_family_hint:
                (si.operatorFamily || []).join(" | ") || "ST_Area",
            anchor_hint: si.anchor?.value,
            needs_external_geocode: false
        };
    }
    return {
        mode: "NONE",
        needs_external_geocode: !!scope.needsExternalReference,
        external_place: scope.externalPlace
    };
}

function buildBindings(
    scope: GeoQueryScope,
    propertyKeys: string[],
    inferredGroupKeys: string[]
): SchemaColumnBinding[] {
    const list: SchemaColumnBinding[] = [];
    const usedKeys = new Set<string>();

    for (const f of scope.boundFilters) {
        if (!propertyKeys.includes(f.key)) {
            continue;
        }
        list.push({
            logical_term: f.value,
            physical_key: f.key,
            sql_access: sqlAccessForPropertyKey(f.key),
            role: "FILTER",
            filter_literal: f.value,
            source: "bound_filter",
            confidence: f.confidence
        });
        usedKeys.add(f.key);
    }

    for (const gk of inferredGroupKeys) {
        if (!propertyKeys.includes(gk) || usedKeys.has(gk)) {
            continue;
        }
        list.push({
            logical_term: gk.replace(/_/g, " "),
            physical_key: gk,
            sql_access: sqlAccessForPropertyKey(gk),
            role: "GROUP_BY",
            source: "inferred_group_by"
        });
        usedKeys.add(gk);
    }

    return list;
}

function buildOperations(
    pattern: ExecutionTargetPattern,
    groupByKeys: string[]
): PlanOperation[] {
    if (pattern === "FILTER_COUNT") {
        return [
            {
                label: "row_cardinality",
                operator: "COUNT(*)",
                alias: "total_count"
            }
        ];
    }
    if (pattern === "AGGREGATE_GROUP_BY") {
        return [
            {
                label: "rows_per_group",
                operator: "COUNT(*)",
                alias: "feature_count"
            }
        ];
    }
    if (pattern === "LIST_ROWS") {
        return [
            {
                label: "projection",
                operator: "SELECT",
                alias: "detail_rows"
            }
        ];
    }
    if (
        pattern === "SPATIAL_NEAREST" ||
        pattern === "SPATIAL_FILTER" ||
        pattern === "SPATIAL_TOPOLOGY"
    ) {
        return [
            {
                label: "spatial_predicate",
                operator: "FILTER_BY_GEOMETRY",
                alias: "spatial_match"
            }
        ];
    }
    if (pattern === "MEASUREMENT") {
        return [
            {
                label: "geom_metric",
                operator: "ST_Area|ST_Length",
                alias: "measure_value"
            }
        ];
    }
    return [
        {
            label: "primary",
            operator: "RESOLVE_FROM_USER_QUESTION",
            alias: "result"
        }
    ];
}

function buildOutputColumns(
    pattern: ExecutionTargetPattern,
    groupByKeys: string[],
    operations: PlanOperation[]
): string[] {
    if (pattern === "FILTER_COUNT") {
        return [operations[0]?.alias || "total_count"];
    }
    if (pattern === "AGGREGATE_GROUP_BY") {
        return [...groupByKeys, operations[0]?.alias || "feature_count"];
    }
    if (pattern === "LIST_ROWS") {
        return ["id", "geom_wkt", "…properties columns per planner…"];
    }
    return ["…per planner…"];
}

function buildAnswerShapeGuardrail(
    pattern: ExecutionTargetPattern,
    groupByKeys: string[],
    operations: PlanOperation[]
): string {
    if (pattern === "FILTER_COUNT") {
        return "SCALAR[number] — single numeric cell (one row, one measure column)";
    }
    if (pattern === "AGGREGATE_GROUP_BY") {
        const dims = groupByKeys.length || 1;
        return `TABLE[string${", string".repeat(
            Math.max(0, dims - 1)
        )}, number] — one row per group; last column is ${
            operations[0]?.operator
        } as ${operations[0]?.alias}`;
    }
    if (pattern === "LIST_ROWS") {
        return "TABLE[rows] — multiple feature rows; include ST_AsText(geom) AS geom_wkt";
    }
    if (
        pattern === "SPATIAL_FILTER" ||
        pattern === "SPATIAL_NEAREST" ||
        pattern === "SPATIAL_TOPOLOGY"
    ) {
        return "TABLE[rows] or SCALAR[number] if user asked only how many; MUST satisfy spatial contract below";
    }
    if (pattern === "MEASUREMENT") {
        return "SCALAR[number] or TABLE[id, measure] depending on question";
    }
    return "UNKNOWN — infer count vs list vs aggregate from user question; prefer COUNT(*) for how-many questions";
}

function buildDraftSqlSketch(
    pattern: ExecutionTargetPattern,
    bindings: SchemaColumnBinding[],
    operations: PlanOperation[],
    groupByKeys: string[]
): string {
    const filters = bindings.filter((b) => b.role === "FILTER");
    const whereClause =
        filters.length > 0
            ? filters
                  .map(
                      (b) =>
                          `${b.sql_access} = '${String(
                              b.filter_literal || ""
                          ).replace(/'/g, "''")}'`
                  )
                  .join(" AND ")
            : "TRUE";

    if (pattern === "FILTER_COUNT") {
        return `SELECT ${operations[0]?.operator} AS ${operations[0]?.alias} FROM features WHERE ${whereClause}`;
    }
    if (pattern === "AGGREGATE_GROUP_BY" && groupByKeys.length) {
        const dims = groupByKeys.map((k) => sqlAccessForPropertyKey(k));
        const dimSql = dims.join(", ");
        return `SELECT ${dimSql}, ${operations[0]?.operator} AS ${operations[0]?.alias} FROM features WHERE ${whereClause} GROUP BY ${dimSql}`;
    }
    if (pattern === "LIST_ROWS") {
        return `SELECT id, properties->>'…', ST_AsText(geom) AS geom_wkt FROM features WHERE ${whereClause} LIMIT …`;
    }
    return `-- Planner: expand using ONLY properties JSONB keys from schema; table = features`;
}

function buildLogicTraceLines(
    scope: GeoQueryScope,
    pattern: ExecutionTargetPattern,
    groupByKeys: string[],
    question: string
): string[] {
    const lines: string[] = [];
    lines.push(
        `scope.intentType=${scope.intentType}; spatial=${scope.spatialIntent.type}`
    );
    if (
        pattern === "FILTER_COUNT" &&
        /how many|number of|多少|几个/i.test(question)
    ) {
        lines.push("User cardinality wording → FILTER_COUNT + COUNT(*)");
    }
    if (pattern === "AGGREGATE_GROUP_BY" && groupByKeys.length) {
        lines.push(
            `Grouping dimension(s): ${groupByKeys.join(
                ", "
            )} — must appear in GROUP BY and SELECT`
        );
    }
    if (scope.boundFilters.length) {
        lines.push(
            `Bound filters from extractor: ${scope.boundFilters
                .map((b) => `${b.key}='${b.value}'`)
                .join("; ")}`
        );
    }
    return lines;
}

/**
 * Deterministic Schema-Linked Execution Plan from scope + schema keys.
 * Critical: physical_key values only come from `propertyKeys` (schema keys).
 */
export function buildSchemaLinkedExecutionPlan(input: {
    scope: GeoQueryScope;
    question: string;
    propertyKeys: string[];
}): SchemaLinkedExecutionPlan {
    const { scope, question, propertyKeys } = input;
    const groupByKeys = inferGroupByKeysFromQuestion(question, propertyKeys);
    let pattern = resolveTargetPattern(scope, question, groupByKeys);

    if (pattern === "AGGREGATE_GROUP_BY" && groupByKeys.length === 0) {
        pattern = "FILTER_COUNT";
    }
    if (
        pattern === "UNKNOWN" &&
        scope.intentType === "aggregate" &&
        groupByKeys.length === 0
    ) {
        pattern = "FILTER_COUNT";
    }

    const bindings = buildBindings(scope, propertyKeys, groupByKeys);
    const operations = buildOperations(pattern, groupByKeys);
    const spatial = buildSpatialSummary(scope);
    const output_columns = buildOutputColumns(pattern, groupByKeys, operations);
    const answer_shape_guardrail = buildAnswerShapeGuardrail(
        pattern,
        groupByKeys,
        operations
    );
    const draft_sql_sketch = buildDraftSqlSketch(
        pattern,
        bindings,
        operations,
        groupByKeys
    );
    const logic_trace = buildLogicTraceLines(
        scope,
        pattern,
        groupByKeys,
        question
    );

    return {
        schema_table: "features",
        target_pattern: pattern,
        answer_shape_guardrail,
        bindings,
        operations,
        spatial,
        output_columns,
        logic_trace,
        draft_sql_sketch
    };
}

export function buildDeterministicTaskSpec(
    scope: GeoQueryScope,
    question: string,
    propertyKeys: string[]
): GeoQueryTaskSpec {
    const plan = buildSchemaLinkedExecutionPlan({
        scope,
        question,
        propertyKeys
    });
    return {
        plan,
        answerShape: answerShapeFromPattern(plan.target_pattern),
        source: "deterministic"
    };
}

function parseLlmPlanPatch(raw: string): LlmPlanPatch | null {
    const text = (raw || "").trim();
    if (!text) {
        return null;
    }
    const jsonText = text.match(/\{[\s\S]*\}/)?.[0] || text;
    try {
        const parsed = JSON.parse(jsonText);
        return parsed && typeof parsed === "object" ? parsed : null;
    } catch {
        return null;
    }
}

function isExecutionTargetPattern(x: string): x is ExecutionTargetPattern {
    return [
        "FILTER_COUNT",
        "LIST_ROWS",
        "AGGREGATE_GROUP_BY",
        "SPATIAL_FILTER",
        "SPATIAL_NEAREST",
        "SPATIAL_TOPOLOGY",
        "MEASUREMENT",
        "MIXED",
        "UNKNOWN"
    ].includes(x);
}

function mergePlanWithLlmPatch(
    base: SchemaLinkedExecutionPlan,
    patch: LlmPlanPatch,
    propertyKeys: string[],
    scope: GeoQueryScope,
    question: string
): SchemaLinkedExecutionPlan {
    let pattern = base.target_pattern;
    if (
        patch.target_pattern &&
        isExecutionTargetPattern(patch.target_pattern)
    ) {
        pattern = patch.target_pattern;
    }

    const groupByKeys = (() => {
        if (Array.isArray(patch.group_by_keys)) {
            const allowed = patch.group_by_keys.filter((k) =>
                propertyKeys.includes(k)
            );
            if (allowed.length) {
                return allowed;
            }
        }
        return inferGroupByKeysFromQuestion(question, propertyKeys);
    })();

    if (
        pattern === "AGGREGATE_GROUP_BY" &&
        groupByKeys.length === 0 &&
        base.target_pattern !== "AGGREGATE_GROUP_BY"
    ) {
        pattern = "FILTER_COUNT";
    }

    const bindings = (() => {
        const baseBindings = buildBindings(scope, propertyKeys, groupByKeys);
        if (!Array.isArray(patch.extra_bindings)) {
            return baseBindings;
        }
        const merged = [...baseBindings];
        for (const eb of patch.extra_bindings) {
            if (!propertyKeys.includes(eb.physical_key)) {
                continue;
            }
            if (merged.some((b) => b.physical_key === eb.physical_key)) {
                continue;
            }
            merged.push({
                logical_term: eb.logical_term,
                physical_key: eb.physical_key,
                sql_access: sqlAccessForPropertyKey(eb.physical_key),
                role: eb.role,
                source: "llm_suggested"
            });
        }
        return merged;
    })();

    const operations = buildOperations(pattern, groupByKeys);
    const output_columns = buildOutputColumns(pattern, groupByKeys, operations);
    const answer_shape_guardrail = buildAnswerShapeGuardrail(
        pattern,
        groupByKeys,
        operations
    );
    const draft_sql_sketch = buildDraftSqlSketch(
        pattern,
        bindings,
        operations,
        groupByKeys
    );
    const logic_trace = [
        ...buildLogicTraceLines(scope, pattern, groupByKeys, question),
        ...(patch.logic_trace?.trim()
            ? [`LLM trace: ${patch.logic_trace.trim()}`]
            : [])
    ];

    return {
        schema_table: "features",
        target_pattern: pattern,
        answer_shape_guardrail,
        bindings,
        operations,
        spatial: buildSpatialSummary(scope),
        output_columns,
        logic_trace,
        draft_sql_sketch
    };
}

function mergeAnswerShape(
    deterministic: GeoQueryAnswerShape,
    pattern: ExecutionTargetPattern,
    scope: GeoQueryScope,
    question: string
): GeoQueryAnswerShape {
    let candidate = answerShapeFromPattern(pattern);

    if (scope.intentType === "count") {
        return "count";
    }
    if (
        /(how many|number of|count of|多少|几个|几条|总数|计数)/i.test(question)
    ) {
        if (candidate === "list_rows" || candidate === "unknown") {
            candidate = "count";
        }
    }
    if (scope.spatialIntent.type !== "none") {
        if (candidate === "list_rows") {
            candidate = "spatial_relation";
        }
    }
    if (deterministic === "aggregate" && candidate === "unknown") {
        return "aggregate";
    }
    return candidate;
}

/**
 * Markdown block for the GeoSQL planner: schema-linked contract, not prose fluff.
 */
export function formatTaskSpecForPlanner(spec: GeoQueryTaskSpec): string {
    const p = spec.plan;
    const bindingsMd =
        p.bindings.length === 0
            ? "- _(none — no column bindings from scope)_"
            : p.bindings
                  .map((b) => {
                      const lit =
                          b.role === "FILTER" && b.filter_literal != null
                              ? ` — filter literal: "${b.filter_literal}"`
                              : "";
                      return `- **${b.role}** ← Column: \`${b.physical_key}\` → Access: \`${b.sql_access}\` (schema key; Type: treat as text via JSONB unless planner casts)${lit}`;
                  })
                  .join("\n");

    const opsMd = p.operations
        .map((o) => `- **${o.label}**: Op \`${o.operator}\` AS \`${o.alias}\``)
        .join("\n");

    const spatialMd =
        p.spatial.mode === "NONE"
            ? "NONE — attribute-only or scope-bound filters; no forced PostGIS predicate from spatial extractor."
            : [
                  `mode=${p.spatial.mode}`,
                  p.spatial.operator_family_hint
                      ? `operator_family_hint=${p.spatial.operator_family_hint}`
                      : "",
                  p.spatial.parameters
                      ? `parameters=${JSON.stringify(p.spatial.parameters)}`
                      : "",
                  p.spatial.needs_external_geocode
                      ? `needs_external_geocode=true (place=${
                            p.spatial.external_place || "n/a"
                        })`
                      : "needs_external_geocode=false"
              ]
                  .filter(Boolean)
                  .join("; ");

    const jsonPayload = {
        schema_table: p.schema_table,
        target_pattern: p.target_pattern,
        answer_shape_guardrail: p.answer_shape_guardrail,
        bindings: p.bindings.map((b) => ({
            physical_key: b.physical_key,
            role: b.role,
            sql_access: b.sql_access,
            filter_literal: b.filter_literal
        })),
        operations: p.operations,
        spatial: p.spatial,
        output_columns: p.output_columns
    };

    return [
        "## [Execution Target Definition] (Schema-Linked Execution Plan)",
        "",
        "| Field | Value |",
        "|-------|-------|",
        "| **Target Pattern** | `" + p.target_pattern + "` |",
        "| **Answer Shape (guardrail)** | " + p.answer_shape_guardrail + " |",
        "| **Table** | `" +
            p.schema_table +
            "` — all business fields via `properties` JSONB only |",
        "",
        "### Column bindings (physical keys from dataset schema)",
        bindingsMd,
        "",
        "### Measures / operators (standardised)",
        opsMd || "- _(none)_",
        "",
        "### Spatial constraints",
        spatialMd,
        "",
        "### Output columns (contract)",
        `- [ ${p.output_columns.map((c) => `\`${c}\``).join(", ")} ]`,
        "",
        "### Logic trace",
        p.logic_trace.map((line) => `- ${line}`).join("\n"),
        "",
        "### Draft SQL sketch (pseudocode — use real keys from YAML)",
        "```sql",
        p.draft_sql_sketch,
        "```",
        "",
        "### Machine-readable plan (JSON)",
        "```json",
        JSON.stringify(jsonPayload, null, 2),
        "```",
        "",
        "**Planner Context Override:**",
        `- Operation contract: target_pattern=\`${p.target_pattern}\`; honour **Answer Shape** and **bindings**; do not invent property keys outside schema YAML.`,
        `- Spatial: if spatial.mode is NONE, do not introduce ST_* unless the user question requires geometry; if non-NONE, downstream spatial contract still applies.`,
        ""
    ].join("\n");
}

export function shouldRefineTaskWithLlm(
    scope: GeoQueryScope,
    question: string
): boolean {
    const q = (question || "").trim();
    if (!q) {
        return false;
    }
    if (scope.intentType === "unknown") {
        return true;
    }
    if (q.length > 140) {
        return true;
    }
    if (scope.unmatchedTokens.length >= 4) {
        return true;
    }
    if (
        /(which|what).{0,50}(most|least|best|worst|maximum|minimum|highest|lowest|more|fewer)/i.test(
            q
        )
    ) {
        return true;
    }
    if (
        /(compare|comparison|versus|\bvs\b|ratio|proportion|percentage|占比|百分比|同比|环比|差异)/i.test(
            q
        )
    ) {
        return true;
    }
    if (/(break\s*down|per\b|grouped?\s+by|分层|分档|排名)/i.test(q)) {
        return true;
    }
    return false;
}

/**
 * Deterministic plan + optional LLM patch: only fills **group_by_keys**, **target_pattern**
 * override, or **logic_trace** — every physical_key must exist in `propertyKeys`.
 */
export async function resolveGeoQueryTaskSpec(input: {
    question: string;
    scope: GeoQueryScope;
    propertyKeys: string[];
    getEngine: () => Promise<ServiceWorkerMLCEngine>;
}): Promise<GeoQueryTaskSpec> {
    const baseSpec = buildDeterministicTaskSpec(
        input.scope,
        input.question,
        input.propertyKeys
    );
    if (!shouldRefineTaskWithLlm(input.scope, input.question)) {
        return baseSpec;
    }
    try {
        const engine = await input.getEngine();
        const deterministicJson = {
            target_pattern: baseSpec.plan.target_pattern,
            bindings_preview: baseSpec.plan.bindings,
            spatial: baseSpec.plan.spatial,
            scope_summary: {
                intentType: input.scope.intentType,
                boundFilters: input.scope.boundFilters,
                spatialIntent: input.scope.spatialIntent
            }
        };
        const system = [
            "## Role",
            "You refine a Schema-Linked Execution Plan for a SQL planner (PostGIS / JSONB).",
            "",
            "## Hard rules",
            "- Output **JSON only**. No markdown fences.",
            `- Every **group_by_keys** entry MUST be copied exactly from this list (schema keys): ${JSON.stringify(
                input.propertyKeys.slice(0, 80)
            )}`,
            "- Do NOT invent property keys. If unsure, return empty group_by_keys.",
            "- Do NOT output SQL with bare column names like `suburb` — attributes live in `properties->>'key'`.",
            "- target_pattern MUST be one of: FILTER_COUNT | LIST_ROWS | AGGREGATE_GROUP_BY | SPATIAL_FILTER | SPATIAL_NEAREST | SPATIAL_TOPOLOGY | MEASUREMENT | MIXED | UNKNOWN",
            "- Prefer AGGREGATE_GROUP_BY when the user wants breakdown / per category / 按…分组; FILTER_COUNT for how-many totals without grouping.",
            "",
            "## Output JSON shape",
            '{"target_pattern":"<enum>","group_by_keys":["<key>", "..."],"logic_trace":"<one sentence>","extra_bindings":[{"physical_key":"<key>","role":"GROUP_BY"|"FILTER"|"SELECT","logical_term":"<optional>"}]}'
        ].join("\n");
        const user = [
            `User question:\n${input.question}`,
            "",
            `Deterministic plan summary:\n${JSON.stringify(
                deterministicJson,
                null,
                2
            )}`
        ].join("\n");
        const reply = await engine.chat.completions.create({
            stream: false,
            messages: [
                { role: "system", content: system },
                { role: "user", content: user }
            ]
        });
        const raw = reply?.choices?.[0]?.message?.content?.trim() || "";
        const patch = parseLlmPlanPatch(raw);
        if (!patch) {
            return baseSpec;
        }
        const mergedPlan = mergePlanWithLlmPatch(
            baseSpec.plan,
            patch,
            input.propertyKeys,
            input.scope,
            input.question
        );
        const mergedShape = mergeAnswerShape(
            baseSpec.answerShape,
            mergedPlan.target_pattern,
            input.scope,
            input.question
        );
        return {
            plan: mergedPlan,
            answerShape: mergedShape,
            source: "merged"
        };
    } catch {
        return baseSpec;
    }
}
