#!/usr/bin/env node
/**
 * Sync Magda-hosted eval fixtures into public/eval-data/magda/.
 *
 * Source: ../../eval_data/magda-eval/ and ../../eval_data/*.geojson
 * Dest:   ../public/eval-data/magda/{cases,geojson,schema}
 *         ../public/eval-data/magda-datasets-meta.json
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB_CLIENT_ROOT = path.resolve(__dirname, "..");
const REPO_ROOT = path.resolve(WEB_CLIENT_ROOT, "../..");
const MAGDA_EVAL = path.join(REPO_ROOT, "eval_data/magda-eval");
const EVAL_GEOJSON = path.join(REPO_ROOT, "eval_data");
const DEST_MAGDA = path.join(WEB_CLIENT_ROOT, "public/eval-data/magda");
const DEST_META = path.join(
    WEB_CLIENT_ROOT,
    "public/eval-data/magda-datasets-meta.json"
);

function ensureDir(p) {
    fs.mkdirSync(p, { recursive: true });
}

function copyFile(src, dest) {
    ensureDir(path.dirname(dest));
    fs.copyFileSync(src, dest);
}

function main() {
    const metaPath = path.join(MAGDA_EVAL, "datasets-meta.json");
    if (!fs.existsSync(metaPath)) {
        console.error(`Missing ${metaPath}`);
        process.exit(1);
    }
    const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));

    ensureDir(path.join(DEST_MAGDA, "cases"));
    ensureDir(path.join(DEST_MAGDA, "geojson"));
    ensureDir(path.join(DEST_MAGDA, "schema"));

    for (const entry of meta) {
        const casesSrc = path.join(MAGDA_EVAL, "cases", entry.jsonl_file);
        if (!fs.existsSync(casesSrc)) {
            console.error(`Missing cases: ${casesSrc}`);
            process.exit(1);
        }
        copyFile(casesSrc, path.join(DEST_MAGDA, "cases", entry.jsonl_file));

        const schemaSrc = path.join(MAGDA_EVAL, "schema", entry.ddl_file);
        if (fs.existsSync(schemaSrc)) {
            copyFile(
                schemaSrc,
                path.join(DEST_MAGDA, "schema", entry.ddl_file)
            );
        }

        if (entry.geojson_file) {
            const gjSrc = path.join(EVAL_GEOJSON, entry.geojson_file);
            if (!fs.existsSync(gjSrc)) {
                console.error(`Missing GeoJSON: ${gjSrc}`);
                process.exit(1);
            }
            copyFile(
                gjSrc,
                path.join(DEST_MAGDA, "geojson", entry.geojson_file)
            );
        }
    }

    fs.writeFileSync(DEST_META, JSON.stringify(meta, null, 2), "utf8");
    console.log(`Wrote Magda eval assets → ${DEST_MAGDA}`);
    console.log(`Wrote ${DEST_META} (${meta.length} dataset(s))`);
}

main();
