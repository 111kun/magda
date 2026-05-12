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
    source: "explicit_key" | "value_sample";
};

export type SpatialIntentDetail = {
    type:
        | "none"
        | "topological"
        | "distance_buffer"
        | "nearest_neighbor"
        | "measurement";
    operatorFamily?: (
        | "ST_DWithin"
        | "KNN_<->"
        | "ST_Intersects"
        | "ST_Contains"
        | "ST_Within"
        | "ST_Area"
        | "ST_Length"
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
        /(near|nearby|nearest|closest|within|distance|附近|最近|距离|半径|周边)/i.test(
            q
        )
    ) {
        return "spatial";
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
        /(show|list|find|get|where|筛选|过滤|查询|列出|显示|哪些|有哪些)/i.test(
            q
        )
    ) {
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
    const hasTopo = /(intersect|intersects|inside|within(?!\s*\d)|contain|contains|相交|包含|在.*里面|在.*内)/i.test(
        q
    );
    const hasMeasure = /(area|length|面积|多大|有多长|周长)/i.test(q);

    if (hasMeasure) {
        return {
            type: "measurement",
            operatorFamily: ["ST_Area", "ST_Length"]
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

    const boundFilters: ScopeBoundFilter[] = [];
    const matchedValueNorms = new Set<string>();

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

    Object.entries(input.valueSamplesByKey || {}).forEach(([key, profile]) => {
        for (const rawValue of profile?.values || []) {
            const valueNorm = norm(rawValue);
            if (!valueNorm || matchedValueNorms.has(valueNorm)) {
                continue;
            }
            if (qNorm.includes(valueNorm)) {
                boundFilters.push({
                    key,
                    value: rawValue,
                    confidence: profile.mode === "full" ? 0.9 : 0.72,
                    source: "value_sample"
                });
                matchedValueNorms.add(valueNorm);
                reasoningTrace.push(`value_sample_match:${key}=${rawValue}`);
                break;
            }
        }
    });

    const dedup = new Map<string, ScopeBoundFilter>();
    for (const item of boundFilters) {
        const mapKey = `${item.key}::${norm(item.value)}`;
        const existing = dedup.get(mapKey);
        if (!existing || item.confidence > existing.confidence) {
            dedup.set(mapKey, item);
        }
    }
    const finalBoundFilters = [...dedup.values()];

    const datasetScopeMentions = (input.datasetScopeTerms || [])
        .map((term) => norm(term))
        .filter((term) => !!term && qNorm.includes(term))
        .slice(0, 12);

    const externalPlace = inferExternalPlace(question);
    const externalPlaceNorm = externalPlace ? norm(externalPlace) : "";
    const externalLooksBound =
        !!externalPlaceNorm && matchedValueNorms.has(externalPlaceNorm);
    const hasProximityCue = spatialIntent.type !== "none";
    const needsExternalReference =
        hasProximityCue &&
        !!externalPlaceNorm &&
        !externalLooksBound &&
        !datasetScopeMentions.includes(externalPlaceNorm);

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
