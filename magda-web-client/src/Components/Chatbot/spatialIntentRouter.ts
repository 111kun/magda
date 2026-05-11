import { ChainInput, SpatialProfileItem } from "./commons";

/**
 * Hybrid GeoSQL intent router.
 *
 * The router keeps obvious spatial requests fast with deterministic rules,
 * boosts confidence with dataset spatial metadata, and only calls the local
 * WebLLM classifier for ambiguous natural-language questions. When uncertain,
 * it returns "unknown" so AgentChain can fall back to the normal tool-choice
 * flow instead of forcing GeoSQL.
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

const SPATIAL_CONFIDENCE_THRESHOLD = 0.65;

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

function classifyByMetadataScore(
    input: ChainInput
): SpatialIntentResult | null {
    const question = input.question || "";
    const text = normalizeText(question);
    const propertyKeys = getSpatialPropertyKeys(input);
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
    if (mentionedKeys.length && hasSpatialAction(question)) {
        return {
            route: "spatial",
            confidence: 0.9,
            reason: `Question mentions spatial dataset key(s) with spatial action: ${mentionedKeys
                .slice(0, 5)
                .join(", ")}.`,
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

async function parseByLocalLlm(
    input: ChainInput
): Promise<SpatialIntentResult> {
    const propertyKeys = getSpatialPropertyKeys(input);
    try {
        const engine = await input.model.getEngine();
        const reply = await engine.chat.completions.create({
            stream: false,
            messages: [
                {
                    role: "system",
                    content:
                        "You are a geospatial query parser for Magda. " +
                        "Analyze the user question and decide whether it needs PostGIS GeoSQL spatial analysis. " +
                        "Also extract the reference anchor if one exists. " +
                        'Return JSON only: {"intent":"spatial|non-spatial|unknown","confidence":0-1,"reference_type":"internal|external|none","extraction":{},"reason":"..."}.\n\n' +
                        "Rules:\n" +
                        "- internal means the anchor is identified by one of existing_keys and a value in the current dataset.\n" +
                        "- external means the anchor is a real-world place name not expressed as an existing dataset field filter.\n" +
                        "- none means no specific anchor is needed.\n" +
                        '- If reference_type is internal, extraction MUST be {"key":"...","value":"..."} and key MUST exactly match one of existing_keys.\n' +
                        '- If reference_type is external, extraction MUST be {"place":"..."}.\n' +
                        "- Do not classify as internal just because a field name appears without a value.\n" +
                        "Requires GeoSQL: distance calculation, nearest/nearby search, containment/intersection, coordinate query, area/length calculation, geofence/radius filtering, map geometry operations.\n" +
                        "Does not require GeoSQL: simple attribute filtering, row counts, metadata/field questions, dataset description, greetings, general help."
                },
                {
                    role: "user",
                    content:
                        `Question: ${input.question}\n` +
                        `Existing keys: ${
                            propertyKeys.length
                                ? propertyKeys.slice(0, 40).join(", ")
                                : "N/A"
                        }\n` +
                        `Dataset metadata:\n${getDatasetMetadataSummary(
                            input
                        )}\n` +
                        `Geometry types: ${
                            getGeometryTypeSummary(input) || "N/A"
                        }`
                }
            ]
        });
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
                ? 0.7
                : 0.7;
        const reference = buildReferenceFromParser(parsed, propertyKeys);
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
