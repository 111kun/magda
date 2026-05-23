import { ChainInput, SpatialCoverageHint, SpatialProfileItem } from "./commons";
import { webLlmChatCompletion, webLlmResetChat } from "./webLlmSerial";

/**
 * Hybrid GeoSQL intent router.
 *
 * Deterministic rules first, then metadata-aware hints, then a compact
 * local LLM classifier. Prefer `spatial` vs `non_spatial`; `unknown` is a
 * last resort so AgentChain can fall back to normal tool-choice.
 */

export type SpatialIntentRoute = "spatial" | "non_spatial" | "unknown";
export type SpatialIntentSource =
    | "strong_regex"
    | "metadata_score"
    | "llm"
    | "fallback";

export type GeoReference =
    | { type: "internal"; key: string; value: string }
    | { type: "external"; place: string }
    | { type: "none" };

export type SpatialIntentResult = {
    route: SpatialIntentRoute;
    confidence: number;
    reason: string;
    source: SpatialIntentSource;
    reference: GeoReference;
};

export type ChatRouteAction =
    | "default_agent"
    | "spatial_sql"
    | "tabular_sql"
    | "search_datasets"
    | "llm_auto";

export type ChatRouteDecision = {
    action: ChatRouteAction;
    reason: string;
    spatialIntent?: SpatialIntentResult;
};

const SPATIAL_CONFIDENCE_THRESHOLD = 0.65;
const MAX_SCOPE_TOKENS = 40;
const MAX_SAMPLE_VALUES_FOR_PROMPT = 45;

export function buildSpatialCoverageHint(
    input: ChainInput
): SpatialCoverageHint | undefined {
    const profile = input.keyContextData?.datasetProfile;
    if (!profile) {
        return undefined;
    }
    const raw = [
        profile.datasetTitle || "",
        profile.datasetDescription || "",
        ...(profile.datasetTags || []),
        ...(profile.datasetThemes || [])
    ]
        .filter(Boolean)
        .join(" ");
    const scopeTokens = tokenizeScopeText(raw).slice(0, MAX_SCOPE_TOKENS);
    if (!scopeTokens.length) {
        return undefined;
    }
    const scopeHintForLlm =
        "DATASET SCOPE (words from title/description/tags/themes — catalogue context, not a map pin by themselves):\n" +
        `${scopeTokens.join(", ")}\n` +
        'If the user only uses these as a council/region/subject filter (no street, building, POI, coordinates, or explicit distance-to-a-point), prefer intent "non-spatial" and reference_type "none".\n' +
        'If they say "near / within / closest" to a named POI or address, that named target is usually an EXTERNAL anchor unless it matches an attribute filter on a known schema key.';

    return { scopeTokens, scopeHintForLlm };
}

function tokenizeScopeText(text: string): string[] {
    const n = normalizeText(text);
    if (!n) {
        return [];
    }
    const parts = n
        .split(/[^a-z0-9\u4e00-\u9fff]+/g)
        .filter((t) => t.length >= 2);
    return [...new Set(parts)];
}

function normalizeText(input: string): string {
    return (input || "").trim().toLowerCase();
}

function getSpatialProfileItems(input: ChainInput): SpatialProfileItem[] {
    return input.keyContextData?.datasetProfile?.spatial?.items || [];
}

function getSpatialPropertyKeys(input: ChainInput): string[] {
    const keys = new Set<string>();
    getSpatialProfileItems(input).forEach((item) => {
        (item.propertyKeys || []).forEach((key) => {
            if (key?.trim()) {
                keys.add(key.trim());
            }
        });
    });
    return [...keys];
}

/** Normalised sample attribute values from spatial profile rows (for scope / ref refinement). */
function collectSpatialSampleValues(input: ChainInput): Set<string> {
    const set = new Set<string>();
    for (const item of getSpatialProfileItems(input)) {
        for (const row of item.sampleRows || []) {
            for (const v of Object.values(row)) {
                if (v == null) {
                    continue;
                }
                const s = String(v).trim();
                if (s.length < 2 || s.length > 120) {
                    continue;
                }
                const n = normalizeText(s);
                if (n.length >= 2) {
                    set.add(n);
                }
            }
        }
    }
    return set;
}

function formatSampleValuesForPrompt(sampleValues: Set<string>): string {
    if (!sampleValues.size) {
        return "N/A";
    }
    return [...sampleValues].slice(0, MAX_SAMPLE_VALUES_FOR_PROMPT).join(", ");
}

function getGeometryTypeSummary(input: ChainInput): string {
    return getSpatialProfileItems(input)
        .flatMap((item) => item.geometryTypes || [])
        .map((item) => `${item.type}:${item.count}`)
        .join(", ");
}

function getDatasetMetadataSummary(input: ChainInput): string {
    const profile = input.keyContextData?.datasetProfile;
    if (!profile) {
        return "N/A";
    }
    return [
        `title: ${profile.datasetTitle || "N/A"}`,
        `description: ${profile.datasetDescription || "N/A"}`,
        `themes: ${(profile.datasetThemes || []).join(", ") || "N/A"}`,
        `tags: ${(profile.datasetTags || []).join(", ") || "N/A"}`
    ].join("\n");
}

function noneReference(): GeoReference {
    return { type: "none" };
}

function classifyByStrongRegex(question: string): SpatialIntentResult | null {
    const text = normalizeText(question);
    if (!text) {
        return {
            route: "non_spatial",
            confidence: 1,
            reason: "Empty question.",
            source: "strong_regex",
            reference: noneReference()
        };
    }

    const strongPatterns = [
        /\b(?:geo|geo\s*tool|geospatial|spatial\s*tool|postgis|geosql)\b/i,
        /\b(?:st_[a-z0-9_]+|postgis|geosql|wkt|wkb|geojson)\b/i,
        /\b(?:lat|lon|lng|latitude|longitude)\b/i,
        /-?\d+(?:\.\d+)?\s*,\s*-?\d+(?:\.\d+)?/,
        /\b\d+(?:\.\d+)?\s*(?:m|meter|meters|km|kilometer|kilometers)\b/i,
        /\b(?:buffer|intersect|intersects|intersection|within|contains|containment|radius|geofence)\b/i,
        /(经纬度|坐标|半径|缓冲|相交|包含|范围|公里|千米|米)/
    ];
    if (strongPatterns.some((pattern) => pattern.test(question))) {
        return {
            route: "spatial",
            confidence: 0.98,
            reason: "Matched high-confidence geospatial signal.",
            source: "strong_regex",
            reference: noneReference()
        };
    }
    return null;
}

function hasSpatialAction(question: string): boolean {
    return (
        /(附近|周边|最近|最近的|距离|多远|在哪|哪里|范围|区域|半径|包含|相交|离.+近|离.+远)/.test(
            question
        ) ||
        /\b(?:near|nearby|nearest|closest|distance|within|where|around|radius|intersect|contains|contain|area|length)\b/i.test(
            question
        )
    );
}

/**
 * Property-key mention + spatial-action heuristic, plus light value overlap:
 * if the question text contains sample attribute values (e.g. suburb) together
 * with spatial verbs, still treat as spatial intent but downstream ref
 * refinement may clear false external places.
 */
function classifyByMetadataScore(
    input: ChainInput
): SpatialIntentResult | null {
    const question = input.question || "";
    const text = normalizeText(question);
    const propertyKeys = getSpatialPropertyKeys(input);
    const sampleValues = collectSpatialSampleValues(input);
    if (!text || !propertyKeys.length) {
        return null;
    }
    const mentionedKeys = propertyKeys.filter((key) => {
        const keyText = key.toLowerCase();
        return (
            keyText.length >= 2 &&
            (text.includes(keyText) ||
                new RegExp(
                    `\\b${keyText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`,
                    "i"
                ).test(question))
        );
    });

    let valueOverlap = false;
    if (sampleValues.size && text.length >= 4) {
        for (const val of sampleValues) {
            if (val.length < 3) {
                continue;
            }
            if (text.includes(val) || question.toLowerCase().includes(val)) {
                valueOverlap = true;
                break;
            }
        }
    }

    if (hasSpatialAction(question) && (mentionedKeys.length || valueOverlap)) {
        const bits = [
            mentionedKeys.length
                ? `keys: ${mentionedKeys.slice(0, 5).join(", ")}`
                : null,
            valueOverlap ? "sample value phrase overlap" : null
        ]
            .filter(Boolean)
            .join("; ");
        return {
            route: "spatial",
            confidence: mentionedKeys.length ? 0.9 : 0.78,
            reason: `Spatial action with dataset grounding (${bits}).`,
            source: "metadata_score",
            reference: noneReference()
        };
    }
    return null;
}

function parseGeoQueryParserJson(
    raw: string
): {
    intent?: "spatial" | "non-spatial" | "unknown";
    confidence?: number;
    reference_type?: "internal" | "external" | "none";
    extraction?: {
        key?: string;
        value?: string;
        place?: string;
    };
    reason?: string;
} | null {
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

function buildReferenceFromParser(
    parsed: ReturnType<typeof parseGeoQueryParserJson>,
    propertyKeys: string[]
): GeoReference {
    if (!parsed || parsed.reference_type === "none") {
        return noneReference();
    }
    if (parsed.reference_type === "internal") {
        const key = parsed.extraction?.key?.trim() || "";
        const value = parsed.extraction?.value?.trim() || "";
        if (key && value && propertyKeys.includes(key)) {
            return {
                type: "internal",
                key,
                value
            };
        }
        if (value) {
            return {
                type: "external",
                place: value
            };
        }
        return noneReference();
    }
    if (parsed.reference_type === "external") {
        const place = parsed.extraction?.place?.trim() || "";
        return place
            ? {
                  type: "external",
                  place
              }
            : noneReference();
    }
    return noneReference();
}

/**
 * Reduce false "external" anchors when the place string is really dataset scope
 * or an attribute value already present in sampled rows.
 */
function refineReference(
    ref: GeoReference,
    input: ChainInput,
    sampleValues: Set<string>
): GeoReference {
    if (ref.type !== "external") {
        return ref;
    }
    const placeNorm = normalizeText(ref.place);
    if (!placeNorm || placeNorm.length < 2) {
        return noneReference();
    }
    const profile = input.keyContextData?.datasetProfile;
    const title = normalizeText(profile?.datasetTitle || "");
    const desc = normalizeText(profile?.datasetDescription || "");
    const tags = (profile?.datasetTags || []).map(normalizeText).join(" ");
    const themes = (profile?.datasetThemes || []).map(normalizeText).join(" ");
    const blob = `${title} ${desc} ${tags} ${themes}`;

    if (placeNorm.length >= 4 && blob.includes(placeNorm)) {
        return noneReference();
    }
    if (
        title.length >= 6 &&
        placeNorm.length >= 4 &&
        title.includes(placeNorm)
    ) {
        return noneReference();
    }
    if (sampleValues.has(placeNorm)) {
        return noneReference();
    }
    for (const v of sampleValues) {
        if (
            v.length >= 4 &&
            (placeNorm === v || placeNorm.includes(v) || v.includes(placeNorm))
        ) {
            return noneReference();
        }
    }
    return ref;
}

const SPATIAL_CLASSIFIER_SYSTEM = [
    "## Role",
    "You are a Magda Spatial Intent Classifier.",
    "",
    "## Task",
    '1. Classify intent: "spatial" (should query spatial DB / PostGIS path) vs "non-spatial" (pure metadata/help/greeting/simple tabular stats only).',
    "2. Pick a reference anchor:",
    '   - "internal": a row in THIS dataset (schema key + value, e.g. street = King).',
    '   - "external": a real-world place OUTSIDE the attribute table (e.g. a library, 120 Collins St) used for distance / nearest.',
    '   - "none": no anchor.',
    "",
    "## Decision logic (short)",
    "- Default policy: if unsure, choose intent = spatial (prefer recall for spatial DB routing).",
    "- Use non-spatial ONLY for clear pure metadata/help/greeting requests, or explicit non-geometry aggregate requests that can be answered without spatial DB.",
    "- If the question has near / closest / within [distance] / around / 附近 / 最近 / 距离, or asks where/location/distribution on map: intent = spatial.",
    "- If words match ONLY the DATASET SCOPE block (catalogue region names), do NOT treat them as external geocode anchors; set reference = none (intent can still be spatial).",
    "- If the anchor is a filter on a known schema key column: reference = internal.",
    "- If the anchor is a POI/address not in attributes: reference = external.",
    "",
    "## Output",
    "Return JSON only. No markdown, no prose outside JSON.",
    'Shape: {"intent":"spatial"|"non-spatial","confidence":0-1,"reference_type":"internal"|"external"|"none","extraction":{},"reason":"one short sentence"}',
    'Use "internal" only if extraction is {"key":"<one of schema keys>","value":"<string>"} exactly.',
    'Use "external" only if extraction is {"place":"<string>"}.',
    'Prefer "spatial" or "non-spatial". Avoid "unknown"; if ambiguous, return "spatial" with medium confidence.',
    "",
    "## Few-shot",
    'Q: "Show trees in Manningham"  -> {"intent":"spatial","confidence":0.76,"reference_type":"none","extraction":{},"reason":"Manningham is dataset scope (not external anchor), but request should still go through spatial DB query path."}',
    'Q: "Trees within 500 m of Manningham Library" -> {"intent":"spatial","confidence":0.9,"reference_type":"external","extraction":{"place":"Manningham Library"},"reason":"Library is a concrete external anchor for distance."}'
].join("\n");

async function parseByLocalLlm(
    input: ChainInput
): Promise<SpatialIntentResult> {
    const propertyKeys = getSpatialPropertyKeys(input);
    const sampleValues = collectSpatialSampleValues(input);
    try {
        const engine = await input.model.getEngine();
        await webLlmResetChat(engine);
        const scopeBlock = input.spatialCoverage?.scopeHintForLlm
            ? `${input.spatialCoverage.scopeHintForLlm}\n\n`
            : "";
        const userBody =
            `${scopeBlock}` +
            `Question:\n${input.question}\n\n` +
            `schema_keys (use for internal only):\n${
                propertyKeys.length
                    ? propertyKeys.slice(0, 40).join(", ")
                    : "N/A"
            }\n\n` +
            `Sample attribute values (subset; for scope — if a phrase matches here it is usually NOT an external geocode target):\n${formatSampleValuesForPrompt(
                sampleValues
            )}\n\n` +
            `Dataset metadata:\n${getDatasetMetadataSummary(input)}\n\n` +
            `Geometry types:\n${getGeometryTypeSummary(input) || "N/A"}`;
        const reply = await webLlmChatCompletion(engine, {
            messages: [
                {
                    role: "system",
                    content: SPATIAL_CLASSIFIER_SYSTEM
                },
                {
                    role: "user",
                    content: userBody
                }
            ]
        });
        if (reply?.usage) {
            console.log(
                `[SpatialIntentRouter] LLM usage: prompt=${reply.usage.prompt_tokens} completion=${reply.usage.completion_tokens} total=${reply.usage.total_tokens}`
            );
        }
        const raw = reply?.choices?.[0]?.message?.content || "";
        const parsed = parseGeoQueryParserJson(raw);
        if (
            !parsed ||
            !["spatial", "non-spatial", "unknown"].includes(parsed.intent || "")
        ) {
            return {
                route: "unknown",
                confidence: 0,
                reason: "LLM parser returned invalid JSON.",
                source: "fallback",
                reference: noneReference()
            };
        }
        const confidence =
            typeof parsed.confidence === "number"
                ? Math.max(0, Math.min(1, parsed.confidence))
                : parsed.intent === "spatial"
                ? 0.72
                : 0.72;
        let reference = buildReferenceFromParser(parsed, propertyKeys);
        reference = refineReference(reference, input, sampleValues);
        return {
            route:
                parsed.intent === "spatial" &&
                confidence >= SPATIAL_CONFIDENCE_THRESHOLD
                    ? "spatial"
                    : parsed.intent === "spatial"
                    ? "unknown"
                    : parsed.intent === "unknown"
                    ? "unknown"
                    : "non_spatial",
            confidence,
            reason: parsed.reason || "Parsed by local WebLLM router.",
            source: "llm",
            reference
        };
    } catch (e) {
        return {
            route: "unknown",
            confidence: 0,
            reason: `LLM parser failed: ${String(e)}`,
            source: "fallback",
            reference: noneReference()
        };
    }
}

export async function classifySpatialIntent(
    input: ChainInput
): Promise<SpatialIntentResult> {
    const strongResult = classifyByStrongRegex(input.question);
    if (strongResult?.route === "spatial") {
        return strongResult;
    }
    const metadataResult = classifyByMetadataScore(input);
    if (metadataResult?.route === "spatial") {
        return metadataResult;
    }
    return await parseByLocalLlm(input);
}

function getLocationType(
    input: ChainInput
): "DATASET_PAGE" | "DISTRIBUTION_PAGE" | "OTHERS" {
    const path = input?.location?.pathname || "";
    if (path.includes("/dataset/")) {
        return "DATASET_PAGE";
    }
    if (path.includes("/distribution/")) {
        return "DISTRIBUTION_PAGE";
    }
    return "OTHERS";
}

function hasGreetingIntent(question: string): boolean {
    const text = (question || "").trim().toLowerCase();
    if (!text) {
        return false;
    }
    return /^(hi|hello|hey|你好|您好|嗨|哈喽|早上好|下午好|晚上好)\b/.test(
        text
    );
}

function hasDatasetDescriptionIntent(question: string): boolean {
    const text = (question || "").toLowerCase().trim();
    if (!text) {
        return false;
    }
    // Catalogue / schema help only — not attribute filters ("house field equals …").
    return (
        /(当前数据集|这个数据集|数据集说明|字段说明|列名|样例|示例数据)/.test(
            text
        ) ||
        /\b(schema|column names?|sample rows?|data dictionary|field list)\b/.test(
            text
        ) ||
        /\b(describe|description of)\s+(?:this|the)\s+dataset\b/.test(text) ||
        /\bwhat\s+(?:columns?|fields?)\s+(?:does|are)\b/.test(text) ||
        /\b(dataset metadata|metadata for this dataset)\b/.test(text)
    );
}

function hasAnalysisIntent(question: string): boolean {
    const text = (question || "").toLowerCase().trim();
    if (!text) {
        return false;
    }
    return (
        /(分析|查询|统计|筛选|过滤|聚合|分组|计数|排序|top|按.*统计|计算|对比|sql|加载)/.test(
            text
        ) ||
        /\b(analy[sz]e|analysis|query|filter|where|group by|count|sum|avg|average|min|minimum|max|maximum|total|top\s*\d+|compare|sql)\b/.test(
            text
        ) ||
        /\b(geodesic|loaded|postgis|geograph(y|ic)|combined|containing|frequent|common)\b/.test(
            text
        ) ||
        /\b(shape_[a-z0-9_]+|st_[a-z0-9_]+)\b/i.test(text) ||
        /\b(longer than|shorter than|square meters?|square metres?|typed as)\b/.test(
            text
        ) ||
        /\b(largest|smallest|shortest|longest|typical|median|footprint)\b/.test(
            text
        )
    );
}

/** Scalar geometry/property metrics (eval MEASUREMENT tags) — must not fall through to default_agent. */
function hasMetricMeasurementQueryIntent(question: string): boolean {
    const text = (question || "").toLowerCase().trim();
    if (!text) {
        return false;
    }
    return (
        /\bwhat is the\b[\s\S]{0,100}\b(largest|smallest|shortest|longest|typical|median|average|combined|total|maximum|minimum)\b/i.test(
            text
        ) ||
        /\b(among valid|valid geometries only|invalid geometries?)\b/.test(
            text
        ) ||
        /\b(in square metres?|in metres?|perimeter of any|segment length|polygon size)\b/.test(
            text
        ) ||
        /\b(shortest|longest|largest|smallest|typical)\s+(segment|polygon|perimeter|area|length)\b/.test(
            text
        ) ||
        /\b(total|combined|average|typical)\s+(area|length|perimeter|footprint|size)\b/.test(
            text
        )
    );
}

function hasStrongDataQueryIntent(question: string): boolean {
    const text = (question || "").toLowerCase().trim();
    if (!text) {
        return false;
    }
    return (
        hasAnalysisIntent(text) ||
        hasMetricMeasurementQueryIntent(text) ||
        /(显示|展示|列出|查|查询|筛选|过滤|统计|多少|哪些|有哪些|给我|看一下|导出|下载|明细|记录|行)/.test(
            text
        ) ||
        /\b(show|list|find|get|fetch|retrieve|return|display|rows?|records?|which|what are|how many|number of|total number|count of|count\b)\b/.test(
            text
        ) ||
        /\b(which|what)\b[\s\S]{0,80}\b(most|least|more|fewer|highest|lowest|largest|smallest|shortest|longest|maximum|minimum|average|total|typical|geodesic)\b/i.test(
            text
        ) ||
        /\b(top\s*\d+|bottom\s*\d+|breakdown|grouped?\s+by|loaded in|passes?)\b/i.test(
            text
        )
    );
}

function needsDataQuery(question: string): boolean {
    const text = (question || "").toLowerCase().trim();
    if (!text || hasGreetingIntent(text)) {
        return false;
    }
    if (hasStrongDataQueryIntent(text)) {
        return true;
    }
    if (hasDatasetDescriptionIntent(text)) {
        return false;
    }
    return false;
}

function needsSpatialReasoning(question: string): boolean {
    const text = (question || "").toLowerCase().trim();
    if (!text) {
        return false;
    }
    return (
        /(附近|周边|最近|距离|多远|半径|范围|区域|相交|包含|缓冲|地图上|坐标|经纬度)/.test(
            text
        ) ||
        /\b(near|nearby|nearest|closest|distance|within|intersect|contains|buffer|radius|location|map|latitude|longitude|lat|lon)\b/.test(
            text
        )
    );
}

function isContextSufficientForDirectAnswer(question: string): boolean {
    if (hasGreetingIntent(question)) {
        return true;
    }
    if (!hasDatasetDescriptionIntent(question)) {
        return false;
    }
    // Profile metadata/sample rows are partial context. If user asks for
    // concrete results, we must query full data instead of answering directly.
    return !needsDataQuery(question);
}

export async function decideChatRoute(
    input: ChainInput
): Promise<ChatRouteDecision> {
    const locationType = getLocationType(input);
    const question = input.question || "";

    if (locationType === "OTHERS") {
        if (!hasGreetingIntent(question)) {
            return {
                action: "search_datasets",
                reason: "Outside dataset/distribution page; use dataset search."
            };
        }
        return {
            action: "llm_auto",
            reason:
                "Outside dataset/distribution page greeting; use default tool selection."
        };
    }

    if (isContextSufficientForDirectAnswer(question)) {
        return {
            action: "default_agent",
            reason:
                "Only greeting/overview requested. Direct answer is safe without querying full data."
        };
    }

    const hasSpatialDistributions =
        (input.keyContextData?.datasetProfile?.spatial?.items || []).length > 0;
    if (!needsDataQuery(question)) {
        return {
            action: "default_agent",
            reason:
                "No strong data-query signal. Note: profile/sample context is partial, so concrete data requests must use query tools."
        };
    }

    if (hasSpatialDistributions) {
        return {
            action: "spatial_sql",
            reason: needsSpatialReasoning(question)
                ? "Data query needs spatial reasoning and spatial distributions are available."
                : "Data query routed to spatial SQL because dataset has spatial distributions."
        };
    }

    return {
        action: "tabular_sql",
        reason:
            "Data query detected but no spatial distribution is available; use tabular SQL path."
    };
}
