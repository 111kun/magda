/**
 * SQL robustness helpers for GeoSQL execution:
 * - Apply common typo/dialect sanitization
 * - Generate error hints for failed PostGIS calls
 * - Ask the model for one-shot SQL self-repair on failure
 */
import { ChainInput } from "../../commons";
import { WebLLMTool } from "../../ChatWebLLM";

const commonGeoSqlTypos: Array<{
    regex: RegExp;
    replacement: string;
    reason: string;
}> = [
    {
        regex: /\bST_A\s*\(/gi,
        replacement: "ST_Area(",
        reason: "Detected truncated function ST_A( -> ST_Area("
    },
    {
        regex: /\bST_INTERSETCS\s*\(/gi,
        replacement: "ST_Intersects(",
        reason: "Detected misspelling ST_INTERSETCS( -> ST_Intersects("
    },
    {
        regex: /\bST_DWTHIN\s*\(/gi,
        replacement: "ST_DWithin(",
        reason: "Detected misspelling ST_DWTHIN( -> ST_DWithin("
    },
    {
        regex: /\bST_ASGEOJSONN\s*\(/gi,
        replacement: "ST_AsGeoJSON(",
        reason: "Detected misspelling ST_ASGEOJSONN( -> ST_AsGeoJSON("
    }
];

function extractExecutableSql(input: string): string {
    const text = (input || "").trim();
    if (!text) {
        return text;
    }
    const fencedSql = text.match(/```(?:sql)?\s*([\s\S]*?)```/i);
    const candidate = fencedSql?.[1]?.trim() || text;
    const startMatch = candidate.match(/\b(select|with)\b/i);
    if (!startMatch || typeof startMatch.index !== "number") {
        return candidate;
    }
    return candidate
        .slice(startMatch.index)
        .replace(/```[\s\S]*$/g, "")
        .trim();
}

function startsWithExecutableSql(input: string): boolean {
    return /^\s*(select|with)\b/i.test(input || "");
}

function escapeSqlString(input: string): string {
    return input.replace(/'/g, "''");
}

export function makeSafeSqlAlias(input: string): string {
    const alias = (input || "")
        .trim()
        .replace(/[^A-Za-z0-9_]/g, "_")
        .replace(/^_+|_+$/g, "");
    return /^[A-Za-z_]/.test(alias) && alias
        ? alias
        : `attr_${alias || "value"}`;
}

export function chooseCoreDisplayKeys(
    propKeys?: string[] | null,
    maxKeys = 6
): string[] {
    const keys = (propKeys || []).filter((key) => !!key?.trim());
    if (!keys.length) {
        return [];
    }
    const seen = new Set<string>();
    const uniqueKeys = keys.filter((key) => {
        const normalized = key.trim().toLowerCase();
        if (seen.has(normalized)) {
            return false;
        }
        seen.add(normalized);
        return true;
    });
    const scoreKey = (key: string, idx: number) => {
        const k = key.toLowerCase();
        if (/^(name|title|label|description)$/.test(k)) return 100 - idx / 100;
        if (/(name|title|label|description)/.test(k)) return 90 - idx / 100;
        if (/(address|street|road|suburb|locality|postcode|pcode)/.test(k)) {
            return 80 - idx / 100;
        }
        if (/(type|category|class|kind|species|status)/.test(k)) {
            return 70 - idx / 100;
        }
        if (/(asset|feature|object|identifier|code|id)$/.test(k)) {
            return 60 - idx / 100;
        }
        if (/^(lat|lon|lng|latitude|longitude|x|y)$/.test(k)) {
            return 20 - idx / 100;
        }
        return 40 - idx / 100;
    };
    return uniqueKeys
        .map((key, idx) => ({ key, score: scoreKey(key, idx) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, maxKeys)
        .map((item) => item.key);
}

export function formatGeoSqlPropertyProjection(
    key: string,
    tableAlias = "features"
): string {
    return `${tableAlias}.properties->>'${escapeSqlString(
        key
    )}' AS ${makeSafeSqlAlias(key)}`;
}

export function buildGeoSqlOutputGuidance(propKeys?: string[] | null): string {
    const displayKeys = chooseCoreDisplayKeys(propKeys, 6);
    const displayKeyText = displayKeys.length ? displayKeys.join(", ") : "N/A";
    const projectionExamples = displayKeys.length
        ? displayKeys
              .map((key) => formatGeoSqlPropertyProjection(key, "f"))
              .join(", ")
        : "properties->>'existing_key' AS existing_key";
    return [
        "Readable SQL output rules:",
        "- Keep SELECT output compact and map-friendly.",
        "- Do not SELECT *, raw geom, or the full properties JSONB object unless the user explicitly asks for raw data.",
        "- Prefer id, computed metrics requested by the user, 3-6 readable properties from existing keys, and ST_AsText(<alias>.geom) AS geom_wkt for map rendering.",
        "- Cast properties only for calculations/filtering/sorting; for display, keep original text with properties->>'key' AS key.",
        `- Preferred display property keys for this dataset: ${displayKeyText}.`,
        `- Example readable projections: f.id, ${projectionExamples}, ST_AsText(f.geom) AS geom_wkt.`
    ].join("\n");
}

function enforceGeomAsWktInSelect(
    query: string
): {
    query: string;
    changed: boolean;
    reason?: string;
} {
    const match = query.match(/^\s*select\s+([\s\S]+?)\s+from\s+/i);
    if (!match || !match[1]) {
        return { query, changed: false };
    }
    const projection = match[1];
    const normalizedProjection = projection.toLowerCase();
    if (
        /st_astext\s*\(/i.test(normalizedProjection) ||
        /\bgeom_wkt\b/i.test(normalizedProjection)
    ) {
        return { query, changed: false };
    }
    let updatedProjection = projection;

    // Case 1: raw geom is projected -> rewrite to WKT alias.
    updatedProjection = updatedProjection.replace(
        /(^|,\s*)geom(?:\s+as\s+[a-z_][a-z0-9_]*|\s+[a-z_][a-z0-9_]*)?(?=\s*(,|$))/gi,
        "$1ST_AsText(geom) AS geom_wkt"
    );
    updatedProjection = updatedProjection.replace(
        /(^|,\s*)([a-z_][a-z0-9_]*)\.geom(?:\s+as\s+[a-z_][a-z0-9_]*|\s+[a-z_][a-z0-9_]*)?(?=\s*(,|$))/gi,
        "$1ST_AsText($2.geom) AS geom_wkt"
    );

    if (updatedProjection === projection) {
        // Case 2: no raw geom in projection, but safe to add a default WKT column.
        // Keep conservative to avoid breaking aggregations/grouped queries.
        const isSafeForWktAppend =
            /\bfrom\s+features\b/i.test(query) &&
            !/\bjoin\b/i.test(query) &&
            !/\bgroup\s+by\b/i.test(query) &&
            !/\bdistinct\b/i.test(query) &&
            !/\bunion\b|\bintersect\b|\bexcept\b/i.test(query) &&
            !/\b(count|sum|avg|min|max)\s*\(/i.test(query);
        if (!isSafeForWktAppend) {
            return { query, changed: false };
        }
        const appendedProjection = `${projection}, ST_AsText(geom) AS geom_wkt`;
        return {
            query: query.replace(projection, appendedProjection),
            changed: true,
            reason:
                "Appended default WKT projection column for map-friendly output: ST_AsText(geom) AS geom_wkt."
        };
    }
    return {
        query: query.replace(projection, updatedProjection),
        changed: true,
        reason:
            "Rewrote raw geom projection to WKT using ST_AsText(... ) AS geom_wkt."
    };
}

function normalizeFieldToken(input: string): string {
    return (input || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function chooseBestPropertyKey(
    requestedField: string,
    propKeys: string[]
): string | null {
    if (!propKeys?.length) {
        return null;
    }
    const requested = requestedField.trim();
    if (!requested) {
        return null;
    }
    const requestedLower = requested.toLowerCase();
    const exact = propKeys.find((k) => k.toLowerCase() === requestedLower);
    if (exact) {
        return exact;
    }
    const requestedNorm = normalizeFieldToken(requested);
    const normMatched = propKeys.find(
        (k) => normalizeFieldToken(k) === requestedNorm
    );
    if (normMatched) {
        return normMatched;
    }

    const semanticAliases: Record<string, string[]> = {
        name: ["name", "asset_name", "park_name", "title", "label"],
        title: ["title", "name", "asset_name", "park_name", "label"],
        address: ["address", "addr", "street", "road", "suburb", "location"],
        category: ["category", "type", "class", "classif", "kind"],
        id: ["id", "assetid", "asset_id", "park_id", "identifier"]
    };
    const aliasCandidates = semanticAliases[requestedLower];
    if (aliasCandidates?.length) {
        let bestKey: string | null = null;
        let bestScore = -1;
        for (const key of propKeys) {
            const keyLower = key.toLowerCase();
            let score = 0;
            aliasCandidates.forEach((alias, idx) => {
                if (keyLower === alias) {
                    score = Math.max(score, 100 - idx);
                } else if (keyLower.includes(alias)) {
                    score = Math.max(score, 70 - idx);
                }
            });
            if (score > bestScore) {
                bestScore = score;
                bestKey = key;
            }
        }
        if (bestKey && bestScore > 0) {
            return bestKey;
        }
    }

    // Generic fallback: substring similarity on normalized token
    let fallback: string | null = null;
    let fallbackScore = -1;
    for (const key of propKeys) {
        const keyNorm = normalizeFieldToken(key);
        if (!keyNorm || !requestedNorm) {
            continue;
        }
        let score = 0;
        if (
            keyNorm.includes(requestedNorm) ||
            requestedNorm.includes(keyNorm)
        ) {
            score = Math.max(keyNorm.length, requestedNorm.length);
        } else {
            const requestedParts = requestedLower.split("_").filter(Boolean);
            requestedParts.forEach((part) => {
                if (part && key.toLowerCase().includes(part)) {
                    score += part.length;
                }
            });
        }
        if (score > fallbackScore) {
            fallbackScore = score;
            fallback = key;
        }
    }
    return fallbackScore > 0 ? fallback : null;
}

function rewriteBareProjectionFieldsToJsonb(
    query: string,
    propKeys: string[] | null
): {
    query: string;
    changed: boolean;
    reason?: string;
} {
    if (!propKeys?.length) {
        return { query, changed: false };
    }
    const match = query.match(/^\s*select\s+([\s\S]+?)\s+from\s+/i);
    if (!match?.[1]) {
        return { query, changed: false };
    }
    const projection = match[1];
    const topLevelColumns = new Set(["id", "geom", "properties"]);
    let updatedProjection = projection;
    updatedProjection = updatedProjection.replace(
        /(^|,\s*)([a-z_][a-z0-9_]*)(\s+as\s+[a-z_][a-z0-9_]*)?(?=\s*(,|$))/gi,
        (all, prefix: string, field: string, aliasPart?: string) => {
            const lowerField = field.toLowerCase();
            if (topLevelColumns.has(lowerField)) {
                return all;
            }
            const mappedKey = chooseBestPropertyKey(field, propKeys);
            if (!mappedKey) {
                return all;
            }
            const alias =
                aliasPart && aliasPart.trim()
                    ? aliasPart.trim()
                    : `AS ${field}`;
            return `${prefix}properties->>'${mappedKey}' ${alias}`;
        }
    );
    if (updatedProjection === projection) {
        return { query, changed: false };
    }
    return {
        query: query.replace(projection, updatedProjection),
        changed: true,
        reason:
            "Mapped bare projection fields to properties JSONB keys using semantic key matching."
    };
}

function findMatchingParen(input: string, openParenIdx: number): number {
    let depth = 0;
    for (let i = openParenIdx; i < input.length; i++) {
        const char = input[i];
        if (char === "(") {
            depth++;
        } else if (char === ")") {
            depth--;
            if (depth === 0) {
                return i;
            }
        }
    }
    return -1;
}

function splitTopLevelArgs(input: string): string[] | null {
    const args: string[] = [];
    let depth = 0;
    let lastStart = 0;
    for (let i = 0; i < input.length; i++) {
        const char = input[i];
        if (char === "(") {
            depth++;
        } else if (char === ")") {
            depth--;
        } else if (char === "," && depth === 0) {
            args.push(input.slice(lastStart, i).trim());
            lastStart = i + 1;
        }
    }
    args.push(input.slice(lastStart).trim());
    return args.length === 2 && args.every((arg) => !!arg) ? args : null;
}

function splitTopLevelList(input: string): string[] {
    const items: string[] = [];
    let depth = 0;
    let lastStart = 0;
    for (let i = 0; i < input.length; i++) {
        const char = input[i];
        if (char === "(") {
            depth++;
        } else if (char === ")") {
            depth--;
        } else if (char === "," && depth === 0) {
            items.push(input.slice(lastStart, i).trim());
            lastStart = i + 1;
        }
    }
    items.push(input.slice(lastStart).trim());
    return items.filter((item) => !!item);
}

function getFeaturesAlias(query: string): string {
    const match = query.match(
        /\bfrom\s+features(?:\s+(?:as\s+)?([a-z_][a-z0-9_]*))?/i
    );
    const alias = match?.[1]?.trim();
    if (
        !alias ||
        /^(where|join|cross|left|right|inner|outer|order|group|limit)$/i.test(
            alias
        )
    ) {
        return "features";
    }
    return alias;
}

function buildReadableProjectionItems(
    tableAlias: string,
    propKeys?: string[] | null
): string[] {
    return [
        `${tableAlias}.id`,
        ...chooseCoreDisplayKeys(propKeys, 6).map((key) =>
            formatGeoSqlPropertyProjection(key, tableAlias)
        ),
        `ST_AsText(${tableAlias}.geom) AS geom_wkt`
    ];
}

function enforceReadableProjectionInSelect(
    query: string,
    propKeys?: string[] | null
): {
    query: string;
    changed: boolean;
    reason?: string;
} {
    const match = query.match(/^\s*select\s+([\s\S]+?)\s+from\s+/i);
    if (!match || !match[1]) {
        return { query, changed: false };
    }
    const projection = match[1];
    const items = splitTopLevelList(projection);
    const tableAlias = getFeaturesAlias(query);
    const readableItems = buildReadableProjectionItems(tableAlias, propKeys);
    let changed = false;
    const nextItems = items.flatMap((item) => {
        const trimmed = item.trim();
        if (/^(\*|[a-z_][a-z0-9_]*\.\*)$/i.test(trimmed)) {
            changed = true;
            return readableItems;
        }
        if (
            new RegExp(
                `^(?:${tableAlias}\\.)?properties(?:\\s+as\\s+[a-z_][a-z0-9_]*|\\s+[a-z_][a-z0-9_]*)?$`,
                "i"
            ).test(trimmed)
        ) {
            changed = true;
            return readableItems.filter(
                (projectionItem) => !/\bid$/i.test(projectionItem)
            );
        }
        return [item];
    });
    if (!changed) {
        return { query, changed: false };
    }
    const deduped: string[] = [];
    const seen = new Set<string>();
    nextItems.forEach((item) => {
        const key = item.trim().toLowerCase();
        if (!seen.has(key)) {
            seen.add(key);
            deduped.push(item);
        }
    });
    return {
        query: query.replace(projection, deduped.join(",\n  ")),
        changed: true,
        reason:
            "Rewrote broad/raw SELECT output to compact readable columns plus geom_wkt for map rendering."
    };
}

function castDistanceArgToGeography(arg: string): string {
    return /::\s*geography\b/i.test(arg) ? arg : `(${arg.trim()})::geography`;
}

function enforceStDistanceGeography(
    query: string
): {
    query: string;
    changed: boolean;
} {
    const fnRegex = /\bST_Distance\s*\(/gi;
    let output = "";
    let cursor = 0;
    let changed = false;
    let match: RegExpExecArray | null = null;

    while ((match = fnRegex.exec(query)) !== null) {
        const fnStart = match.index;
        const openParenIdx = fnRegex.lastIndex - 1;
        const closeParenIdx = findMatchingParen(query, openParenIdx);
        if (closeParenIdx === -1) {
            break;
        }
        const rawArgs = query.slice(openParenIdx + 1, closeParenIdx);
        const args = splitTopLevelArgs(rawArgs);
        if (!args) {
            continue;
        }
        const nextCall = `ST_Distance(${castDistanceArgToGeography(
            args[0]
        )}, ${castDistanceArgToGeography(args[1])})`;
        output += query.slice(cursor, fnStart) + nextCall;
        cursor = closeParenIdx + 1;
        fnRegex.lastIndex = closeParenIdx + 1;
        if (nextCall !== query.slice(fnStart, closeParenIdx + 1)) {
            changed = true;
        }
    }

    if (!output) {
        return { query, changed: false };
    }
    output += query.slice(cursor);
    return { query: output, changed };
}

/** SELECT with aggregate(s) only and no GROUP BY — scalar answer; do not append LIMIT 100. */
function isScalarAggregateSelect(sql: string): boolean {
    const q = (sql || "").trim().replace(/;+\s*$/g, "");
    if (!/^\s*select\b/i.test(q) || /\bgroup\s+by\b/i.test(q)) {
        return false;
    }
    const projMatch = q.match(/^\s*select\s+([\s\S]+?)\s+from\b/i);
    if (!projMatch?.[1]) {
        return false;
    }
    const proj = projMatch[1].trim();
    if (!/\b(count|sum|avg|average|min|max)\s*\(/i.test(proj)) {
        return false;
    }
    const nonAgg = proj
        .replace(
            /\b(count|sum|avg|average|min|max)\s*\(\s*(?:distinct\s+)?[\s\S]*?\)/gi,
            ""
        )
        .replace(/\s+as\s+["']?\w+["']?/gi, "")
        .replace(/,\s*/g, "")
        .trim();
    return nonAgg.length === 0;
}

export function sanitizeGeoSql(
    query: string,
    propKeys?: string[] | null
): {
    query: string;
    fixes: string[];
} {
    let output = extractExecutableSql(query);
    const fixes: string[] = [];
    if (output !== query.trim()) {
        fixes.push(
            "Extracted executable SQL from surrounding natural language or markdown fences."
        );
    }
    for (const item of commonGeoSqlTypos) {
        if (item.regex.test(output)) {
            output = output.replace(item.regex, item.replacement);
            fixes.push(item.reason);
        }
    }

    const beforeTableNameFix = output;
    if (/^\s*select\b/i.test(output)) {
        output = output.replace(
            /\bfrom\s+("[^"]+"|[a-z_][a-z0-9_]*)(?=\s|;|$)/i,
            (match: string, tableName: string) => {
                const normalizedTableName = tableName
                    .replace(/^"|"$/g, "")
                    .toLowerCase();
                return normalizedTableName === "features"
                    ? match
                    : match.replace(tableName, "features");
            }
        );
    }
    if (output !== beforeTableNameFix) {
        fixes.push(
            "Rewrote dataset/distribution table name to the browser PostGIS table `features`."
        );
    }

    const beforeJsonbQuoteFix = output;
    output = output
        .replace(/properties\s*->>\s*"([^"]+)"/gi, "properties->>'$1'")
        .replace(/properties\s*->\s*"([^"]+)"/gi, "properties->'$1'");
    if (output !== beforeJsonbQuoteFix) {
        fixes.push(
            "Normalized JSONB key quoting for properties accessors (use single quotes around keys)."
        );
    }

    const wktEnforced = enforceGeomAsWktInSelect(output);
    output = wktEnforced.query;
    if (wktEnforced.changed) {
        fixes.push(
            wktEnforced.reason ||
                "Added WKT projection column for geometry output."
        );
    }

    const projectionKeyRewrite = rewriteBareProjectionFieldsToJsonb(
        output,
        propKeys || null
    );
    output = projectionKeyRewrite.query;
    if (projectionKeyRewrite.changed) {
        fixes.push(
            projectionKeyRewrite.reason ||
                "Rewrote bare projection fields to properties JSONB."
        );
    }

    const readableProjection = enforceReadableProjectionInSelect(
        output,
        propKeys || null
    );
    output = readableProjection.query;
    if (readableProjection.changed) {
        fixes.push(
            readableProjection.reason ||
                "Rewrote raw SELECT output to readable display columns."
        );
    }

    const beforeGeometryTypeLiteralFix = output;
    output = output.replace(
        /\bGeometryType\s*\(([^)]+)\)\s*(=|<>|!=)\s*'([^']+)'/gi,
        (_m, geomExpr: string, op: string, literal: string) =>
            `GeometryType(${geomExpr}) ${op} '${literal.toUpperCase()}'`
    );
    if (output !== beforeGeometryTypeLiteralFix) {
        fixes.push(
            "Normalized GeometryType(...) comparison literals to uppercase (e.g. 'POLYGON')."
        );
    }

    const distanceFix = enforceStDistanceGeography(output);
    output = distanceFix.query;
    if (distanceFix.changed) {
        fixes.push(
            "Auto-cast ST_Distance arguments to geography for meter-based distance."
        );
    }

    return { query: output, fixes };
}

export function getGeoSqlErrorSuggestion(errText: string): string | null {
    const txt = (errText || "").toLowerCase();
    const fnMatch = txt.match(/function\s+([a-z0-9_]+)\s*\(/);
    const fnName = fnMatch?.[1] || "";
    if (!fnName) {
        return null;
    }
    if (fnName === "st_a") {
        return "Possible fix: replace ST_A(...) with ST_Area(...), ST_AsText(...), or ST_AsGeoJSON(...) based on intent.";
    }
    if (fnName === "st_intersetcs") {
        return "Possible fix: use ST_Intersects(...)";
    }
    if (fnName === "st_dwthin") {
        return "Possible fix: use ST_DWithin(...)";
    }
    return `Unknown PostGIS function "${fnName}". Check spelling or use a supported ST_* function.`;
}

export async function repairGeoSqlWithModel(
    input: ChainInput,
    previousSql: string,
    errorText: string,
    propKeys: string[] | null,
    metadataBrief?: string,
    schemaContext?: string
): Promise<string | null> {
    const sqlRepairTool: WebLLMTool = {
        name: "submitFixedGeoSql",
        description:
            "Return a corrected GeoSQL query string only. The returned value must start directly with SELECT or WITH; no apologies, explanations, markdown fences, comments, or prose. Query the browser PostGIS table `features` only; never use dataset or distribution titles as table names. Fix syntax, JSONB access, column names, geometry/geography usage, and keep LIMIT <= 100.",
        func: ({ sqlQuery }: { sqlQuery: string }) => sqlQuery,
        parameters: [
            {
                name: "sqlQuery",
                type: "string",
                description:
                    "Corrected executable GeoSQL only. Must be a single SELECT (or WITH) statement against features, with no surrounding natural language or markdown."
            }
        ],
        requiredParameters: ["sqlQuery"]
    };

    const repairPrompt =
        "Your previous SQL failed with error: " +
        errorText +
        ". Please fix the syntax (check column names/JSONB access) and try again.\n" +
        (metadataBrief
            ? "Dataset metadata context (MUST use for semantic grounding):\n" +
              metadataBrief +
              "\n"
            : "") +
        (schemaContext
            ? "Schema/sample YAML (MUST inspect before choosing fields):\n" +
              schemaContext +
              "\n"
            : "") +
        "Requirements:\n" +
        "- Query table: features(id, properties, geom)\n" +
        "- `features` is the ONLY available SQL table name in browser PostGIS; never use the dataset title, distribution title, filename, or derived names such as Manningham_Street_Trees\n" +
        "- Only id, properties, and geom are top-level columns; all dataset attributes must be accessed through properties JSONB\n" +
        "- If the user asks for rows nearest to a dataset feature identified by an existing column/key and value, do not use placeName-style geocoding; use a CTE/self-join against features as the reference geometry\n" +
        "- JSONB keys are case-sensitive\n" +
        "- MUST use only keys from properties_schema.keys map (exact casing); do not invent key names\n" +
        "- If the requested natural-language field is not an exact key (e.g. user says name), map it to the closest existing key from sampled keys (e.g. asset_name) instead of inventing columns\n" +
        "- If no suitable existing field matches the request, return a query intent that clearly indicates no suitable field instead of guessing\n" +
        "- Align filters/selection with dataset meaning from metadata (title/description/tags/themes/distribution description)\n" +
        "- Use ->> for text output/filter, cast numeric as needed (e.g. (properties->>'population')::int)\n" +
        buildGeoSqlOutputGuidance(propKeys) +
        "\n" +
        "- If the SQL uses an external reference location token, `__REF_POINT__` is already a complete SRID 4326 geometry expression; use it directly in spatial functions and never access __REF_POINT__.lon/__REF_POINT__.lat or wrap it in ST_MakePoint(...)\n" +
        "- If SQL contains GROUP BY, all non-grouped selected fields MUST be aggregated; never leave ST_Area(geom) or raw geom unaggregated\n" +
        "- Area MUST be square meters via ST_Area(geom::geography); length/distance MUST be meters via geography\n" +
        "- For same-name multi-feature cases, explicitly choose aggregate mode (SUM by name) or feature-level mode; do not mix ambiguous grouping\n" +
        "- If using GeometryType filters, compare with UPPERCASE literals (e.g. 'POINT', 'POLYGON')\n" +
        "- Use ::geography for meter-based distance/length\n" +
        "- Keep LIMIT <= 100\n" +
        "- Return executable SQL only. The sqlQuery value must start directly with SELECT or WITH. Do not include apologies, explanations, markdown fences, comments, labels, or prose.\n" +
        (propKeys?.length
            ? `- Available sampled properties keys: ${propKeys.join(", ")}\n`
            : "") +
        "Previous SQL:\n```sql\n" +
        previousSql +
        "\n```";

    try {
        const result = await input.model.invokeTool(
            repairPrompt,
            [sqlRepairTool],
            input
        );
        const fixedSql = result?.value;
        const executableSql =
            typeof fixedSql === "string" ? extractExecutableSql(fixedSql) : "";
        return startsWithExecutableSql(executableSql) ? executableSql : null;
    } catch {
        return null;
    }
}
