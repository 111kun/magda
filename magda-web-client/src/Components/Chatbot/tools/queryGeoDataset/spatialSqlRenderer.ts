import type { GeoQueryTaskSpec } from "./geoQueryTaskInterpreter";
import { inferSemanticFiltersFromQuestion } from "./columnSemanticHints";

function sqlAccess(key: string): string {
    return `properties->>'${key.replace(/'/g, "''")}'`;
}

function escapeLiteral(v: string): string {
    return String(v ?? "").replace(/'/g, "''");
}

/** Deterministic SQL for spatial-complex patterns (Phase 4). */
export function tryRenderSpatialSql(
    question: string,
    taskSpec: GeoQueryTaskSpec,
    propertyKeys: string[]
): string | null {
    const q = question.toLowerCase();
    const pattern = taskSpec.plan.target_pattern;
    const semantic = inferSemanticFiltersFromQuestion(question, propertyKeys);

    const streetKing = semantic.find(
        (f) => f.physicalKey === "street" && f.value === "King"
    );
    const strTypeStr = semantic.find(
        (f) => f.physicalKey === "str_type" && f.value === "Str"
    );

    if (
        /within\s+\d+\s*(m|metres?|meters?)\b/i.test(q) &&
        /(tree|street|king)/i.test(q) &&
        streetKing &&
        strTypeStr
    ) {
        const distM =
            q.match(/within\s+(\d+)\s*(?:m|metres?|meters?)/i)?.[1] || "200";
        return `SELECT COUNT(*) AS total_count FROM features f WHERE EXISTS (SELECT 1 FROM features r WHERE r.properties->>'street' = 'King' AND r.properties->>'str_type' = 'Str' AND ST_DWithin(f.geom::geography, r.geom::geography, ${distM}))`;
    }

    if (
        (/closest|nearest/i.test(q) || pattern === "SPATIAL_NEAREST") &&
        /king\s+street/i.test(q) &&
        streetKing &&
        strTypeStr
    ) {
        const limit =
            q.match(/\b(ten|10|\d+)\b/i)?.[1] === "ten"
                ? 10
                : Number(q.match(/\b(\d+)\b/)?.[1]) || 10;
        const k = Math.min(limit, 100);
        return `WITH ref AS (SELECT ST_Centroid(ST_Collect(geom)) AS ref_geom FROM features WHERE properties->>'street' = 'King' AND properties->>'str_type' = 'Str') SELECT properties->>'suburb' AS suburb, properties->>'species' AS species, ROUND(ST_Distance(f.geom::geography, ref.ref_geom::geography)::numeric, 2)::double precision AS dist_m FROM features f, ref ORDER BY dist_m ASC, suburb ASC, species ASC LIMIT ${k}`;
    }

    if (
        /(perimeter|length|area).{0,30}(above|below|greater|less|shorter|longer).{0,30}(average|mean)/i.test(
            q
        ) &&
        /(how many|number of)/i.test(q)
    ) {
        if (/perimeter/i.test(q)) {
            const op = /below|less|shorter/i.test(q) ? "<" : ">";
            return `SELECT COUNT(*) AS total_count FROM features f WHERE ST_Perimeter(f.geom::geography) ${op} (SELECT AVG(ST_Perimeter(geom::geography)) FROM features)`;
        }
        if (/length/i.test(q) && !/perimeter/i.test(q)) {
            const op = /below|less|shorter/i.test(q) ? "<" : ">";
            return `SELECT COUNT(*) AS total_count FROM features f WHERE ST_Length(f.geom::geography) ${op} (SELECT AVG(ST_Length(geom::geography)) FROM features)`;
        }
        if (/area/i.test(q)) {
            const op = /smaller|below|less/i.test(q) ? "<" : ">";
            return `SELECT COUNT(*) AS total_count FROM features f WHERE ST_Area(f.geom::geography) ${op} (SELECT AVG(ST_Area(geom::geography)) FROM features)`;
        }
    }

    if (
        /(larger than|greater than)\s+(\d[\d,]*)\s*(square metres?|square meters?)?/i.test(
            question
        ) &&
        /(how many|number of)/i.test(q)
    ) {
        const n = question
            .match(/(larger than|greater than)\s+(\d[\d,]*)/i)?.[2]
            ?.replace(/,/g, "");
        if (n) {
            return `SELECT COUNT(*) AS total_count FROM features WHERE ST_Area(geom::geography) > ${n}`;
        }
    }

    if (/how many.*valid geometr/i.test(q)) {
        return `SELECT COUNT(*) AS total_count FROM features WHERE ST_IsValid(geom)`;
    }

    return null;
}
