import { inferSemanticFiltersFromQuestion } from "./columnSemanticHints";
import {
    extractListRowLimitFromQuestion,
    inferGroupByKeysFromQuestionEnhanced,
    questionImpliesDistinctCardinality,
    questionImpliesGeomPredicateCount,
    questionImpliesGroupedBreakdown,
    questionImpliesPropertyAttributeAggregate,
    questionImpliesRowListing,
    questionImpliesScalarFilterCount,
    questionImpliesSpatialComplex,
    matchPropertyKeyFromHint
} from "./geoQueryQuestionPatterns";
import type {
    ExecutionTargetPattern,
    GeoQueryTaskSpec,
    SchemaColumnBinding
} from "./geoQueryTaskInterpreter";

export type AstFilter = {
    physicalKey: string;
    sqlAccess: string;
    op: "=" | "ILIKE" | "RAW";
    value: string;
};

export type AstSelectColumn = {
    expression: string;
    alias: string;
};

export type AstOrderColumn = {
    expression: string;
    direction: "ASC" | "DESC";
};

export type ExecutableAst = {
    queryType: ExecutionTargetPattern;
    filters: AstFilter[];
    selectColumns: AstSelectColumn[];
    grouping: string[];
    aggregate?: { expression: string; alias: string };
    orderBy: AstOrderColumn[];
    limit?: number;
    measurement?: { expression: string; alias: string };
    geomWhereExtras: string[];
    nonEmptyKeys: string[];
};

const DETERMINISTIC_QUERY_TYPES = new Set<ExecutionTargetPattern>([
    "FILTER_COUNT",
    "LIST_ROWS",
    "AGGREGATE_GROUP_BY",
    "MEASUREMENT"
]);

export function isDeterministicRenderablePattern(
    pattern: ExecutionTargetPattern
): boolean {
    return DETERMINISTIC_QUERY_TYPES.has(pattern);
}

export function shouldUseDeterministicRenderer(
    taskSpec: GeoQueryTaskSpec,
    question: string
): boolean {
    if (questionImpliesSpatialComplex(question)) {
        return false;
    }
    if (questionImpliesRowListing(question)) {
        return true;
    }
    if (questionImpliesScalarFilterCount(question)) {
        return true;
    }
    const p = taskSpec.plan.target_pattern;
    if (!isDeterministicRenderablePattern(p)) {
        return false;
    }
    const spatial = taskSpec.plan.spatial.mode;
    if (
        spatial === "DISTANCE_BUFFER" ||
        spatial === "NEAREST_K" ||
        spatial === "TOPOLOGY"
    ) {
        return false;
    }
    return true;
}

function sqlAccessForKey(key: string): string {
    return `properties->>'${key.replace(/'/g, "''")}'`;
}

function escapeLiteral(value: string): string {
    return String(value ?? "").replace(/'/g, "''");
}

function mergeFilters(
    fromBindings: AstFilter[],
    fromSemantic: AstFilter[]
): AstFilter[] {
    const byKey = new Map<string, AstFilter>();
    for (const f of fromBindings) {
        byKey.set(f.physicalKey, f);
    }
    for (const f of fromSemantic) {
        byKey.set(f.physicalKey, f);
    }
    return [...byKey.values()];
}

function filtersFromBindings(bindings: SchemaColumnBinding[]): AstFilter[] {
    return bindings
        .filter((b) => b.role === "FILTER" && b.filter_literal != null)
        .map((b) => ({
            physicalKey: b.physical_key,
            sqlAccess: b.sql_access,
            op: (b.filter_match_op === "ilike" ? "ILIKE" : "=") as
                | "="
                | "ILIKE",
            value: String(b.filter_literal)
        }));
}

function buildGeomPredicateExtras(question: string): string[] {
    const q = question.toLowerCase();
    const extras: string[] = [];
    if (/(invalid|not valid)/i.test(q)) {
        extras.push("NOT ST_IsValid(geom)");
    } else if (
        /\bvalid\b/i.test(q) &&
        /(geometr|geom|polygon|segment)/i.test(q)
    ) {
        extras.push("ST_IsValid(geom)");
    }
    const lenMatch = q.match(
        /(length|perimeter).{0,40}(above|>|greater than)\s*(\d+(?:\.\d+)?)\s*(m|metres?|meters?)?/
    );
    if (lenMatch?.[3]) {
        const fn = /perimeter/i.test(lenMatch[1])
            ? "ST_Perimeter(geom::geography)"
            : "ST_Length(geom::geography)";
        extras.push(`${fn} > ${lenMatch[3]}`);
    }
    const areaMatch = q.match(
        /(larger than|greater than)\s*(\d[\d,]*)\s*(square metres?|square meters?)?/
    );
    if (areaMatch?.[2]) {
        extras.push(
            `ST_Area(geom::geography) > ${areaMatch[2].replace(/,/g, "")}`
        );
    }
    if (
        /(smaller than|below).{0,30}(average|mean)/i.test(q) &&
        /area/i.test(q)
    ) {
        extras.push(
            "ST_Area(geom::geography) < (SELECT AVG(ST_Area(geom::geography)) FROM features)"
        );
    }
    if (
        /(shorter than|below).{0,30}(average|mean)/i.test(q) &&
        /length/i.test(q)
    ) {
        extras.push(
            "ST_Length(geom::geography) < (SELECT AVG(ST_Length(geom::geography)) FROM features)"
        );
    }
    if (
        /(above|greater than|longer than).{0,30}(average|mean)/i.test(q) &&
        /perimeter/i.test(q)
    ) {
        extras.push(
            "ST_Perimeter(geom::geography) > (SELECT AVG(ST_Perimeter(geom::geography)) FROM features)"
        );
    }
    if (
        /(valid|st_isvalid)/i.test(q) &&
        /(length|perimeter).{0,40}(above|>|greater|\d+)/i.test(q)
    ) {
        if (!extras.includes("ST_IsValid(geom)")) {
            extras.push("ST_IsValid(geom)");
        }
    }
    return extras;
}

function inferListSelectColumns(
    question: string,
    propertyKeys: string[],
    bindings: SchemaColumnBinding[]
): AstSelectColumn[] {
    const q = question.toLowerCase();
    const cols: AstSelectColumn[] = [];

    const addKey = (key: string, alias?: string) => {
        if (!propertyKeys.includes(key)) {
            return;
        }
        const a = alias || key;
        if (cols.some((c) => c.alias === a)) {
            return;
        }
        cols.push({
            expression: sqlAccessForKey(key),
            alias: a
        });
    };

    if (/\bid\b/i.test(question) && !/(how many|count)/i.test(question)) {
        cols.push({ expression: "id", alias: "id" });
    }

    if (
        /(longest|shortest).{0,30}perimeter|perimeter.{0,30}(longest|shortest)/i.test(
            q
        )
    ) {
        cols.push({
            expression:
                "ROUND(ST_Perimeter(geom::geography)::numeric, 2)::double precision",
            alias: "perim_m"
        });
        if (!cols.some((c) => c.alias === "id")) {
            cols.unshift({ expression: "id", alias: "id" });
        }
        return cols;
    }
    if (
        /(shortest|longest).{0,30}(segment|length)/i.test(q) &&
        !/perimeter/i.test(q)
    ) {
        const isShort = /shortest/i.test(q);
        cols.push({
            expression: isShort
                ? "ROUND(ST_Length(geom::geography)::numeric, 2)::double precision"
                : "ST_Length(geom::geography)",
            alias: "len_m"
        });
        if (!cols.some((c) => c.alias === "id")) {
            cols.unshift({ expression: "id", alias: "id" });
        }
        return cols;
    }

    const pairs = [
        {
            re: /\bstreet\b.*\bsuburb\b|\bsuburb\b.*\bstreet\b/i,
            keys: ["street", "suburb"]
        },
        {
            re: /\bspecies\b.*\bheight\b|\bheight\b.*\bspecies\b/i,
            keys: ["species", "height"]
        },
        {
            re: /\bspecies\b.*\bsuburb\b|\bsuburb\b.*\bspecies\b/i,
            keys: ["species", "suburb"]
        },
        {
            re: /\bzone\s+code\b.*\bdevelopment|development\s+category/i,
            keys: ["zone", "dev_catego"]
        },
        {
            re: /\bcode\b.*\blabel\b|\blabel\b.*\bcode\b/i,
            keys: ["zone", "zone_meani"]
        }
    ];
    for (const p of pairs) {
        if (p.re.test(q)) {
            for (const k of p.keys) {
                addKey(k);
            }
            if (cols.length) {
                return cols;
            }
        }
    }

    for (const b of bindings) {
        if (b.role === "SELECT" || b.role === "FILTER") {
            addKey(b.physical_key);
        }
    }

    const mentionRe = /\b(show|list|with)\s+([a-z0-9_\s, and]+?)(?:\s+for|\s+sorted|\s+ordered|\s+limit|$)/i;
    const m = question.match(mentionRe);
    if (m?.[2]) {
        for (const part of m[2].split(/\s+and\s+|,\s*/i)) {
            const key = matchPropertyKeyFromHint(part.trim(), propertyKeys);
            if (key) {
                addKey(key);
            }
        }
    }

    for (const key of propertyKeys) {
        const kn = key.replace(/_/g, "[_\\s]*");
        if (new RegExp(`\\b${kn}\\b`, "i").test(question)) {
            addKey(key);
        }
    }

    if (!cols.length) {
        addKey(propertyKeys[0] || "species");
    }
    return cols.slice(0, 8);
}

function inferListOrderBy(
    question: string,
    selectColumns: AstSelectColumn[]
): AstOrderColumn[] {
    const q = question.toLowerCase();
    if (/shortest|ascending.*length|by length.*asc/i.test(q)) {
        const len = selectColumns.find((c) => /len_m|length/i.test(c.alias));
        return [
            {
                expression: len?.alias || "len_m",
                direction: "ASC"
            },
            { expression: "id", direction: "ASC" }
        ];
    }
    if (/longest|descending.*perimeter|by perimeter.*desc/i.test(q)) {
        const perim = selectColumns.find((c) => /perim_m/i.test(c.alias));
        return [
            {
                expression: perim?.alias || "perim_m",
                direction: "DESC"
            },
            { expression: "id", direction: "ASC" }
        ];
    }
    const sortMatch = q.match(
        /sorted\s+by\s+([a-z0-9_]+)(?:\s+then\s+([a-z0-9_]+))?/i
    );
    if (sortMatch) {
        const order: AstOrderColumn[] = [];
        if (sortMatch[1]) {
            order.push({ expression: sortMatch[1], direction: "ASC" });
        }
        if (sortMatch[2]) {
            order.push({ expression: sortMatch[2], direction: "ASC" });
        }
        if (order.length) {
            order.push({ expression: "id", direction: "ASC" });
            return order;
        }
    }
    if (/ordered\s+by\s+([a-z0-9_]+)/i.test(q)) {
        const m = q.match(/ordered\s+by\s+([a-z0-9_]+)/i);
        if (m?.[1]) {
            return [
                { expression: m[1], direction: "ASC" },
                { expression: "id", direction: "ASC" }
            ];
        }
    }
    if (selectColumns.length >= 2) {
        return [
            {
                expression: selectColumns[0].alias,
                direction: "ASC"
            },
            {
                expression: selectColumns[1].alias,
                direction: "ASC"
            }
        ];
    }
    return [];
}

function extractTopLimit(question: string): number | undefined {
    const fromList = extractListRowLimitFromQuestion(question);
    if (fromList) {
        return fromList;
    }
    const m = question.match(
        /\b(?:top|first|most frequent|five|ten)\s+(?:five|ten|\d+)?/i
    );
    if (/\bfive\b/i.test(question) || /top five/i.test(question)) {
        return 5;
    }
    if (/\bten\b/i.test(question)) {
        return 10;
    }
    const num = question.match(/\btop\s+(\d+)\b/i);
    if (num?.[1]) {
        return Math.min(Number(num[1]), 100);
    }
    return undefined;
}

function groupingKeysFromPlan(
    bindings: SchemaColumnBinding[],
    question: string,
    propertyKeys: string[]
): string[] {
    const fromBindings = bindings
        .filter((b) => b.role === "GROUP_BY")
        .map((b) => b.physical_key);
    if (fromBindings.length) {
        return fromBindings.slice(0, 4);
    }
    return inferGroupByKeysFromQuestionEnhanced(question, propertyKeys).slice(
        0,
        4
    );
}

function inferNumericLatFilter(question: string): AstFilter | null {
    const m = question.match(
        /latitude\s+(-?\d+(?:\.\d+)?)\s+and\s+(-?\d+(?:\.\d+)?)/i
    );
    if (!m?.[1] || !m[2]) {
        return null;
    }
    return {
        physicalKey: "lat",
        sqlAccess: `(NULLIF(trim(properties->>'lat'),''))::double precision`,
        op: "RAW",
        value: `BETWEEN ${m[1]} AND ${m[2]}`
    };
}

export function astFromTaskSpec(
    taskSpec: GeoQueryTaskSpec,
    question: string,
    propertyKeys: string[]
): ExecutableAst | null {
    const plan = taskSpec.plan;
    let pattern = plan.target_pattern;
    if (questionImpliesGroupedBreakdown(question)) {
        pattern = "AGGREGATE_GROUP_BY";
    } else if (questionImpliesRowListing(question)) {
        pattern = "LIST_ROWS";
    } else if (questionImpliesScalarFilterCount(question)) {
        pattern = "FILTER_COUNT";
    }
    if (!isDeterministicRenderablePattern(pattern)) {
        return null;
    }
    if (!shouldUseDeterministicRenderer(taskSpec, question)) {
        return null;
    }

    const filters = mergeFilters(
        filtersFromBindings(plan.bindings),
        inferSemanticFiltersFromQuestion(question, propertyKeys)
    );
    const latFilter = inferNumericLatFilter(question);
    if (latFilter) {
        filters.push(latFilter);
    }

    const geomWhereExtras =
        pattern === "FILTER_COUNT" &&
        questionImpliesGeomPredicateCount(question)
            ? buildGeomPredicateExtras(question)
            : pattern === "MEASUREMENT" &&
              /(valid geometr|among valid)/i.test(question)
            ? ["ST_IsValid(geom)"]
            : [];

    const op = plan.operations[0];
    const base: ExecutableAst = {
        queryType: pattern,
        filters,
        selectColumns: [],
        grouping: [],
        orderBy: [],
        geomWhereExtras,
        nonEmptyKeys: []
    };

    if (questionImpliesRowListing(question)) {
        const selectColumns = inferListSelectColumns(
            question,
            propertyKeys,
            plan.bindings
        );
        const limit = extractListRowLimitFromQuestion(question) ?? 10;
        const nonEmptyKeys: string[] = [];
        if (selectColumns.some((c) => c.alias === "zone")) {
            nonEmptyKeys.push("zone");
        }
        return {
            ...base,
            queryType: "LIST_ROWS",
            selectColumns,
            orderBy: inferListOrderBy(question, selectColumns),
            limit,
            nonEmptyKeys
        };
    }

    if (
        pattern === "FILTER_COUNT" ||
        questionImpliesScalarFilterCount(question)
    ) {
        if (op && /^COUNT\s*\(\s*DISTINCT/i.test(op.operator)) {
            const distinctKey =
                op.operator.match(/DISTINCT\s+(.+)\)/i)?.[1]?.trim() ||
                `properties->>'zone'`;
            return {
                ...base,
                queryType: "FILTER_COUNT",
                aggregate: {
                    expression: `COUNT(DISTINCT ${distinctKey})`,
                    alias: op.alias || "distinct_count"
                }
            };
        }
        return {
            ...base,
            queryType: "FILTER_COUNT",
            aggregate: {
                expression: "COUNT(*)",
                alias: op?.alias || "total_count"
            }
        };
    }

    if (
        pattern === "MEASUREMENT" &&
        op &&
        /^(SUM|AVG|MIN|MAX)\(/i.test(op.operator)
    ) {
        let expr = op.operator;
        if (
            questionImpliesPropertyAttributeAggregate(question) &&
            /shape_area|shape_leng/i.test(question.toLowerCase())
        ) {
            const shapeKey =
                propertyKeys.find((k) => /shape_area/i.test(k)) ||
                propertyKeys.find((k) => /shape_leng/i.test(k));
            if (shapeKey) {
                const fn =
                    op.operator.match(/^(SUM|AVG|MIN|MAX)/i)?.[1] || "SUM";
                expr = `${fn}((NULLIF(trim(${sqlAccessForKey(
                    shapeKey
                )}),''))::double precision)`;
            }
        }
        return {
            ...base,
            measurement: { expression: expr, alias: op.alias }
        };
    }

    if (pattern === "AGGREGATE_GROUP_BY") {
        const grouping = groupingKeysFromPlan(
            plan.bindings,
            question,
            propertyKeys
        );
        if (!grouping.length) {
            return null;
        }
        const limit = extractTopLimit(question) ?? 5;
        const groupExprs = grouping.map((k) => sqlAccessForKey(k));
        const selectColumns: AstSelectColumn[] = grouping.map((k) => ({
            expression: sqlAccessForKey(k),
            alias: k
        }));
        const nonEmptyKeys = grouping.filter((k) =>
            /(species|zone|str_type|treearea|suburb|dev_catego|devplan_co)/i.test(
                k
            )
        );
        return {
            ...base,
            grouping: groupExprs,
            selectColumns,
            aggregate: { expression: "COUNT(*)", alias: "cnt" },
            orderBy: [
                { expression: "cnt", direction: "DESC" },
                { expression: grouping[0], direction: "ASC" }
            ],
            limit,
            nonEmptyKeys
        };
    }

    return null;
}

export function renderWhereClause(ast: ExecutableAst): string {
    const parts: string[] = [];
    for (const f of ast.filters) {
        if (f.op === "RAW") {
            parts.push(`${f.sqlAccess} ${f.value}`);
        } else if (f.op === "ILIKE") {
            parts.push(`${f.sqlAccess} ILIKE '${escapeLiteral(f.value)}'`);
        } else {
            parts.push(`${f.sqlAccess} = '${escapeLiteral(f.value)}'`);
        }
    }
    for (const extra of ast.geomWhereExtras) {
        parts.push(extra);
    }
    for (const key of ast.nonEmptyKeys) {
        parts.push(`COALESCE(${sqlAccessForKey(key)},'') <> ''`);
    }
    return parts.length ? parts.join(" AND ") : "TRUE";
}
