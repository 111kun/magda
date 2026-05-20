/**
 * Deterministic fingerprint of PostGIS query rows for GeoSQL eval (gold vs model).
 */
function jsonReplacer(_key: string, value: unknown): unknown {
    if (typeof value === "bigint") {
        return value.toString();
    }
    return value;
}

function sortKeysDeep(value: unknown): unknown {
    if (value === null || typeof value !== "object") {
        return value;
    }
    if (Array.isArray(value)) {
        return value.map((v) => sortKeysDeep(v));
    }
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(obj).sort()) {
        out[k] = sortKeysDeep(obj[k]);
    }
    return out;
}

export function fingerprintQueryRows(rows: Record<string, unknown>[]): string {
    const normalized = rows.map((r) => sortKeysDeep(r));
    return JSON.stringify(normalized, jsonReplacer);
}
