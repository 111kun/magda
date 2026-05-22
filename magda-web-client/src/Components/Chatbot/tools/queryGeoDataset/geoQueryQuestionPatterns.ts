/**
 * Shared question-shape heuristics for task-spec and scope (dataset-agnostic).
 */

function normToken(s: string): string {
    return (s || "").toLowerCase().replace(/\s+/g, " ").trim();
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

export function questionImpliesGroupedBreakdown(question: string): boolean {
    return (
        /(most\s+(common|frequent|popular)|top\s+\d+|top\s+(five|ten|twenty|\d+))/i.test(
            question
        ) ||
        /\b(list|show)\s+(the\s+)?(five|ten|\d+)\s+(most|common|frequent)/i.test(
            question
        ) ||
        /(group\s*by|grouped\s+by)/i.test(question) ||
        /(per|by|each)\s+[a-z0-9_\s]{2,30}\s+(by|with|and)\s+(count|number)/i.test(
            question
        ) ||
        /(按|每个|各).*(分组|统计|数量|计数)/u.test(question) ||
        /(排名|前\s*\d+\s*名|前\s*(五|十))/u.test(question)
    );
}

export function questionImpliesRowListing(question: string): boolean {
    if (questionImpliesGroupedBreakdown(question)) {
        return false;
    }
    return (
        /\b(list|show|display|find)\s+(the\s+)?(five|ten|\d+|all)\b/i.test(
            question
        ) || /\blist\s+feature\b/i.test(question)
    );
}

export function questionImpliesDistinctCardinality(question: string): boolean {
    return (
        /\b(distinct|unique|different)\b/i.test(question) ||
        /how many\s+distinct/i.test(question) ||
        /多少.*(不同|种|类)/u.test(question)
    );
}

/** Property-only numeric aggregate (no geom metric), e.g. sum shape_Area property. */
export function questionImpliesPropertyAttributeAggregate(
    question: string
): boolean {
    const q = question.toLowerCase();
    const mentionsPropertyField =
        /\b(shape_area|shape_leng)\b/.test(q) ||
        /(sum|total|average|avg|min|max)\s+(the\s+)?[a-z0-9_]+\s+property\b/i.test(
            question
        ) ||
        /(sum|average|avg)\s+(the\s+)?[a-z0-9_]+\s+(property|field)\s+across/i.test(
            question
        );
    const mentionsGeomMetric =
        /(geodesic|geometry|geometries|geom\b|st_|perimeter|周长)/i.test(
            question
        ) ||
        /(total|sum|avg).{0,25}(area|length|perimeter).{0,25}(of all|combined|all features)/i.test(
            question
        );
    return mentionsPropertyField && !mentionsGeomMetric;
}

/** COUNT with geom predicate in WHERE (e.g. perimeter > 50m, ST_IsValid) — not a geom measurement aggregate. */
export function questionImpliesGeomPredicateCount(question: string): boolean {
    return (
        /(how many|number of|count of|多少|几个)/i.test(question) &&
        /(perimeter|length|area|geodesic|st_|valid|geometry|geometries|geom\b|周长|面积)/i.test(
            question
        )
    );
}

export function inferDistinctCountKey(
    question: string,
    propertyKeys: string[]
): string | undefined {
    const phraseMatch = question.match(
        /distinct\s+([a-z0-9_\s]+?)(?:\s+(?:codes?|types?|values?|zones?|categories|appear|in))/i
    );
    if (phraseMatch?.[1]) {
        const matched = matchPropertyKeyFromHint(phraseMatch[1], propertyKeys);
        if (matched) {
            return matched;
        }
    }
    for (const key of propertyKeys) {
        const keyPattern = key.replace(/_/g, "[_\\s]*");
        if (
            new RegExp(`\\bdistinct\\s+${keyPattern}\\b`, "i").test(question) ||
            new RegExp(`\\bdistinct\\s+[\\w\\s]*${keyPattern}`, "i").test(
                question
            )
        ) {
            return key;
        }
    }
    return undefined;
}

export function inferGroupByKeysFromQuestionEnhanced(
    question: string,
    propertyKeys: string[]
): string[] {
    const keys = new Set<string>();

    const patterns: RegExp[] = [
        /\b(?:group\s+by|grouped\s+by)\s+([a-z0-9_]+)\b/i,
        /\b(?:per|by|each|for\s+each)\s+([a-z0-9_\s]{2,40}?)(?:\s*[,.?]|$)/i,
        /\b(?:in\s+each)\s+([a-z0-9_\s]{2,40}?)(?:\s*[,.?]|$)/i,
        /(?:按|每个|各(?:个)?|每一(?:个)?)([^\s，。]{2,24}?)(?:的|统计|分组|计算|数量)/u,
        /most\s+(?:common|frequent|popular)\s+([a-z0-9_\s]+?)(?:\s+(?:codes?|categories|types?|by)|[,.?]|$)/i,
        /top\s+(?:five|ten|\d+|\w+)\s+(?:most\s+)?(?:common|frequent)?\s*([a-z0-9_\s]+?)(?:\s+by|[,.?]|$)/i,
        /\blist\s+(?:the\s+)?(?:five|ten|\d+)\s+(?:most\s+)?(?:common|frequent)\s+([a-z0-9_\s]+?)(?:\s+by|[,.?]|$)/i
    ];
    for (const re of patterns) {
        const m = question.match(re);
        const raw = m?.[1]?.trim();
        if (!raw) {
            continue;
        }
        const matched = matchPropertyKeyFromHint(raw, propertyKeys);
        if (matched) {
            keys.add(matched);
        }
    }

    for (const key of propertyKeys) {
        const keyNorm = key.replace(/_/g, "[_\\s]*");
        if (
            new RegExp(
                `\\b${keyNorm}\\s+(codes?|categories|types?)\\b`,
                "i"
            ).test(question) ||
            new RegExp(`(?:common|frequent|per|by)\\s+${keyNorm}\\b`, "i").test(
                question
            )
        ) {
            keys.add(key);
        }
    }

    return [...keys].slice(0, 6);
}

const PROPERTY_AGG_RE = /\b(sum|total|average|avg|min|max)\s+(?:the\s+)?([a-z0-9_]+)(?:\s+property|\s+field|\s+across|\s+of\b)/i;

/** Scalar SUM/AVG/MIN/MAX on a JSONB property (not geom ST_*). */
export function inferPropertyAggregateOperation(
    question: string,
    propertyKeys: string[]
): { fn: string; key: string } | null {
    const m = question.match(PROPERTY_AGG_RE);
    if (!m?.[1] || !m[2]) {
        return null;
    }
    const fn = m[1].toLowerCase() === "total" ? "SUM" : m[1].toUpperCase();
    const key = matchPropertyKeyFromHint(m[2], propertyKeys);
    if (!key) {
        return null;
    }
    return { fn: fn === "AVERAGE" ? "AVG" : fn, key };
}
