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
 * 2) createQueryGeoSpatialWithSQLQueryTool -> assemble prompt/metadata for LLM tool-calling.
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
    formatImportSpatialResult,
    importSpatialFromDistribution,
    runPostgisQuery
} from "../../../libs/pglitePostgis";
import { WebLLMTool } from "../ChatWebLLM";
import { markdownTable } from "markdown-table";
import { ParsedDistribution } from "helpers/record";
import { config } from "../../../config";
import { resolveReferencePoint } from "./queryGeoDataset/placeResolver";
import {
    buildGeoFileDescriptionsAndIntro,
    buildGeoSqlToolDescription
} from "./queryGeoDataset/description";
import {
    getDistributionUrl,
    isGeoSpatialDistribution
} from "./queryGeoDataset/distribution";
import { sampleGeoPropertyKeys } from "./queryGeoDataset/schema";
import {
    buildGeoSqlOutputGuidance,
    chooseCoreDisplayKeys,
    formatGeoSqlPropertyProjection,
    getGeoSqlErrorSuggestion,
    repairGeoSqlWithModel,
    sanitizeGeoSql
} from "./queryGeoDataset/sql";
import type { GeoReference, SpatialIntentResult } from "../spatialIntentRouter";

type GeoSqlPlan =
    | {
          type: "query";
          distributionIndex: number;
          sqlQuery: string;
          placeName?: string;
          countrycodes?: string;
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
        const reply = await engine.chat.completions.create({
            stream: false,
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
    const distList = dists
        .map((item) => `${item.idx}: ${item.dist.title} (${item.dist.format})`)
        .join("\n");
    const plannerSystemInstruction =
        "You are a GeoSQL planner for Magda dataset chat. " +
        "Output JSON only, no markdown, no explanation. " +
        "If the question requires spatial/geographic SQL analysis, output: " +
        '{"type":"query","distributionIndex":<integer>,"sqlQuery":"<PostGIS SQL>","placeName":"<optional>","countrycodes":"<optional>"} ' +
        "The sqlQuery value MUST contain executable SQL only: start directly with SELECT or WITH; do not include apologies, explanations, markdown fences, comments, prose, JSON, or labels before/after the SQL. " +
        "SQL must be a single SELECT/WITH query against the table `features` only. " +
        "The browser PostGIS database always loads the selected spatial distribution into `features`; never use the dataset title, distribution title, filename, or a derived name such as Manningham_Street_Trees as a SQL table name. " +
        "Only these top-level columns exist: id, properties, geom. Dataset attributes are JSONB keys under properties; use properties->>'key' or properties->'key'. " +
        "Before writing SQL, inspect the provided schema/sample YAML and use only keys listed in schema_binding.properties_schema.existing_keys. " +
        "When user asks semantic fields like name/address/category, map them to the closest existing property keys in metadata/sample (e.g. name -> asset_name) instead of inventing top-level columns. " +
        "For result readability and map rendering, keep SELECT output compact: include id, requested computed metrics, a few readable properties from existing keys, and ST_AsText(geom) AS geom_wkt; do not SELECT *, raw geom, or full properties unless explicitly requested. " +
        "If the user asks for features nearest to a point that is identified by a dataset column/key and value (e.g. id=12, street='King Street', species='Oak'), do NOT use placeName or __REF_POINT__; use a CTE/self-join against features to select the reference row. " +
        "If Parser reference context says external place=<place>, preserve the user's requested spatial operation, set placeName to that exact place, and use __REF_POINT__ in sqlQuery where that external location is needed. " +
        "__REF_POINT__ is a complete PostGIS geometry expression in SRID 4326; use it directly in ST_Distance/ST_DWithin/ST_Intersects. Never access __REF_POINT__.lon/__REF_POINT__.lat and never wrap it as ST_MakePoint(__REF_POINT__.lon, __REF_POINT__.lat). " +
        "Only use placeName/__REF_POINT__ when the reference point is not expressed as an existing dataset column/key filter. " +
        "If no suitable existing key is present, return a safe SQL query that exposes available keys/sample rows instead of guessing nonexistent columns. " +
        "If the question does NOT require spatial SQL analysis, output: " +
        '{"type":"not_applicable","reason":"<short reason>"}';
    const parserReference = getParserReference(this);
    const outputGuidance = buildGeoSqlOutputGuidance(
        getPlannerPropertyKeys(this)
    );
    const plannerUserPrompt =
        `User question:\n${this.question}\n\n` +
        `Parser reference context:\n${formatGeoReferenceForPlanner(
            parserReference
        )}\n\n` +
        `SQL output guidance:\n${outputGuidance}\n\n` +
        `Available spatial distributions:\n${distList}\n\n` +
        `Metadata brief:\n${metadataBrief || "N/A"}\n\n` +
        `Schema/sample YAML for GeoSQL generation:\n${
            fileDescItems?.length ? fileDescItems.join("\n---\n") : "N/A"
        }`;
    const reply = await engine.chat.completions.create({
        stream: false,
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
    });
    const raw = reply?.choices?.[0]?.message?.content?.trim();
    if (!raw) {
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
                        : undefined
            };
        }
        if (
            parsed?.type === "not_applicable" &&
            typeof (parsed as any).reason === "string"
        ) {
            return {
                type: "not_applicable",
                reason: (parsed as any).reason
            };
        }
    } catch {
        // Fall through to safe not-applicable path.
    }
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
    countrycodes?: string
) {
    this.keyContextData.queryResult = undefined;

    const evalIso =
        (this as any).__geoEvalPgliteTarget === "eval" ||
        (this as any).__geoEvalUseIsolatedPglite === true;
    const pgliteTarget = evalIso ? ("eval" as const) : ("default" as const);
    const pgExec = { pgliteTarget };
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

    const skipImport = !!(this as any).__geoEvalSkipImport;

    pushGeoUserMessage(
        this,
        `Preparing a spatial query for "${dist.title}"...`
    );
    if (skipImport) {
        pushGeoRunLog(
            this,
            `Eval mode: using existing PostGIS \`features\` table (skip re-import for "${dist.title}").`
        );
    } else {
        pushGeoRunLog(
            this,
            `Importing spatial data for "${dist.title}" into PostGIS (PGlite).`
        );
    }

    let insertedFeatureCount: number | null = null;
    if (skipImport) {
        try {
            const cntRows = await runPostgisQuery(
                `SELECT COUNT(*)::int AS c FROM features`,
                undefined,
                pgExec
            );
            insertedFeatureCount = cntRows[0]?.c ?? 0;
        } catch (e) {
            pushGeoUserMessage(
                this,
                `Failed to read PostGIS feature count: ${String(e)}`
            );
            return null;
        }
    } else {
        try {
            const maxFeat = (this as any).__geoEvalMaxImportFeatures;
            const importResult = await importSpatialFromDistribution(
                targetUrl,
                dist.format,
                dist.title,
                {
                    ...(typeof maxFeat === "number"
                        ? { maxFeatures: maxFeat }
                        : {}),
                    pgliteTarget
                }
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

    const propKeysFromProfile =
        typeof targetIdx === "number" && Number.isInteger(targetIdx)
            ? profilePropertyKeysByIdx?.[targetIdx]
            : undefined;
    const propKeys =
        propKeysFromProfile?.length && propKeysFromProfile.length > 0
            ? propKeysFromProfile
            : await sampleGeoPropertyKeys(pgExec);

    const parserReference = getParserReference(this);
    const parserPlaceName =
        parserReference?.type === "external" && parserReference.place.trim()
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
    const parserReferenceFeatureFilter = buildReferenceFeatureFilterFromParser(
        parserReference,
        propKeys
    );
    const referenceFeatureFilter =
        parserReferenceFeatureFilter ||
        inferReferenceFeatureFilterFromQuestion(this.question, propKeys);
    if (proximityIntent && referenceFeatureFilter) {
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
        : placeName && placeName.trim()
        ? placeName.trim()
        : proximityIntent
        ? inferPlaceNameFromQuestion(this.question) || undefined
        : undefined;
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
    if (propKeys?.length) {
        pushGeoRunLog(
            this,
            `Sample attribute keys in properties (JSON): ${propKeys.join(", ")}`
        );
    }

    let records: Record<string, any>[] | null = null;
    let sqlToRun = finalSqlQuery;
    const maxAttempts = 2;
    let failureFromPreflight = false;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            if (attempt === 1) {
                (this as any).__geoEvalExecutedSqlFirst = sqlToRun;
                // Preflight parse to catch syntax errors before first execution.
                try {
                    await runPostgisQuery(
                        `EXPLAIN ${sqlToRun}`,
                        undefined,
                        pgExec
                    );
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
            records = await runPostgisQuery(sqlToRun, undefined, pgExec);
            (this as any).__geoEvalExecutedSqlFinal = sqlToRun;
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
    const tableHeaders = Object.keys(records[0]);
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

async function createQueryGeoSpatialWithSQLQueryTool(
    distItems: {
        idx: number;
        dist: ParsedDistribution;
    }[],
    prebuiltFileDescItems?: string[],
    metadataBrief?: string
): Promise<WebLLMTool> {
    const fileDescItems = prebuiltFileDescItems || [];

    return {
        name: "queryGeoSpatialWithSQLQuery",
        func: queryGeoSpatialWithSQLQuery,
        description: buildGeoSqlToolDescription(fileDescItems, metadataBrief),
        parameters: [
            {
                name: "distributionIndex",
                type: "integer" as const,
                description:
                    "The spatial file `id` from the list above (dataset distribution index). Loading replaces the current `features` table."
            },
            {
                name: "sqlQuery",
                type: "string" as const,
                description:
                    "Executable SQL only. Must start directly with SELECT or WITH. Do not include natural language, apologies, explanations, markdown code fences, JSON wrappers, comments, or labels. " +
                    "A single PostGIS SELECT (or WITH) query against table `features`. Keep result rows at most 100. " +
                    "Generate robust geometry logic (e.g. line queries should support both LINESTRING and MULTILINESTRING). " +
                    "For numeric distance/length on lon-lat geometries, use geography casting for meter units. " +
                    "When `placeName` is supplied, use token `__REF_POINT__` directly as the resolved SRID 4326 geometry expression. Do not use __REF_POINT__.lon/__REF_POINT__.lat or wrap it in ST_MakePoint."
            },
            {
                name: "placeName",
                type: "string" as const,
                description:
                    "Optional reference place text for distance/proximity queries (e.g. 'University of Sydney'). " +
                    "Resolution order: current dataset first, then Nominatim fallback."
            },
            {
                name: "countrycodes",
                type: "string" as const,
                description:
                    "Optional ISO country code filter for fallback Nominatim geocoding (default: au)."
            }
        ],
        requiredParameters: ["distributionIndex", "sqlQuery"]
    };
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
            spatialProfileItems
        );
        (this as ChainInput & {
            __geoMetadataBrief?: string;
        }).__geoMetadataBrief = prepared.metadataBrief;
        (this as ChainInput & {
            __geoFileDescItems?: string[];
        }).__geoFileDescItems = prepared.fileDescItems;
        const generatedIntro = await generateGeoDatasetIntro(
            this,
            prepared.introContext
        );
        if (generatedIntro) {
            pushGeoUserMessage(this, generatedIntro);
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
                plan.countrycodes
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
