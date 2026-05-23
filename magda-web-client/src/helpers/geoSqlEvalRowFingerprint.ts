/**
 * GeoSQL eval Layer B: semantic result comparison (no strict JSON row fingerprint).
 */
export type GeoSqlResultMatchMode = "scalar" | "rows" | "none";

export type GeoSqlResultCompare = {
    match: boolean;
    mode: GeoSqlResultMatchMode;
};

const SCALAR_ABS_EPS = 1e-9;
const SCALAR_REL_EPS = 1e-6;

function coerceToNumber(value: unknown): number | null {
    if (value === null || value === undefined) {
        return 0;
    }
    if (typeof value === "number") {
        return Number.isFinite(value) ? value : null;
    }
    if (typeof value === "bigint") {
        return Number(value);
    }
    if (typeof value === "string") {
        const t = value.trim();
        if (!t) {
            return null;
        }
        const n = Number(t);
        return Number.isFinite(n) ? n : null;
    }
    return null;
}

function numbersClose(a: number, b: number): boolean {
    const diff = Math.abs(a - b);
    if (diff <= SCALAR_ABS_EPS) {
        return true;
    }
    const scale = Math.max(1, Math.abs(a), Math.abs(b));
    return diff / scale <= SCALAR_REL_EPS;
}

function sortedNumericValues(rows: Record<string, unknown>[]): number[] {
    const nums: number[] = [];
    for (const row of rows) {
        for (const v of Object.values(row)) {
            const n = coerceToNumber(v);
            if (n !== null) {
                nums.push(n);
            }
        }
    }
    return nums.sort((a, b) => a - b);
}

function rowIsNumericScalar(row: Record<string, unknown>): boolean {
    const values = Object.values(row);
    if (!values.length) {
        return false;
    }
    return values.every((v) => coerceToNumber(v) !== null);
}

export function isScalarResultSet(rows: Record<string, unknown>[]): boolean {
    return rows.length === 1 && rowIsNumericScalar(rows[0]);
}

function scalarNumericMatch(
    goldRows: Record<string, unknown>[],
    modelRows: Record<string, unknown>[]
): boolean {
    const goldNums = sortedNumericValues(goldRows);
    const modelNums = sortedNumericValues(modelRows);
    if (goldNums.length !== modelNums.length) {
        return false;
    }
    for (let i = 0; i < goldNums.length; i++) {
        if (!numbersClose(goldNums[i], modelNums[i])) {
            return false;
        }
    }
    return true;
}

/** Map-preview columns appended by sanitizer / SQL Console — not part of gold eval answers. */
function isMapAuxiliaryColumn(key: string): boolean {
    return /^(geom_wkt|geom_geojson|geojson|wkt)$/i.test((key || "").trim());
}

/** Row signature: sorted text dims + sorted numeric measures (ignores map-only columns). */
function rowComparableSignature(row: Record<string, unknown>): string {
    const texts: string[] = [];
    const nums: number[] = [];
    for (const [key, v] of Object.entries(row)) {
        if (isMapAuxiliaryColumn(key)) {
            continue;
        }
        if (v === null || v === undefined) {
            continue;
        }
        const asNum = coerceToNumber(v);
        if (typeof v === "number" || typeof v === "bigint") {
            if (asNum !== null) {
                nums.push(asNum);
            }
            continue;
        }
        if (typeof v === "string") {
            const t = v.trim();
            if (!t) {
                continue;
            }
            const parsed = Number(t);
            if (
                Number.isFinite(parsed) &&
                /^-?\d+(?:\.\d+)?$/.test(t.replace(/,/g, ""))
            ) {
                nums.push(parsed);
            } else {
                texts.push(t.toLowerCase());
            }
            continue;
        }
        texts.push(String(v).toLowerCase());
    }
    texts.sort();
    nums.sort((a, b) => a - b);
    return `${texts.join("\u001f")}\u001e${nums.join(",")}`;
}

function rowSetMatch(
    goldRows: Record<string, unknown>[],
    modelRows: Record<string, unknown>[]
): boolean {
    const goldSigs = goldRows.map(rowComparableSignature).sort();
    const modelSigs = modelRows.map(rowComparableSignature).sort();
    if (goldSigs.length !== modelSigs.length) {
        return false;
    }
    for (let i = 0; i < goldSigs.length; i++) {
        if (goldSigs[i] !== modelSigs[i]) {
            return false;
        }
    }
    return true;
}

export function compareQueryResults(
    goldRows: Record<string, unknown>[],
    modelRows: Record<string, unknown>[]
): GeoSqlResultCompare {
    if (goldRows.length !== modelRows.length) {
        return { match: false, mode: "none" };
    }
    if (!goldRows.length) {
        return { match: true, mode: "scalar" };
    }

    const goldScalar = isScalarResultSet(goldRows);
    const modelScalar = isScalarResultSet(modelRows);

    if (goldScalar && modelScalar) {
        return {
            match: scalarNumericMatch(goldRows, modelRows),
            mode: "scalar"
        };
    }

    return {
        match: rowSetMatch(goldRows, modelRows),
        mode: "rows"
    };
}

/** Human-readable signature for reports (not used for strict JSON fingerprint equality). */
export function rowsToComparableSignature(
    rows: Record<string, unknown>[]
): string {
    return JSON.stringify(rows.map(rowComparableSignature).sort());
}
