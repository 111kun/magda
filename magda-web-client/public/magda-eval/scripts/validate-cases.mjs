#!/usr/bin/env node
/**
 * Validate magda-eval JSONL case files (schema + parseability).
 * Usage: node magda-eval/scripts/validate-cases.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CASES_DIR = path.join(__dirname, "..", "cases");
const ALLOWED_SLUGS = new Set([
    "land_zones",
    "manningham_trees",
    "road_segment"
]);

const REQUIRED = ["id", "dataset_slug", "question", "gold_sql"];

function loadJsonl(filePath) {
    const text = fs.readFileSync(filePath, "utf8");
    const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
    const rows = [];
    for (let i = 0; i < lines.length; i++) {
        let obj;
        try {
            obj = JSON.parse(lines[i]);
        } catch (e) {
            throw new Error(`${filePath}:${i + 1}: invalid JSON: ${e}`);
        }
        rows.push({ line: i + 1, obj });
    }
    return rows;
}

function validateRow(filePath, lineNo, obj) {
    for (const k of REQUIRED) {
        if (obj[k] == null || String(obj[k]).trim() === "") {
            throw new Error(`${filePath}:${lineNo}: missing or empty "${k}"`);
        }
    }
    if (!ALLOWED_SLUGS.has(obj.dataset_slug)) {
        throw new Error(
            `${filePath}:${lineNo}: dataset_slug must be one of ${[
                ...ALLOWED_SLUGS
            ].join(", ")}`
        );
    }
    const sql = String(obj.gold_sql).trim();
    if (!/^(select|with)\b/i.test(sql)) {
        throw new Error(
            `${filePath}:${lineNo}: gold_sql must start with SELECT or WITH`
        );
    }
    if (/\b(insert|update|delete|drop|alter|truncate|create)\b/i.test(sql)) {
        throw new Error(`${filePath}:${lineNo}: gold_sql must be read-only`);
    }
    if (obj.distribution_index != null) {
        const d = obj.distribution_index;
        if (!Number.isInteger(d) || d < 0) {
            throw new Error(
                `${filePath}:${lineNo}: distribution_index must be a non-negative integer`
            );
        }
    }
    if (obj.tags != null && !Array.isArray(obj.tags)) {
        throw new Error(`${filePath}:${lineNo}: tags must be an array if set`);
    }
}

function main() {
    const files = fs
        .readdirSync(CASES_DIR)
        .filter((f) => f.endsWith(".jsonl"))
        .sort();
    if (!files.length) {
        console.error("No .jsonl files in", CASES_DIR);
        process.exit(1);
    }
    let total = 0;
    for (const f of files) {
        const fp = path.join(CASES_DIR, f);
        const rows = loadJsonl(fp);
        for (const { line, obj } of rows) {
            validateRow(fp, line, obj);
        }
        console.log(`${f}: ${rows.length} case(s) OK`);
        total += rows.length;
    }
    console.log(`Total: ${total} case(s) across ${files.length} file(s).`);
}

try {
    main();
} catch (e) {
    console.error(e.message || e);
    process.exit(1);
}
