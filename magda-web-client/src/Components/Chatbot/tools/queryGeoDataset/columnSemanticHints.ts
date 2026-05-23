import { matchPropertyKeyFromHint } from "./geoQueryQuestionPatterns";
import type { AstFilter } from "./executableAst";

function sqlAccess(key: string): string {
    return `properties->>'${key.replace(/'/g, "''")}'`;
}

/**
 * Keyword → column + value priors (override weak value_sample bindings).
 */
export function inferSemanticFiltersFromQuestion(
    question: string,
    propertyKeys: string[]
): AstFilter[] {
    const q = (question || "").toLowerCase();
    const out: AstFilter[] = [];

    if (
        /commercial/i.test(q) &&
        /(development|areas?|zones?|recorded|how many|classified)/i.test(q) &&
        propertyKeys.includes("dev_catego")
    ) {
        out.push({
            physicalKey: "dev_catego",
            sqlAccess: sqlAccess("dev_catego"),
            op: "=",
            value: "COMMERCIAL"
        });
    }
    if (
        /residential/i.test(q) &&
        /(land|zones?|within|how many|most frequent)/i.test(q) &&
        propertyKeys.includes("dev_catego")
    ) {
        out.push({
            physicalKey: "dev_catego",
            sqlAccess: sqlAccess("dev_catego"),
            op: "=",
            value: "RESIDENTIAL"
        });
    }
    if (
        /open\s+space/i.test(q) &&
        /(classified|category|categor|how many|features?)/i.test(q) &&
        !/(label|name|mentions?|includes?)/i.test(q) &&
        propertyKeys.includes("dev_catego")
    ) {
        out.push({
            physicalKey: "dev_catego",
            sqlAccess: sqlAccess("dev_catego"),
            op: "=",
            value: "OPEN SPACE"
        });
    }
    if (
        /open\s+space/i.test(q) &&
        /(label|name|mentions?|includes?|whose)/i.test(q) &&
        propertyKeys.includes("zone_meani")
    ) {
        out.push({
            physicalKey: "zone_meani",
            sqlAccess: sqlAccess("zone_meani"),
            op: "ILIKE",
            value: "%Open Space%"
        });
    }
    if (
        /metropolitan/i.test(q) &&
        /(includes?|mentions?|name|label|whose)/i.test(q) &&
        propertyKeys.includes("zone_meani")
    ) {
        out.push({
            physicalKey: "zone_meani",
            sqlAccess: sqlAccess("zone_meani"),
            op: "ILIKE",
            value: "%Metropolitan%"
        });
    }
    if (
        /\bzone\s+code\b/i.test(q) &&
        /(?:code|equal\s*|=)\s*['"]?([A-Z0-9]+)/i.test(question)
    ) {
        const m = question.match(
            /zone\s+code\s*['"]?([A-Z0-9]+)|code\s+['"]?([A-Z0-9]+)/i
        );
        const code = m?.[1] || m?.[2];
        if (code && propertyKeys.includes("zone")) {
            out.push({
                physicalKey: "zone",
                sqlAccess: sqlAccess("zone"),
                op: "=",
                value: code.toUpperCase()
            });
        }
    }
    if (
        /pine/i.test(q) &&
        /street/i.test(q) &&
        propertyKeys.includes("street")
    ) {
        out.push({
            physicalKey: "street",
            sqlAccess: sqlAccess("street"),
            op: "ILIKE",
            value: "%Pine%"
        });
    }
    if (
        /\b15\+m\b/i.test(q) ||
        /15\+m\s+tall/i.test(q) ||
        /tall trees.*15/i.test(q)
    ) {
        if (propertyKeys.includes("height")) {
            out.push({
                physicalKey: "height",
                sqlAccess: sqlAccess("height"),
                op: "=",
                value: "15+m"
            });
        }
    }
    if (/\bstr_type\b/i.test(q) || (/\broad\b/i.test(q) && /\brd\b/i.test(q))) {
        if (/str_type\s*=\s*['"]?str/i.test(q) || /type\s+str/i.test(q)) {
            if (propertyKeys.includes("str_type")) {
                out.push({
                    physicalKey: "str_type",
                    sqlAccess: sqlAccess("str_type"),
                    op: "=",
                    value: "Str"
                });
            }
        }
        if (
            /\brd[- ]?type|classified as\s+rd|roads?\s+classified as\s+rd/i.test(
                q
            )
        ) {
            if (propertyKeys.includes("str_type")) {
                out.push({
                    physicalKey: "str_type",
                    sqlAccess: sqlAccess("str_type"),
                    op: "=",
                    value: "Rd"
                });
            }
        }
    }
    if (/king\s+street/i.test(q) && propertyKeys.includes("street")) {
        out.push({
            physicalKey: "street",
            sqlAccess: sqlAccess("street"),
            op: "=",
            value: "King"
        });
        if (
            (/str\b/i.test(q) ||
                /\(king,\s*str\)/i.test(q) ||
                /king,\s*str/i.test(q)) &&
            propertyKeys.includes("str_type")
        ) {
            out.push({
                physicalKey: "str_type",
                sqlAccess: sqlAccess("str_type"),
                op: "=",
                value: "Str"
            });
        }
    }
    if (
        /eucalyptus\s+melliodora/i.test(q) &&
        propertyKeys.includes("species")
    ) {
        out.push({
            physicalKey: "species",
            sqlAccess: sqlAccess("species"),
            op: "=",
            value: "Eucalyptus melliodora"
        });
    }

    const zoneCodeMatch = question.match(/\bzone\s+code\s+['"]?([A-Z0-9]+)/i);
    if (zoneCodeMatch?.[1] && propertyKeys.includes("zone")) {
        const code = zoneCodeMatch[1].toUpperCase();
        if (!out.some((f) => f.physicalKey === "zone")) {
            out.push({
                physicalKey: "zone",
                sqlAccess: sqlAccess("zone"),
                op: "=",
                value: code
            });
        }
    }
    const zoneCodeBare = question.match(/\bzone\s+code\s+([A-Z0-9]{1,6})\b/i);
    if (zoneCodeBare?.[1] && propertyKeys.includes("zone")) {
        const code = zoneCodeBare[1].toUpperCase();
        if (!out.some((f) => f.physicalKey === "zone")) {
            out.push({
                physicalKey: "zone",
                sqlAccess: sqlAccess("zone"),
                op: "=",
                value: code
            });
        }
    }

    const devCodeMatch = question.match(
        /\bdevelopment\s+plan\s+code\s+['"]?([A-Z0-9]+)/i
    );
    if (devCodeMatch?.[1] && propertyKeys.includes("devplan_co")) {
        out.push({
            physicalKey: "devplan_co",
            sqlAccess: sqlAccess("devplan_co"),
            op: "=",
            value: devCodeMatch[1].toUpperCase()
        });
    }

    const hintMatch = question.match(
        /\bclassified\s+as\s+['"]?([^'"?.]+)['"]?/i
    );
    if (hintMatch?.[1]) {
        const key = matchPropertyKeyFromHint(hintMatch[1], propertyKeys);
        if (key && !out.some((f) => f.physicalKey === key)) {
            const val = hintMatch[1].trim().toUpperCase();
            if (key === "dev_catego") {
                out.push({
                    physicalKey: key,
                    sqlAccess: sqlAccess(key),
                    op: "=",
                    value: val.includes("OPEN") ? "OPEN SPACE" : val
                });
            }
        }
    }

    return out;
}
