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
        /(most\s+(common|frequent|popular|often)|show\s+up\s+most|appear\s+most)/i.test(
            question
        ) ||
        /\bwhich\s+(?:the\s+)?(?:five|ten|\d+|\w+)\b[\s\S]{0,60}\b(?:most|often|frequent|common)\b/i.test(
            question
        ) ||
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

/** Tabular row listing — not top-N breakdown nor spatial result column phrasing ("show suburb, …"). */
export function questionImpliesDataListingIntent(question: string): boolean {
    const q = (question || "").toLowerCase();
    if (questionImpliesGroupedBreakdown(question)) {
        return false;
    }
    if (/(how many|number of|count of)/i.test(q)) {
        return false;
    }
    if (/\b(closest|nearest)\b/i.test(q) && /\bshow\b/i.test(q)) {
        return false;
    }
    if (/\bshow\s+up\b/i.test(q)) {
        return false;
    }
    return (
        /\b(list|display)\b/i.test(q) ||
        /\bshow\b(?!\s+up\b)/i.test(q) ||
        /\bfind\s+(the\s+)?(five|ten|\d+)\b/i.test(q) ||
        /\blist\s+feature\b/i.test(q)
    );
}

export function questionImpliesRowListing(question: string): boolean {
    return questionImpliesDataListingIntent(question);
}

/** Scalar COUNT with attribute filter — not GROUP BY (e.g. "how many zones have code R"). */
export function questionImpliesScalarFilterCount(question: string): boolean {
    if (!/(how many|number of|count of|多少|几个)/i.test(question)) {
        return false;
    }
    if (questionImpliesGroupedBreakdown(question)) {
        return false;
    }
    if (questionImpliesRowListing(question)) {
        return false;
    }
    if (questionImpliesGeomPredicateCount(question)) {
        return true;
    }
    if (questionImpliesDistinctCardinality(question)) {
        return true;
    }
    if (
        /(have|with|where|classified|equal|mentions?|labeled|tagged|on\s+a\s+street)/i.test(
            question
        )
    ) {
        return true;
    }
    return !/(per|each|by|group|top|most common|breakdown)/i.test(question);
}

export function questionImpliesSpatialComplex(question: string): boolean {
    return (
        /(nearest|closest|within\s+\d+\s*m|metres?\s+of|meters?\s+of|st_dwithin)/i.test(
            question
        ) ||
        /(smaller than|larger than|shorter than|longer than).{0,40}(average|mean)/i.test(
            question
        ) ||
        /(crossing|intersect|inside|contains)\b/i.test(question)
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
    if (
        /\b(shape_area|shape_leng)\b/i.test(question) &&
        /\b(total|sum|average|avg|typical|min|max|value)\b/i.test(q)
    ) {
        return true;
    }
    const mentionsPropertyField =
        /(sum|total|average|avg|min|max)\s+(the\s+)?[a-z0-9_]+\s+property\b/i.test(
            question
        ) ||
        /(sum|average|avg)\s+(the\s+)?[a-z0-9_]+\s+(property|field)\s+across/i.test(
            question
        );
    const mentionsGeomMetric =
        /(geodesic|geometry|geometries|geom\b|st_|perimeter|周长|footprint)/i.test(
            question
        ) ||
        (/(\bof all\b|\bcombined\b|\ball polygons\b|\ball features\b)/i.test(
            question
        ) &&
            /(area|length|perimeter|square metres?|square meters?)/i.test(
                question
            ) &&
            !/\b(shape_area|shape_leng)\b/i.test(question));
    return mentionsPropertyField && !mentionsGeomMetric;
}

/**
 * Scalar geom metric (SUM/AVG/MIN/MAX of ST_Area/Length/Perimeter), not "how many".
 */
export function questionImpliesGeomMeasurementAggregate(
    question: string
): boolean {
    if (/(how many|number of|count of|多少|几个)/i.test(question)) {
        return false;
    }
    if (questionImpliesPropertyAttributeAggregate(question)) {
        return false;
    }
    const q = question.toLowerCase();
    return (
        /\b(what is|what's|total|combined|sum of|average|typical|largest|smallest|longest|shortest|maximum|minimum|max|min|avg)\b/i.test(
            q
        ) &&
        /\b(area|length|perimeter|footprint|square metres?|square meters?|polygon size)\b/i.test(
            q
        )
    );
}

/** COUNT with geom predicate in WHERE (e.g. perimeter > 50m, ST_IsValid) — not a scalar measurement. */
export function questionImpliesGeomPredicateCount(question: string): boolean {
    if (!/(how many|number of|count of|多少|几个)/i.test(question)) {
        return false;
    }
    if (questionImpliesGeomMeasurementAggregate(question)) {
        return false;
    }
    if (questionImpliesAttributeWithinPhrase(question)) {
        return false;
    }
    const q = question.toLowerCase();
    if (
        /(development areas?|classified as|zone code|open space|commercial|residential|geometry type|each geometry)/i.test(
            q
        ) &&
        !/(st_|valid|invalid|larger than|smaller than|longer than|shorter than|\d+\s*(m|metres?|meters?))/i.test(
            q
        )
    ) {
        return false;
    }
    if (/(valid|invalid).{0,30}(geometr|geom|polygon)/i.test(q)) {
        return true;
    }
    if (
        /(perimeter|length).{0,50}(above|below|greater|less|longer|shorter|>|\d+\s*(m|metres?|meters?))/i.test(
            q
        )
    ) {
        return true;
    }
    if (
        /(larger|smaller|bigger).{0,40}(square metres?|square meters?|\d{4,})/i.test(
            q
        ) &&
        /(polygon|geograph|footprint)/i.test(q)
    ) {
        return true;
    }
    if (
        /(above|below|than).{0,30}(average|mean)/i.test(q) &&
        /(perimeter|length|area)/i.test(q)
    ) {
        return true;
    }
    if (
        /(valid|st_isvalid)/i.test(q) &&
        /(length|perimeter).{0,40}(above|>|greater|\d+)/i.test(q)
    ) {
        return true;
    }
    return false;
}

/** Whole-table cardinality (no attribute filter), e.g. "how many trees are in this dataset". */
export function questionImpliesDatasetWideCount(question: string): boolean {
    const q = (question || "").toLowerCase().trim();
    if (!/(how many|number of|count of|总数|多少|几个)/i.test(q)) {
        return false;
    }
    if (
        /\b(classified as|listed for|labeled as|where|with|having|equals|equal to|perimeter|valid|invalid|larger than|smaller than|longer than|shorter than|near|within\s+\d)/i.test(
            q
        )
    ) {
        return false;
    }
    return (
        /\b(in this dataset|in the dataset|in this layer|in the layer|in the table|are in this|polygons are in|trees are in|features are in|records in this|segments are in)\b/i.test(
            q
        ) ||
        /\bhow many\s+(?:[a-z]+\s+){0,4}(?:features?|records?|polygons?|trees?|segments?)\s+(?:are\s+)?(?:there\s+)?in\b/i.test(
            q
        )
    );
}

/** PostGIS operators for COUNT/WHERE on geometry (not scalar ST_Area aggregate). */
export function inferGeomPredicateOperatorFamily(
    question: string
): ("ST_IsValid" | "ST_Length" | "ST_Perimeter" | "ST_Area" | "ST_DWithin")[] {
    const q = (question || "").toLowerCase();
    const ops: (
        | "ST_IsValid"
        | "ST_Length"
        | "ST_Perimeter"
        | "ST_Area"
        | "ST_DWithin"
    )[] = [];
    if (/(invalid|not valid)/i.test(q)) {
        ops.push("ST_IsValid");
    } else if (
        /\bvalid\b/i.test(q) &&
        /(geometr|geom|segment|polygon|road|features?)/i.test(q)
    ) {
        ops.push("ST_IsValid");
    }
    if (/(perimeter|周长)/i.test(q)) {
        ops.push("ST_Perimeter");
    }
    if (
        /(length|longer than|shorter than|metres?|meters?)/i.test(q) &&
        !/(perimeter|周长)/i.test(q)
    ) {
        ops.push("ST_Length");
    }
    if (
        /(area|square metres?|square meters?|larger than|smaller than)/i.test(q)
    ) {
        ops.push("ST_Area");
    }
    return [...new Set(ops)];
}

/**
 * "Within residential land" / "within commercial zones" = attribute filter wording,
 * not PostGIS ST_Within topology.
 */
export function questionImpliesAttributeWithinPhrase(
    question: string
): boolean {
    const q = (question || "").toLowerCase();
    return (
        /\bwithin\s+(?:the\s+)?(?:(?:residential|commercial|industrial|mixed)\s+(?:land|zones?|areas?)|land\s+use)\b/i.test(
            q
        ) ||
        /\bwithin\s+(?:the\s+)?(?:residential|commercial|industrial)\b/i.test(q)
    );
}

/** True when the user asks for geometric topology (intersects / contains / inside), not attribute "within X". */
export function questionImpliesTopologicalSpatial(question: string): boolean {
    const q = (question || "").toLowerCase();
    if (questionImpliesAttributeWithinPhrase(question)) {
        return false;
    }
    if (/\bwithin\s+\d+/i.test(q)) {
        return false;
    }
    return (
        /\b(intersect|intersects|intersection|overlap|inside|contains|contained)\b/i.test(
            q
        ) ||
        /\bwithin\s+(?:the\s+)?(?:area|region|boundary|polygon|geometry|map|viewport)\b/i.test(
            q
        )
    );
}

/** LIMIT N from "show ten", "list five", "top 10", etc. */
export function extractListRowLimitFromQuestion(
    question: string
): number | undefined {
    const q = (question || "").trim();
    const patterns = [
        /\b(?:show|list|display|find)\s+(?:the\s+)?(five|ten|twenty|\d+)\b/i,
        /\b(?:top|first|nearest)\s+(\d+)\b/i,
        /\b(\d+)\s+(?:rows?|records?|features?|items?|trees?|segments?)\b/i
    ];
    const wordToNum: Record<string, number> = {
        five: 5,
        ten: 10,
        twenty: 20
    };
    for (const re of patterns) {
        const m = q.match(re);
        const raw = m?.[1]?.toLowerCase();
        if (!raw) {
            continue;
        }
        const n =
            wordToNum[raw] ??
            (Number.isInteger(Number(raw)) ? Number(raw) : NaN);
        if (Number.isFinite(n) && n > 0) {
            return Math.min(n, 100);
        }
    }
    return undefined;
}

export function inferScalarAggregateFnFromQuestion(
    question: string
): "SUM" | "AVG" | "MIN" | "MAX" {
    const q = (question || "").toLowerCase();
    if (/\b(total|combined|sum)\b/.test(q)) {
        return "SUM";
    }
    if (/\b(largest|maximum|max|longest)\b/.test(q)) {
        return "MAX";
    }
    if (/\b(smallest|minimum|min|shortest)\b/.test(q)) {
        return "MIN";
    }
    if (/\b(average|avg|typical|mean|median)\b/.test(q)) {
        return "AVG";
    }
    return "AVG";
}

/** MEASUREMENT on geometry: SUM/AVG/MIN/MAX(ST_Area|Length|Perimeter(geom::geography)). */
export function inferGeomMeasurementOperation(
    question: string
): { operator: string; alias: string } | null {
    const q = (question || "").toLowerCase();
    if (
        !/(area|length|perimeter|footprint|size|metres?|meters?|square)/i.test(
            q
        )
    ) {
        return null;
    }
    const fn = inferScalarAggregateFnFromQuestion(question);
    if (/(perimeter|周长)/i.test(q)) {
        return {
            operator: `${fn}(ST_Perimeter(geom::geography))`,
            alias: `${fn.toLowerCase()}_perim_m`
        };
    }
    if (
        /(length|longer|shorter|segment length)/i.test(q) &&
        !/(area|footprint|square)/i.test(q)
    ) {
        return {
            operator: `${fn}(ST_Length(geom::geography))`,
            alias: `${fn.toLowerCase()}_len_m`
        };
    }
    return {
        operator: `${fn}(ST_Area(geom::geography))`,
        alias: `${fn.toLowerCase()}_area_m2`
    };
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
    if (questionImpliesScalarFilterCount(question)) {
        return [];
    }
    if (questionImpliesRowListing(question)) {
        return [];
    }

    const keys = new Set<string>();

    if (/\bzone\s+codes?\b/i.test(question) && propertyKeys.includes("zone")) {
        keys.add("zone");
    }
    if (
        /\bdevelopment\s+plan\s+codes?\b/i.test(question) &&
        propertyKeys.includes("devplan_co")
    ) {
        keys.add("devplan_co");
    }
    if (
        /\bdevelopment\s+categor/i.test(question) &&
        propertyKeys.includes("dev_catego")
    ) {
        keys.add("dev_catego");
    }

    const patterns: RegExp[] = [
        /\b(?:group\s+by|grouped\s+by)\s+([a-z0-9_]+)\b/i,
        /\b(?:per|by|each|for\s+each)\s+([a-z0-9_\s]{2,40}?)(?:\s*[,.?]|$)/i,
        /\b(?:in\s+each)\s+([a-z0-9_\s]{2,40}?)(?:\s*[,.?]|$)/i,
        /(?:按|每个|各(?:个)?|每一(?:个)?)([^\s，。]{2,24}?)(?:的|统计|分组|计算|数量)/u,
        /most\s+(?:common|frequent|popular|often)\s+([a-z0-9_\s]+?)(?:\s+(?:codes?|categories|types?|by)|[,.?]|$)/i,
        /top\s+(?:five|ten|\d+|\w+)\s+(?:most\s+)?(?:common|frequent)?\s*([a-z0-9_\s]+?)(?:\s+by|[,.?]|$)/i,
        /\blist\s+(?:the\s+)?(?:five|ten|\d+)\s+(?:most\s+)?(?:common|frequent)\s+([a-z0-9_\s]+?)(?:\s+by|[,.?]|$)/i,
        /\bwhich\s+(?:five|ten|\d+|\w+)\s+([a-z0-9_\s]+?)\s+(?:show\s+up|appear)\s+most/i
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
    if (
        /\bzone\s+code\b/i.test(question) &&
        /(how many|have|with)\b/i.test(question) &&
        !/(most|top|per|each|group)/i.test(question)
    ) {
        keys.delete("zone");
    }

    if (
        /tree\s+maintenance\s+areas?|maintenance\s+areas?/i.test(question) &&
        propertyKeys.includes("treearea")
    ) {
        keys.add("treearea");
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
