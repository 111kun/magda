import {
    inferGeomPredicateOperatorFamily,
    questionImpliesDatasetWideCount,
    questionImpliesGeomMeasurementAggregate,
    questionImpliesGeomPredicateCount,
    questionImpliesGroupedBreakdown,
    questionImpliesPropertyAttributeAggregate,
    questionImpliesTopologicalSpatial
} from "./geoQueryQuestionPatterns";
import { inferSemanticFiltersFromQuestion } from "./columnSemanticHints";

type ValueSamplesByKey = Record<
    string,
    {
        mode: "full" | "partial";
        values: string[];
        approxDistinct?: number;
    }
>;

export type ScopeBoundFilter = {
    key: string;
    value: string;
    confidence: number;
    source: "explicit_key" | "value_sample" | "semantic_hint";
    matchOp?: "eq" | "ilike";
};

export type SpatialIntentDetail = {
    type:
        | "none"
        | "topological"
        | "distance_buffer"
        | "nearest_neighbor"
        | "measurement"
        | "geom_predicate";
    operatorFamily?: (
        | "ST_DWithin"
        | "KNN_<->"
        | "ST_Intersects"
        | "ST_Contains"
        | "ST_Within"
        | "ST_Area"
        | "ST_Length"
        | "ST_Perimeter"
        | "ST_IsValid"
    )[];
    parameters?: {
        distance_meters?: number;
        limit?: number;
    };
    anchor?: {
        type:
            | "internal_feature"
            | "external_poi"
            | "implicit_bounds"
            | "unknown";
        value: string;
        isResolved: boolean;
        coordinates?: [number, number];
    };
};

export type GeoQueryScope = {
    intentType: "count" | "list" | "aggregate" | "spatial" | "unknown";
    spatialIntent: SpatialIntentDetail;
    boundFilters: ScopeBoundFilter[];
    datasetScopeMentions: string[];
    unmatchedTokens: string[];
    needsExternalReference: boolean;
    externalPlace?: string;
    reasoningTrace: string[];
};

function norm(input: string): string {
    return (input || "").toLowerCase().replace(/\s+/g, " ").trim();
}

function escapeRegExp(input: string): string {
    return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Split normalized question text into word-like tokens (no substring matching). */
function tokenizeQuestion(text: string): string[] {
    return text
        .split(/[^a-z0-9\u4e00-\u9fff]+/g)
        .map((t) => t.trim())
        .filter((t) => t.length > 0);
}

/**
 * True when the question mentions `valueNorm` as a whole token or consecutive
 * token phrase — e.g. zone code R matches token "r", not the "r" inside "for".
 */
/** English tokens that must not bind value_sample (e.g. zone=In from "loaded in PostGIS"). */
const VALUE_SAMPLE_STOP_TOKENS = new Set([
    "in",
    "on",
    "or",
    "is",
    "as",
    "at",
    "to",
    "of",
    "an",
    "the",
    "be",
    "by",
    "it",
    "no",
    "so",
    "if",
    "up",
    "for",
    "and",
    "are",
    "was",
    "has",
    "had",
    "how",
    "any",
    "all",
    "per",
    "sum",
    "avg",
    "max",
    "min",
    "top",
    "use",
    "who",
    "what",
    "when",
    "where",
    "which",
    "this",
    "that",
    "with",
    "from",
    "have",
    "into",
    "loaded",
    "postgis",
    "dataset",
    "data",
    "feature",
    "features",
    "zone",
    "zones",
    "code",
    "plan",
    "land",
    "development",
    "count",
    "total",
    "number",
    "many",
    "most",
    "least",
    "common",
    "frequent",
    "across",
    "property",
    "properties",
    "field",
    "numeric",
    "phrase",
    "containing",
    "square",
    "meters",
    "geodesic",
    "geometry",
    "geometries",
    "polygon",
    "polygons"
]);

const SINGLE_TOKEN_VALUE_SAMPLE_MIN_LEN = 3;

function shouldSkipValueSampleBinding(valueNorm: string): boolean {
    const tokens = tokenizeQuestion(valueNorm);
    if (!tokens.length) {
        return true;
    }
    if (tokens.length === 1) {
        const t = tokens[0];
        if (t.length < SINGLE_TOKEN_VALUE_SAMPLE_MIN_LEN) {
            return true;
        }
        if (VALUE_SAMPLE_STOP_TOKENS.has(t)) {
            return true;
        }
    }
    return false;
}

/** Key name appears as a bare word in the question (e.g. key `street` + "street trees"). */
function questionMentionsPropertyKeyAsWord(
    propertyKey: string,
    qNorm: string,
    qTokens: string[]
): boolean {
    const keyPhrase = norm(propertyKey).replace(/_/g, " ");
    const keyTokens = tokenizeQuestion(keyPhrase);
    if (keyTokens.length === 1) {
        return qTokens.includes(keyTokens[0]);
    }
    if (keyTokens.length >= 2) {
        return questionMentionsValueAsWords(qNorm, keyPhrase);
    }
    return false;
}

function valueSampleTokenCount(valueNorm: string): number {
    return tokenizeQuestion(valueNorm).length;
}

type TokenSpan = { start: number; len: number };

function findValueTokenSpan(
    qTokens: string[],
    valueNorm: string
): TokenSpan | null {
    const valueTokens = tokenizeQuestion(valueNorm);
    if (!valueTokens.length) {
        return null;
    }
    if (valueTokens.length === 1) {
        const idx = qTokens.indexOf(valueTokens[0]);
        return idx >= 0 ? { start: idx, len: 1 } : null;
    }
    const n = valueTokens.length;
    for (let i = 0; i <= qTokens.length - n; i++) {
        let matched = true;
        for (let j = 0; j < n; j++) {
            if (qTokens[i + j] !== valueTokens[j]) {
                matched = false;
                break;
            }
        }
        if (matched) {
            return { start: i, len: n };
        }
    }
    return null;
}

function isStrictSubSpan(inner: TokenSpan, outer: TokenSpan): boolean {
    return (
        inner.len < outer.len &&
        inner.start >= outer.start &&
        inner.start + inner.len <= outer.start + outer.len
    );
}

/** Drop shorter value bindings whose tokens are subsumed by a longer phrase (e.g. Doncaster vs Doncaster East). */
function pruneSubsumedBoundFilters(
    filters: ScopeBoundFilter[],
    qNorm: string
): ScopeBoundFilter[] {
    const qTokens = tokenizeQuestion(qNorm);
    const withSpan = filters
        .map((f) => ({
            f,
            span: findValueTokenSpan(qTokens, norm(f.value))
        }))
        .sort((a, b) => (b.span?.len || 0) - (a.span?.len || 0));

    const kept: typeof withSpan = [];
    for (const item of withSpan) {
        if (!item.span) {
            kept.push(item);
            continue;
        }
        if (kept.some((k) => k.span && isStrictSubSpan(item.span!, k.span!))) {
            continue;
        }
        kept.push(item);
    }
    return kept.map((x) => x.f);
}

export function questionMentionsValueAsWords(
    qNorm: string,
    valueNorm: string
): boolean {
    const normalizedValue = norm(valueNorm);
    if (!normalizedValue) {
        return false;
    }
    const valueTokens = tokenizeQuestion(normalizedValue);
    if (!valueTokens.length) {
        return false;
    }
    const qTokens = tokenizeQuestion(qNorm);
    if (!qTokens.length) {
        return false;
    }
    if (valueTokens.length === 1) {
        return qTokens.includes(valueTokens[0]);
    }
    const n = valueTokens.length;
    for (let i = 0; i <= qTokens.length - n; i++) {
        let matched = true;
        for (let j = 0; j < n; j++) {
            if (qTokens[i + j] !== valueTokens[j]) {
                matched = false;
                break;
            }
        }
        if (matched) {
            return true;
        }
    }
    return false;
}

function applySemanticHintsToBoundFilters(
    question: string,
    propertyKeys: string[],
    dedup: Map<string, ScopeBoundFilter>
): void {
    const semantic = inferSemanticFiltersFromQuestion(question, propertyKeys);
    if (!semantic.length) {
        return;
    }

    const semKeys = new Set(semantic.map((s) => s.physicalKey));
    for (const key of [...dedup.keys()]) {
        const entry = dedup.get(key);
        if (!entry) {
            continue;
        }
        if (semKeys.has(entry.key)) {
            dedup.delete(key);
        }
    }
    if (semantic.some((s) => s.physicalKey === "dev_catego")) {
        for (const key of [...dedup.keys()]) {
            const entry = dedup.get(key);
            if (
                entry &&
                entry.key !== "dev_catego" &&
                /^(commercial|residential|open\s*space|industrial)$/i.test(
                    norm(entry.value)
                )
            ) {
                dedup.delete(key);
            }
        }
    }
    if (
        semantic.some((s) => s.physicalKey === "zone_meani" && s.op === "ILIKE")
    ) {
        for (const key of [...dedup.keys()]) {
            const entry = dedup.get(key);
            if (entry?.key === "zone_meani") {
                dedup.delete(key);
            }
        }
    }

    for (const sf of semantic) {
        const mapKey = `${sf.physicalKey}::${norm(sf.value)}`;
        dedup.set(mapKey, {
            key: sf.physicalKey,
            value: sf.value,
            confidence: 0.96,
            source: "semantic_hint",
            matchOp: sf.op === "ILIKE" ? "ilike" : "eq"
        });
    }
}

function detectIntentType(question: string): GeoQueryScope["intentType"] {
    const q = norm(question);
    if (!q) {
        return "unknown";
    }
    if (
        /(how many|number of|count of|总数|多少|几个|几条|计数|count\()/i.test(
            q
        )
    ) {
        return "count";
    }
    if (
        /(near|nearby|nearest|closest|distance|附近|最近|距离|半径|周边)/i.test(
            q
        ) ||
        (/within/i.test(q) &&
            !/within\s+(residential|commercial|industrial|open\s+space|land)\b/i.test(
                q
            ) &&
            /(metres?|meters?|m\b|\d|distance|buffer|radius|of\s+(any|the)\s+)/i.test(
                q
            ))
    ) {
        return "spatial";
    }
    if (questionImpliesGroupedBreakdown(question)) {
        return "aggregate";
    }
    if (
        /(which|what)\s+.+\s+(has|have|contains)\s+(the\s+)?(most|least|fewest|more|fewer)/i.test(
            q
        ) ||
        /(top\s*\d+|bottom\s*\d+|rank|ranking|排名|前几|后几)/i.test(q) ||
        /(group by|sum|avg|min|max|aggregate|聚合|分组|平均|合计)/i.test(q) ||
        /(per\b|broken down|breakdown|proportion|ratio|rate|占比|百分比)/i.test(
            q
        )
    ) {
        return "aggregate";
    }
    if (
        /(list|find|get|where|筛选|过滤|查询|列出|显示|哪些|有哪些)/i.test(q) &&
        !/\bshow\s+up\b/i.test(q) &&
        !/(closest|nearest)\b/.test(q)
    ) {
        return "list";
    }
    if (/\bshow\b/i.test(q) && !/\bshow\s+up\b/i.test(q)) {
        return "list";
    }
    return "unknown";
}

function extractDistanceMeters(question: string): number | undefined {
    const match = (question || "").match(
        /(?:距离|周边|附近|within|radius|buffer)?\s*(\d+(?:\.\d+)?)\s*(km|m|公里|千米|米)\b/i
    );
    if (!match?.[1] || !match?.[2]) {
        return undefined;
    }
    const value = Number(match[1]);
    if (!Number.isFinite(value) || value <= 0) {
        return undefined;
    }
    const unit = match[2].toLowerCase();
    return unit === "km" || unit === "公里" || unit === "千米"
        ? value * 1000
        : value;
}

function extractLimit(question: string): number | undefined {
    const match = (question || "").match(
        /(?:最近的|离我最近|前|top|nearest)\s*(\d+)\s*(?:个|条|items?)?/i
    );
    if (!match?.[1]) {
        return undefined;
    }
    const n = Number(match[1]);
    if (!Number.isInteger(n) || n <= 0) {
        return undefined;
    }
    return Math.min(n, 100);
}

function inferExternalPlace(question: string): string | undefined {
    const q = (question || "").trim();
    if (!q) return undefined;
    const en = q.match(
        /\b(?:near|nearby to|closest to|nearest to|within)\s+(.+?)$/i
    );
    if (en?.[1]) {
        return en[1].trim().replace(/[.,!?]+$/g, "");
    }
    const zh = q.match(/(?:在|离)?(.+?)(?:附近|周边|最近|距离)/);
    if (zh?.[1]) {
        return zh[1].trim().replace(/[，。！？?]+$/g, "");
    }
    return undefined;
}

function classifySpatialIntent(question: string): SpatialIntentDetail {
    const q = norm(question);
    const distanceMeters = extractDistanceMeters(question);
    const limit = extractLimit(question);
    const hasNearest =
        /(nearest|closest|最近|最近的|离我最近)/i.test(q) || !!limit;
    const hasTopo = questionImpliesTopologicalSpatial(question);
    const hasMeasure =
        /\b(area|length|footprint|perimeter|周长)\b/i.test(q) ||
        /\b(square metres?|square meters?)\b/i.test(q);

    if (questionImpliesPropertyAttributeAggregate(question)) {
        return { type: "none" };
    }
    if (questionImpliesGeomMeasurementAggregate(question)) {
        const operatorFamily: NonNullable<
            SpatialIntentDetail["operatorFamily"]
        > = /(perimeter|周长)/i.test(question)
            ? ["ST_Perimeter", "ST_Area", "ST_Length"]
            : ["ST_Area", "ST_Length", "ST_Perimeter"];
        return {
            type: "measurement",
            operatorFamily
        };
    }
    if (questionImpliesGeomPredicateCount(question)) {
        const operatorFamily = inferGeomPredicateOperatorFamily(question);
        return {
            type: "geom_predicate",
            operatorFamily: operatorFamily.length
                ? operatorFamily
                : ["ST_IsValid", "ST_Length", "ST_Perimeter"]
        };
    }
    if (hasMeasure) {
        const operatorFamily: NonNullable<
            SpatialIntentDetail["operatorFamily"]
        > = /(perimeter|周长)/i.test(question)
            ? ["ST_Perimeter", "ST_Area", "ST_Length"]
            : ["ST_Area", "ST_Length", "ST_Perimeter"];
        return {
            type: "measurement",
            operatorFamily
        };
    }
    if (hasNearest) {
        return {
            type: "nearest_neighbor",
            operatorFamily: ["KNN_<->"],
            parameters: limit ? { limit } : {}
        };
    }
    if (distanceMeters) {
        return {
            type: "distance_buffer",
            operatorFamily: ["ST_DWithin"],
            parameters: { distance_meters: distanceMeters }
        };
    }
    if (hasTopo) {
        return {
            type: "topological",
            operatorFamily: ["ST_Intersects", "ST_Contains", "ST_Within"]
        };
    }
    return { type: "none" };
}

export function extractGeoQueryScope(input: {
    question: string;
    propertyKeys: string[];
    valueSamplesByKey: ValueSamplesByKey;
    datasetScopeTerms: string[];
}): GeoQueryScope {
    const question = input.question || "";
    const qNorm = norm(question);
    const reasoningTrace: string[] = [];
    const intentType = detectIntentType(question);
    reasoningTrace.push(`intent=${intentType}`);
    const spatialIntent = classifySpatialIntent(question);
    reasoningTrace.push(`spatial_intent=${spatialIntent.type}`);
    if (
        spatialIntent.type === "geom_predicate" &&
        spatialIntent.operatorFamily?.length
    ) {
        reasoningTrace.push(
            `geom_predicate_ops=${spatialIntent.operatorFamily.join(",")}`
        );
    }

    const boundFilters: ScopeBoundFilter[] = [];
    const matchedValueNorms = new Set<string>();
    const qTokens = tokenizeQuestion(qNorm);
    const skipValueSampleBinding = questionImpliesDatasetWideCount(question);
    if (skipValueSampleBinding) {
        reasoningTrace.push("value_sample_skipped=dataset_wide_count");
    }

    for (const key of input.propertyKeys || []) {
        const keyNorm = norm(key);
        if (!keyNorm) continue;
        const patterns = [
            new RegExp(
                `\\b${escapeRegExp(
                    keyNorm
                )}\\b\\s*(?:=|:|is|equals|为|是)\\s*["']?([^"',，。;；?？]+)`,
                "i"
            ),
            new RegExp(
                `\\b(?:in|at|for|within)\\s+${escapeRegExp(
                    keyNorm
                )}\\s+["']?([^"',，。;；?？]+)`,
                "i"
            )
        ];
        for (const pattern of patterns) {
            const match = qNorm.match(pattern);
            const value = match?.[1]?.trim();
            if (value) {
                boundFilters.push({
                    key,
                    value,
                    confidence: 0.94,
                    source: "explicit_key"
                });
                matchedValueNorms.add(norm(value));
                reasoningTrace.push(`explicit_key_match:${key}=${value}`);
                break;
            }
        }
    }

    if (!skipValueSampleBinding) {
        Object.entries(input.valueSamplesByKey || {}).forEach(
            ([key, profile]) => {
                const sortedValues = [...(profile?.values || [])].sort(
                    (a, b) =>
                        valueSampleTokenCount(norm(b)) -
                        valueSampleTokenCount(norm(a))
                );
                let bestMatch: {
                    rawValue: string;
                    valueNorm: string;
                    tokenCount: number;
                } | null = null;

                for (const rawValue of sortedValues) {
                    const valueNorm = norm(rawValue);
                    if (!valueNorm || matchedValueNorms.has(valueNorm)) {
                        continue;
                    }
                    if (shouldSkipValueSampleBinding(valueNorm)) {
                        continue;
                    }
                    if (!questionMentionsValueAsWords(qNorm, valueNorm)) {
                        continue;
                    }
                    const tokenCount = valueSampleTokenCount(valueNorm);
                    if (
                        questionMentionsPropertyKeyAsWord(
                            key,
                            qNorm,
                            qTokens
                        ) &&
                        tokenCount === 1
                    ) {
                        continue;
                    }
                    bestMatch = { rawValue, valueNorm, tokenCount };
                    break;
                }

                if (bestMatch) {
                    boundFilters.push({
                        key,
                        value: bestMatch.rawValue,
                        confidence: profile.mode === "full" ? 0.9 : 0.72,
                        source: "value_sample"
                    });
                    matchedValueNorms.add(bestMatch.valueNorm);
                    reasoningTrace.push(
                        `value_sample_word_match:${key}=${bestMatch.rawValue}`
                    );
                }
            }
        );
    }

    const dedup = new Map<string, ScopeBoundFilter>();
    for (const item of boundFilters) {
        const mapKey = `${item.key}::${norm(item.value)}`;
        const existing = dedup.get(mapKey);
        if (!existing || item.confidence > existing.confidence) {
            dedup.set(mapKey, item);
        }
    }
    let finalBoundFilters = [...dedup.values()];
    const beforePrune = finalBoundFilters.length;
    finalBoundFilters = pruneSubsumedBoundFilters(finalBoundFilters, qNorm);
    if (finalBoundFilters.length < beforePrune) {
        reasoningTrace.push(
            `value_sample_pruned_subsumed=${
                beforePrune - finalBoundFilters.length
            }`
        );
    }

    applySemanticHintsToBoundFilters(question, input.propertyKeys, dedup);
    finalBoundFilters = [...dedup.values()];
    finalBoundFilters = pruneSubsumedBoundFilters(finalBoundFilters, qNorm);

    const datasetScopeMentions = (input.datasetScopeTerms || [])
        .map((term) => norm(term))
        .filter(
            (term) =>
                !!term &&
                (term.includes(" ")
                    ? questionMentionsValueAsWords(qNorm, term)
                    : qTokens.includes(term))
        )
        .slice(0, 12);

    const externalPlace = inferExternalPlace(question);
    const externalPlaceNorm = externalPlace ? norm(externalPlace) : "";
    const externalLooksBound =
        !!externalPlaceNorm && matchedValueNorms.has(externalPlaceNorm);
    const hasProximityCue = spatialIntent.type !== "none";
    const hasInternalStreetAnchor =
        spatialIntent.type === "nearest_neighbor" &&
        finalBoundFilters.some(
            (f) => f.key === "street" || f.key === "str_type"
        );
    let needsExternalReference =
        hasProximityCue &&
        !!externalPlaceNorm &&
        !externalLooksBound &&
        !datasetScopeMentions.includes(externalPlaceNorm);
    if (hasInternalStreetAnchor) {
        needsExternalReference = false;
    }

    reasoningTrace.push(
        needsExternalReference
            ? `external_ref=${externalPlaceNorm}`
            : "external_ref=none"
    );

    if (spatialIntent.type !== "none") {
        if (
            /(this area|current area|current map|viewport|this region|这个区域|当前范围|当前视野)/i.test(
                qNorm
            )
        ) {
            spatialIntent.anchor = {
                type: "implicit_bounds",
                value: "current_viewport",
                isResolved: false
            };
        } else if (finalBoundFilters.length) {
            const first = finalBoundFilters[0];
            spatialIntent.anchor = {
                type: "internal_feature",
                value: `${first.key}=${first.value}`,
                isResolved: false
            };
        } else if (needsExternalReference && externalPlace) {
            spatialIntent.anchor = {
                type: "external_poi",
                value: externalPlace,
                isResolved: false
            };
        } else {
            spatialIntent.anchor = {
                type: "unknown",
                value: "",
                isResolved: false
            };
        }
    }

    const tokenSet = new Set(
        qNorm
            .split(/[^a-z0-9\u4e00-\u9fff]+/g)
            .map((t) => t.trim())
            .filter((t) => t.length >= 2)
    );
    input.propertyKeys.forEach((k) => tokenSet.delete(norm(k)));
    matchedValueNorms.forEach((v) => tokenSet.delete(v));
    datasetScopeMentions.forEach((t) => tokenSet.delete(t));

    return {
        intentType,
        spatialIntent,
        boundFilters: finalBoundFilters,
        datasetScopeMentions,
        unmatchedTokens: [...tokenSet].slice(0, 20),
        needsExternalReference,
        externalPlace: needsExternalReference ? externalPlace : undefined,
        reasoningTrace
    };
}
