#!/usr/bin/env node
/**
 * Load eval_data GeoJSON (5000 cap) into PGlite PostGIS and run gold SQL.
 * Usage: node magda-eval/scripts/run-gold-on-geojson.mjs [dataset_slug]
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..", "..");
const LIMIT = 5000;

const DATASETS = {
    land_zones: {
        geojson: path.join(
            ROOT,
            "eval_data",
            "LandDevelopmentZones_GDA2020.geojson"
        ),
        cases: path.join(__dirname, "..", "cases", "land_zones.jsonl")
    },
    manningham_trees: {
        geojson: path.join(
            ROOT,
            "eval_data",
            "Manningham_Street_Trees.geojson"
        ),
        cases: path.join(__dirname, "..", "cases", "manningham_trees.jsonl")
    },
    road_segment: {
        geojson: path.join(ROOT, "eval_data", "Road_Segment.geojson"),
        cases: path.join(__dirname, "..", "cases", "road_segment.jsonl")
    }
};

function capFeatures(fc, maxFeatures) {
    const features = [];
    let totalValid = 0;
    for (const f of fc.features || []) {
        if (!f?.geometry) continue;
        totalValid++;
        if (features.length < maxFeatures) features.push(f);
    }
    return { collection: { type: "FeatureCollection", features }, totalValid };
}

async function createPg() {
    const nm = path.join(ROOT, "magda", "node_modules");
    const { PGlite } = await import(
        pathToFileURL(path.join(nm, "@electric-sql/pglite/dist/index.js")).href
    );
    const { postgis } = await import(
        pathToFileURL(
            path.join(nm, "@electric-sql/pglite-postgis/dist/index.js")
        ).href
    );
    const pg = await PGlite.create({
        dataDir: "memory://magda-eval-gold",
        relaxedDurability: true,
        extensions: { postgis }
    });
    await pg.exec(`
        CREATE EXTENSION IF NOT EXISTS postgis;
        CREATE TABLE features (
            id SERIAL PRIMARY KEY,
            properties JSONB,
            geom geometry
        );
        CREATE INDEX features_gix ON features USING GIST (geom);
    `);
    return pg;
}

async function importFc(pg, fc) {
    await pg.exec("TRUNCATE features;");
    let inserted = 0;
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
        inserted++;
    }
    return inserted;
}

function loadCases(filePath) {
    return fs
        .readFileSync(filePath, "utf8")
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => JSON.parse(line));
}

async function runSql(pg, sql) {
    const r = await pg.query(sql.trim());
    return r.rows;
}

async function main() {
    const slug = process.argv[2];
    const slugs = slug ? [slug] : Object.keys(DATASETS);

    for (const s of slugs) {
        const cfg = DATASETS[s];
        if (!cfg) {
            console.error("Unknown slug:", s);
            process.exit(1);
        }
        const raw = JSON.parse(fs.readFileSync(cfg.geojson, "utf8"));
        const { collection, totalValid } = capFeatures(raw, LIMIT);
        const pg = await createPg();
        const inserted = await importFc(pg, collection);
        console.log(
            `\n=== ${s} === inserted=${inserted} totalValid=${totalValid}`
        );

        const cases = loadCases(cfg.cases);
        for (const c of cases) {
            try {
                const rows = await runSql(pg, c.gold_sql);
                console.log(
                    `${c.id}\trows=${rows.length}\t${JSON.stringify(rows).slice(
                        0,
                        200
                    )}`
                );
            } catch (e) {
                console.error(`${c.id}\tERROR\t${e.message || e}`);
            }
        }
        await pg.close();
    }
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
