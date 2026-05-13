#!/usr/bin/env node
/**
 * Sync GeoSQL benchmark assets into `public/eval-data/` for the browser eval runner.
 *
 * Source (repo root): ../../geosql-eval/data/hf-geosql-llm-eval/geosql_dataset
 * Dest: ../public/eval-data/{ddl,by-ddl,tiger-files,features-views,datasets-meta.json}
 *
 * Requires: `zip` CLI (macOS/Linux), Node 18+.
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { execSync } from "child_process";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const Papa = require("papaparse");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB_CLIENT_ROOT = path.resolve(__dirname, "..");
/** Capstone repo root (magda-web-client → magda → Capstone). */
const REPO_ROOT = path.resolve(WEB_CLIENT_ROOT, "../..");
const GEO_DATASET = path.join(
    REPO_ROOT,
    "geosql-eval/data/hf-geosql-llm-eval/geosql_dataset"
);
const DEST_ROOT = path.join(WEB_CLIENT_ROOT, "public/eval-data");

const DDL_FILES = [
    {
        ddl: "01-state.txt",
        id: "us-state",
        label: "TIGER US State (tl_2023_us_state)",
        tigerDir: "tl_2023_us_state",
        zipName: "tl_2023_us_state.zip"
    },
    {
        ddl: "02-county.txt",
        id: "us-county",
        label: "TIGER US County (tl_2023_us_county)",
        tigerDir: "tl_2023_us_county",
        zipName: "tl_2023_us_county.zip"
    },
    {
        ddl: "03-coastline.txt",
        id: "us-coastline",
        label: "TIGER US Coastline (tl_2023_us_coastline)",
        tigerDir: "tl_2023_us_coastline",
        zipName: "tl_2023_us_coastline.zip"
    },
    {
        ddl: "04-metropolitan.txt",
        id: "us-cbsa",
        label: "TIGER US CBSA (tl_2023_us_cbsa)",
        tigerDir: "tl_2023_us_cbsa",
        zipName: "tl_2023_us_cbsa.zip"
    },
    {
        ddl: "05-roads.txt",
        id: "us-primaryroads",
        label: "TIGER US Primary Roads (tl_2023_us_primaryroads)",
        tigerDir: "tl_2023_us_primaryroads",
        zipName: "tl_2023_us_primaryroads.zip"
    },
    {
        ddl: "06-military.txt",
        id: "us-mil",
        label: "TIGER US Military (tl_2023_us_mil)",
        tigerDir: "tl_2023_us_mil",
        zipName: "tl_2023_us_mil.zip"
    },
    {
        ddl: "07-railways.txt",
        id: "us-rails",
        label: "TIGER US Rails (tl_2023_us_rails)",
        tigerDir: "tl_2023_us_rails",
        zipName: "tl_2023_us_rails.zip"
    }
];

function readText(p) {
    return fs.readFileSync(p, "utf8");
}

function parseTableName(ddlText) {
    const m = ddlText.match(/CREATE TABLE public\.(\w+)/i);
    return m ? m[1] : null;
}

/** Parse column definitions between CREATE TABLE and closing ); */
function parseColumns(ddlText) {
    const cols = [];
    const lines = ddlText.split("\n");
    let inCols = false;
    for (const raw of lines) {
        const line = raw.trim().replace(/,$/, "");
        if (/^CREATE TABLE public\.\w+\s*\(/i.test(raw)) {
            inCols = true;
            continue;
        }
        if (!inCols) continue;
        if (!line || line === ");") break;
        if (/^CONSTRAINT\b/i.test(line)) break;
        const m = line.match(/^("([^"]+)"|(\w+))\s+(.+)$/);
        if (!m) continue;
        const name = (m[2] || m[3] || "").trim();
        const typ = (m[4] || "").trim().toLowerCase();
        if (!name) continue;
        if (
            name.toLowerCase() === "gid" &&
            /^(serial|bigserial)/i.test((typ.split(/\s+/)[0] || "").trim())
        ) {
            continue;
        }
        cols.push({ name, typ });
    }
    return cols;
}

function propExpr(colName) {
    const base = colName.replace(/"/g, "");
    const lower = base.toLowerCase();
    const upper = base.toUpperCase();
    return `COALESCE(f.properties->>'${upper}', f.properties->>'${base}', f.properties->>'${lower}')`;
}

function sqlCast(expr, typ) {
    const t = typ.toLowerCase();
    if (t.includes("float") || t.includes("double precision"))
        return `(${expr})::float8`;
    if ((t.includes("int") || t.includes("serial")) && !t.includes("geometry"))
        return `(${expr})::int`;
    return `${expr}::text`;
}

function buildViewSql(tableName, cols) {
    const lines = [`CREATE OR REPLACE VIEW ${tableName} AS`];
    lines.push("SELECT");
    const parts = ["    f.id AS gid"];
    for (const c of cols) {
        if (c.typ.includes("geometry")) continue;
        const pe = propExpr(c.name);
        const alias = c.name.replace(/"/g, "").toLowerCase();
        parts.push(`    ${sqlCast(pe, c.typ)} AS "${alias}"`);
    }
    parts.push("    f.geom AS geom");
    lines.push(parts.join(",\n"));
    lines.push("FROM features f;");
    lines.push("");
    return lines.join("\n");
}

function zipShapefolder(srcDir, outZip) {
    if (!fs.existsSync(srcDir)) {
        console.warn(`[skip zip] missing folder: ${srcDir}`);
        return false;
    }
    fs.mkdirSync(path.dirname(outZip), { recursive: true });
    const tmp = outZip + ".tmp.zip";
    if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    execSync(`zip -rq "${tmp}" .`, {
        cwd: srcDir,
        stdio: "inherit"
    });
    fs.renameSync(tmp, outZip);
    return true;
}

function main() {
    if (!fs.existsSync(GEO_DATASET)) {
        console.error(
            `GeoSQL dataset not found:\n  ${GEO_DATASET}\nClone or download hf-geosql-llm-eval under geosql-eval/data/.`
        );
        process.exit(1);
    }

    const csvPath = path.join(GEO_DATASET, "geosql-dataset .csv");
    if (!fs.existsSync(csvPath)) {
        console.error(`Missing CSV: ${csvPath}`);
        process.exit(1);
    }

    fs.mkdirSync(path.join(DEST_ROOT, "ddl"), { recursive: true });
    fs.mkdirSync(path.join(DEST_ROOT, "by-ddl"), { recursive: true });
    fs.mkdirSync(path.join(DEST_ROOT, "tiger-files"), { recursive: true });
    fs.mkdirSync(path.join(DEST_ROOT, "features-views"), { recursive: true });

    for (const entry of DDL_FILES) {
        const srcDdl = path.join(GEO_DATASET, "ddl", entry.ddl);
        const dstDdl = path.join(DEST_ROOT, "ddl", entry.ddl);
        if (!fs.existsSync(srcDdl)) {
            console.warn(`[skip] missing DDL ${srcDdl}`);
            continue;
        }
        fs.copyFileSync(srcDdl, dstDdl);
        const ddlText = readText(srcDdl);
        const tableName = parseTableName(ddlText);
        const cols = parseColumns(ddlText);
        if (tableName && cols.length) {
            const viewSql = buildViewSql(tableName, cols);
            fs.writeFileSync(
                path.join(DEST_ROOT, "features-views", `${tableName}.sql`),
                viewSql,
                "utf8"
            );
        }
    }

    const csvRaw = readText(csvPath);
    const parsed = Papa.parse(csvRaw, {
        header: true,
        skipEmptyLines: true
    });
    if (parsed.errors?.length) {
        console.warn("CSV parse warnings:", parsed.errors.slice(0, 5));
    }

    const byDdl = new Map();
    let rowIdx = 0;
    for (const row of parsed.data) {
        const ddlName = (row.ddl || "").trim();
        const q = row.natural_query;
        const sql = row.sql_query;
        if (!ddlName || !q || !sql) continue;
        const rec = {
            id: `geo-${String(++rowIdx).padStart(5, "0")}`,
            question: q,
            gold_sql: sql,
            ddl_files: [ddlName]
        };
        if (!byDdl.has(ddlName)) byDdl.set(ddlName, []);
        byDdl.get(ddlName).push(rec);
    }

    const datasetsMeta = [];

    for (const entry of DDL_FILES) {
        const rows = byDdl.get(entry.ddl) || [];
        const jsonlName = entry.ddl.replace(/\.txt$/i, ".jsonl");
        const jsonlPath = path.join(DEST_ROOT, "by-ddl", jsonlName);
        fs.writeFileSync(
            jsonlPath,
            rows.map((r) => JSON.stringify(r)).join("\n") + "\n",
            "utf8"
        );

        const ddlPath = path.join(GEO_DATASET, "ddl", entry.ddl);
        let columns = [];
        if (fs.existsSync(ddlPath)) {
            columns = parseColumns(readText(ddlPath)).map((c) =>
                c.name.replace(/"/g, "").toLowerCase()
            );
        }

        const ddlText = fs.existsSync(ddlPath) ? readText(ddlPath) : "";
        const tableName = ddlText ? parseTableName(ddlText) : entry.tigerDir;

        const tigerSrc = path.join(GEO_DATASET, "tiger_files", entry.tigerDir);
        const zipDest = path.join(DEST_ROOT, "tiger-files", entry.zipName);
        const zipped = zipShapefolder(tigerSrc, zipDest);

        datasetsMeta.push({
            id: entry.id,
            label: entry.label,
            ddl_file: entry.ddl,
            jsonl_file: jsonlName,
            zip_file: zipped ? entry.zipName : null,
            table: tableName || entry.tigerDir,
            columns,
            cases_total: rows.length,
            cases_single_table: rows.length,
            cases_multi_table: 0
        });
    }

    fs.writeFileSync(
        path.join(DEST_ROOT, "datasets-meta.json"),
        JSON.stringify(datasetsMeta, null, 2),
        "utf8"
    );

    console.log(`Wrote eval-data → ${DEST_ROOT}`);
    console.log(
        `datasets: ${datasetsMeta.length}, total cases: ${datasetsMeta.reduce(
            (s, d) => s + d.cases_total,
            0
        )}`
    );
}

main();
