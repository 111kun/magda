#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..", "..");
const LIMIT = 5000;
const nm = path.join(ROOT, "magda", "node_modules");

function remapLandProperties(p) {
    return {
        zone: p.zone ?? null,
        zone_meani: p.zone_meaning ?? p.zone_meani ?? null,
        dev_catego: p.dev_category ?? p.dev_catego ?? null,
        devplan_co: p.devplan_code ?? p.devplan_co ?? null,
        policy: (p.policy ?? "").toString().trim(),
        policy_mea: (p.policy_meaning ?? p.policy_mea ?? "").toString().trim(),
        precinct: (p.precinct ?? "").toString().trim(),
        precinct_m: (p.precinct_meaning ?? p.precinct_m ?? "")
            .toString()
            .trim(),
        shape_Area: p.shape_Area ?? null,
        shape_Leng: p.shape_Length ?? p.shape_Leng ?? null,
        special_us: (p.special_use ?? p.special_us ?? "").toString().trim(),
        urban_cent: (p.urban_centre ?? p.urban_cent ?? "").toString().trim()
    };
}

function capFeatures(raw, maxFeatures, slug) {
    const features = [];
    let totalValid = 0;
    for (const f of raw.features || []) {
        if (!f?.geometry) continue;
        totalValid++;
        if (features.length >= maxFeatures) continue;
        const props =
            slug === "land_zones"
                ? remapLandProperties(f.properties ?? {})
                : f.properties ?? {};
        features.push({
            type: "Feature",
            geometry: f.geometry,
            properties: props
        });
    }
    return { type: "FeatureCollection", features, totalValid };
}

async function createPg() {
    const { PGlite } = await import(
        pathToFileURL(path.join(nm, "@electric-sql/pglite/dist/index.js")).href
    );
    const { postgis } = await import(
        pathToFileURL(
            path.join(nm, "@electric-sql/pglite-postgis/dist/index.js")
        ).href
    );
    const pg = await PGlite.create({
        dataDir: `memory://probe-${Date.now()}`,
        relaxedDurability: true,
        extensions: { postgis }
    });
    await pg.exec(`
        CREATE EXTENSION IF NOT EXISTS postgis;
        CREATE TABLE features (id SERIAL PRIMARY KEY, properties JSONB, geom geometry);
    `);
    return pg;
}

async function importFc(pg, fc) {
    for (const f of fc.features) {
        await pg.query(
            `WITH g AS (SELECT ST_GeomFromGeoJSON($2) AS raw_geom)
             INSERT INTO features (properties, geom)
             SELECT $1::jsonb,
               CASE
                 WHEN raw_geom IS NULL THEN NULL
                 WHEN (
                   abs(ST_XMin(raw_geom)) > 180 OR abs(ST_XMax(raw_geom)) > 180 OR
                   abs(ST_YMin(raw_geom)) > 90 OR abs(ST_YMax(raw_geom)) > 90
                 ) AND (
                   abs(ST_XMin(raw_geom)) > 1000 OR abs(ST_XMax(raw_geom)) > 1000 OR
                   abs(ST_YMin(raw_geom)) > 1000 OR abs(ST_YMax(raw_geom)) > 1000
                 ) THEN ST_Transform(ST_SetSRID(raw_geom, 3857), 4326)
                 WHEN abs(ST_XMin(raw_geom)) <= 90 AND abs(ST_XMax(raw_geom)) <= 90 AND
                      abs(ST_YMin(raw_geom)) <= 180 AND abs(ST_YMax(raw_geom)) <= 180
                 THEN ST_SetSRID(ST_FlipCoordinates(raw_geom), 4326)
                 ELSE ST_SetSRID(raw_geom, 4326)
               END
             FROM g;`,
            [JSON.stringify(f.properties ?? {}), JSON.stringify(f.geometry)]
        );
    }
}

const FILES = {
    land_zones: "LandDevelopmentZones_GDA2020.geojson",
    manningham_trees: "Manningham_Street_Trees.geojson",
    road_segment: "Road_Segment.geojson"
};

const PROBES = {
    land_zones: [
        [
            "011",
            "SELECT COUNT(*)::bigint AS cnt FROM features WHERE properties->>'zone' = 'R' ORDER BY cnt;"
        ],
        [
            "012",
            "SELECT COUNT(*)::bigint AS cnt FROM features WHERE properties->>'zone' = 'LCe' ORDER BY cnt;"
        ],
        [
            "013",
            "SELECT COUNT(*)::bigint AS cnt FROM features WHERE properties->>'zone' = 'R' AND properties->>'dev_catego' = 'RESIDENTIAL' ORDER BY cnt;"
        ],
        [
            "014",
            "SELECT COUNT(*)::bigint AS cnt FROM features WHERE properties->>'dev_catego' = 'COMMERCIAL' ORDER BY cnt;"
        ],
        [
            "015",
            "SELECT COUNT(*)::bigint AS cnt FROM features WHERE properties->>'zone' = 'MOSS' AND properties->>'dev_catego' = 'OPEN SPACE' ORDER BY cnt;"
        ],
        [
            "016",
            "SELECT properties->>'devplan_co' AS devplan_co, COUNT(*)::bigint AS cnt FROM features WHERE COALESCE(properties->>'devplan_co','') <> '' GROUP BY properties->>'devplan_co' ORDER BY cnt DESC, devplan_co ASC LIMIT 5;"
        ],
        [
            "017",
            "SELECT properties->>'zone' AS zone, COUNT(*)::bigint AS cnt FROM features WHERE properties->>'dev_catego' = 'RESIDENTIAL' GROUP BY properties->>'zone' ORDER BY cnt DESC, zone ASC LIMIT 5;"
        ],
        [
            "018",
            "SELECT properties->>'zone' AS zone, properties->>'dev_catego' AS dev_catego FROM features WHERE COALESCE(properties->>'zone','') <> '' ORDER BY zone ASC, dev_catego ASC LIMIT 10;"
        ],
        [
            "019",
            "SELECT properties->>'zone' AS zone, properties->>'zone_meani' AS zone_meani FROM features WHERE properties->>'zone_meani' ILIKE '%Metropolitan%' ORDER BY zone ASC, zone_meani ASC LIMIT 5;"
        ],
        [
            "020",
            "SELECT COALESCE(SUM(ST_Area(geom::geography)),0)::double precision AS total_area_m2 FROM features ORDER BY total_area_m2;"
        ],
        [
            "021",
            "SELECT COALESCE(AVG(ST_Area(geom::geography)),0)::double precision AS avg_area_m2 FROM features ORDER BY avg_area_m2;"
        ],
        [
            "022",
            "SELECT COUNT(DISTINCT properties->>'zone')::bigint AS distinct_zones FROM features ORDER BY distinct_zones;"
        ],
        [
            "023",
            "SELECT COUNT(*)::bigint AS cnt FROM features WHERE ST_Area(geom::geography) > 100000 ORDER BY cnt;"
        ],
        [
            "024",
            "SELECT COUNT(*)::bigint AS cnt FROM features WHERE properties->>'zone' = 'C' AND (NULLIF(trim(properties->>'shape_Area'),''))::double precision > 0.00001 ORDER BY cnt;"
        ]
    ],
    manningham_trees: [
        [
            "011",
            "SELECT COUNT(*)::bigint AS cnt FROM features WHERE properties->>'suburb' = 'WARRANDYTE' ORDER BY cnt;"
        ],
        [
            "012",
            "SELECT COUNT(*)::bigint AS cnt FROM features WHERE properties->>'str_type' = 'Rd' ORDER BY cnt;"
        ],
        [
            "013",
            "SELECT COUNT(*)::bigint AS cnt FROM features WHERE properties->>'treearea' = 'Area 6' ORDER BY cnt;"
        ],
        [
            "014",
            "SELECT COUNT(*)::bigint AS cnt FROM features WHERE properties->>'suburb' = 'DONCASTER EAST' AND properties->>'species' = 'Pinus radiata' ORDER BY cnt;"
        ],
        [
            "015",
            "SELECT properties->>'str_type' AS str_type, COUNT(*)::bigint AS cnt FROM features WHERE COALESCE(properties->>'str_type','') <> '' GROUP BY properties->>'str_type' ORDER BY cnt DESC, str_type ASC LIMIT 5;"
        ],
        [
            "016",
            "SELECT properties->>'treearea' AS treearea, COUNT(*)::bigint AS cnt FROM features WHERE COALESCE(properties->>'treearea','') <> '' GROUP BY properties->>'treearea' ORDER BY cnt DESC, treearea ASC LIMIT 5;"
        ],
        [
            "017",
            "SELECT properties->>'street' AS street, properties->>'suburb' AS suburb FROM features ORDER BY suburb ASC, street ASC LIMIT 10;"
        ],
        [
            "018",
            "SELECT properties->>'species' AS species, properties->>'height' AS height FROM features WHERE properties->>'height' = '15+m' ORDER BY species ASC, height ASC LIMIT 10;"
        ],
        [
            "019",
            "SELECT COUNT(*)::bigint AS cnt FROM features WHERE properties->>'dbh' = '500 - 1000mm' ORDER BY cnt;"
        ],
        [
            "020",
            "SELECT COUNT(*)::bigint AS cnt FROM features WHERE properties->>'alphatree' = 'P' ORDER BY cnt;"
        ],
        [
            "021",
            "SELECT COUNT(*)::bigint AS cnt FROM features WHERE (NULLIF(trim(properties->>'lat'),''))::double precision BETWEEN -37.79 AND -37.77 ORDER BY cnt;"
        ],
        [
            "022",
            "WITH ref AS (SELECT ST_Centroid(ST_Collect(geom)) AS ref_geom FROM features WHERE properties->>'street' = 'King' AND properties->>'str_type' = 'Str') SELECT properties->>'suburb' AS suburb, properties->>'species' AS species, ROUND(ST_Distance(f.geom::geography, ref.ref_geom::geography)::numeric, 2)::double precision AS dist_m FROM features f, ref ORDER BY dist_m ASC, suburb ASC, species ASC LIMIT 10;"
        ],
        [
            "023",
            "SELECT COUNT(*)::bigint AS cnt FROM features WHERE properties->>'street' = 'King' AND properties->>'str_type' = 'Str' ORDER BY cnt;"
        ],
        [
            "024",
            "SELECT properties->>'suburb' AS suburb, COUNT(*)::bigint AS cnt FROM features WHERE properties->>'species' = 'Eucalyptus melliodora' GROUP BY properties->>'suburb' ORDER BY cnt DESC, suburb ASC LIMIT 5;"
        ]
    ],
    road_segment: [
        [
            "011",
            "SELECT COUNT(*)::bigint AS cnt FROM features WHERE properties->>'name' = 'ROAD_SEGMENT' ORDER BY cnt;"
        ],
        [
            "012",
            "SELECT COALESCE(SUM(ST_Perimeter(geom::geography)),0)::double precision AS total_perim_m FROM features ORDER BY total_perim_m;"
        ],
        [
            "013",
            "SELECT COALESCE(AVG(ST_Perimeter(geom::geography)),0)::double precision AS avg_perim_m FROM features ORDER BY avg_perim_m;"
        ],
        [
            "014",
            "SELECT COUNT(*)::bigint AS cnt FROM features WHERE ST_Perimeter(geom::geography) > 50 ORDER BY cnt;"
        ],
        [
            "015",
            "SELECT COUNT(*)::bigint AS cnt FROM features f WHERE ST_Perimeter(f.geom::geography) > (SELECT AVG(ST_Perimeter(geom::geography)) FROM features) ORDER BY cnt;"
        ],
        [
            "016",
            "SELECT COALESCE(MAX(ST_Area(ST_MakeValid(geom)::geography)),0)::double precision AS max_area_m2 FROM features ORDER BY max_area_m2;"
        ],
        [
            "017",
            "SELECT COALESCE(MIN(ST_Area(geom::geography)),0)::double precision AS min_area_m2 FROM features WHERE ST_IsValid(geom) ORDER BY min_area_m2;"
        ],
        [
            "018",
            "SELECT ST_GeometryType(geom) AS geom_type, COUNT(*)::bigint AS cnt FROM features GROUP BY ST_GeometryType(geom) ORDER BY cnt DESC, geom_type ASC;"
        ],
        [
            "019",
            "SELECT COUNT(*)::bigint AS cnt FROM features WHERE NOT ST_IsValid(geom) ORDER BY cnt;"
        ],
        [
            "020",
            "SELECT id, ROUND(ST_Area(geom::geography)::numeric, 2)::double precision AS area_m2, ROUND(ST_Perimeter(geom::geography)::numeric, 2)::double precision AS perim_m FROM features ORDER BY area_m2 DESC, perim_m DESC, id ASC LIMIT 10;"
        ],
        [
            "021",
            "SELECT COUNT(*)::bigint AS cnt FROM features WHERE ST_Perimeter(geom::geography) > 10000 ORDER BY cnt;"
        ],
        [
            "022",
            "SELECT COUNT(*)::bigint AS cnt FROM features WHERE ST_Area(geom::geography) > 100000 ORDER BY cnt;"
        ],
        [
            "023",
            "SELECT COUNT(*)::bigint AS cnt FROM features WHERE ST_IsValid(geom) AND ST_Perimeter(geom::geography) > 1000 ORDER BY cnt;"
        ],
        [
            "024",
            "SELECT COUNT(*)::bigint AS cnt FROM features WHERE ST_Area(geom::geography) BETWEEN 1000 AND 50000 ORDER BY cnt;"
        ]
    ]
};

async function main() {
    const slug = process.argv[2] || "manningham_trees";
    const raw = JSON.parse(
        fs.readFileSync(path.join(ROOT, "eval_data", FILES[slug]), "utf8")
    );
    const { features, totalValid } = capFeatures(raw, LIMIT, slug);
    const pg = await createPg();
    await importFc(pg, { features });
    console.log(`${slug} inserted=${features.length} totalValid=${totalValid}`);
    for (const [id, sql] of PROBES[slug]) {
        try {
            const r = await pg.query(sql);
            console.log(
                `${id}\tOK\trows=${r.rows.length}\t${JSON.stringify(
                    r.rows
                ).slice(0, 180)}`
            );
        } catch (e) {
            console.log(`${id}\tERR\t${e.message}`);
        }
    }
    await pg.close();
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
