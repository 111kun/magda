import type { PGlite as PGliteType } from "@electric-sql/pglite";
import fetchGeoJsonViaGeoProxy, {
    fetchArrayBufferViaGeoProxy,
    fetchTextViaGeoProxy
} from "../helpers/fetchGeoJsonViaGeoProxy";
import Papa from "papaparse";
import { kml as kmlToGeoJson } from "@tmcw/togeojson";
import shp from "shpjs";

type GeoFeature = {
    type: "Feature";
    geometry: any;
    properties?: Record<string, any> | null;
};

type GeoFeatureCollection = {
    type: "FeatureCollection";
    features: GeoFeature[];
};

export const DEFAULT_SPATIAL_IMPORT_FEATURE_LIMIT = 5000;

export type ImportSpatialResult = {
    inserted: number;
    totalFeatures: number;
    skippedFeatures: number;
    maxFeatures: number;
    truncated: boolean;
};

let pgPromise: Promise<PGliteType> | null = null;

let loadedDistribution: {
    url: string;
    inserted: number;
    maxFeatures: number;
} | null = null;

export function getLoadedDistribution() {
    return loadedDistribution;
}

function normalizeImportLimit(maxFeatures?: number): number {
    if (
        typeof maxFeatures === "number" &&
        Number.isFinite(maxFeatures) &&
        maxFeatures > 0
    ) {
        return Math.floor(maxFeatures);
    }
    return DEFAULT_SPATIAL_IMPORT_FEATURE_LIMIT;
}

export function formatImportSpatialResult(result: ImportSpatialResult): string {
    const base = `${result.inserted} feature(s) inserted into 'features'.`;
    if (!result.truncated) {
        return base;
    }
    return `${base} Import was capped at ${result.maxFeatures} of ${result.totalFeatures} feature(s) to keep the browser responsive.`;
}

function addOrUpdateUrlParam(url: string, key: string, value: string) {
    const u = new URL(url, window.location.origin);
    u.searchParams.set(key, value);
    return u.toString();
}

function getUrlParamValue(url: string, keys: string[]): string | null {
    const u = new URL(url, window.location.origin);
    for (const key of keys) {
        const val = u.searchParams.get(key);
        if (val) return val;
    }
    return null;
}

function normalizeFormat(format?: string): string {
    return (format || "").trim().toUpperCase();
}

async function discoverWfsTypeName(targetUrl: string): Promise<string | null> {
    try {
        const capsUrl = addOrUpdateUrlParam(
            addOrUpdateUrlParam(targetUrl, "service", "WFS"),
            "request",
            "GetCapabilities"
        );
        const xmlText = await fetchTextViaGeoProxy(capsUrl);
        const parser = new DOMParser();
        const xml = parser.parseFromString(xmlText, "text/xml");
        const names = Array.from(xml.getElementsByTagName("Name"))
            .map((n) => n.textContent?.trim() || "")
            .filter((x) => !!x);
        return names.length ? names[0] : null;
    } catch (e) {
        return null;
    }
}

function normalizeToFeatureCollection(input: any): GeoFeatureCollection {
    if (!input || typeof input !== "object") {
        throw new Error("GeoJSON payload is invalid");
    }
    if (input.type === "FeatureCollection" && Array.isArray(input.features)) {
        return input as GeoFeatureCollection;
    }
    if (input.type === "Feature") {
        return { type: "FeatureCollection", features: [input as GeoFeature] };
    }
    if (typeof input.type === "string") {
        return {
            type: "FeatureCollection",
            features: [{ type: "Feature", geometry: input, properties: null }]
        };
    }
    throw new Error("Unsupported GeoJSON structure");
}

/** Count geometries with valid geom; keep at most maxFeatures for import. */
function capFeatureCollectionAtParse(
    fc: GeoFeatureCollection,
    maxFeatures: number
): { collection: GeoFeatureCollection; totalValid: number } {
    const limit = normalizeImportLimit(maxFeatures);
    const capped: GeoFeature[] = [];
    let totalValid = 0;
    for (const f of fc.features) {
        if (!f?.geometry) {
            continue;
        }
        totalValid++;
        if (capped.length < limit) {
            capped.push(f);
        }
    }
    return {
        collection: { type: "FeatureCollection", features: capped },
        totalValid
    };
}

function addWfsFeatureCountCap(url: string, maxFeatures: number): string {
    const n = String(normalizeImportLimit(maxFeatures));
    return addOrUpdateUrlParam(
        addOrUpdateUrlParam(url, "count", n),
        "maxFeatures",
        n
    );
}

async function createInstance(): Promise<PGliteType> {
    const [{ PGlite }, { postgis }] = await Promise.all([
        import(
            /* webpackChunkName: "pglite" */ "@electric-sql/pglite"
        ) as Promise<typeof import("@electric-sql/pglite")>,
        import(
            /* webpackChunkName: "pglite-postgis" */ "@electric-sql/pglite-postgis"
        ) as Promise<typeof import("@electric-sql/pglite-postgis")>
    ]);

    const pg = await PGlite.create({
        dataDir: "idb://magda-pglite",
        relaxedDurability: true,
        extensions: { postgis }
    });
    await pg.exec(`
        CREATE EXTENSION IF NOT EXISTS postgis;
        CREATE TABLE IF NOT EXISTS features (
            id SERIAL PRIMARY KEY,
            properties JSONB,
            geom geometry
        );
        CREATE INDEX IF NOT EXISTS features_gix ON features USING GIST (geom);
    `);
    return pg;
}

export async function getPGlitePostgis(): Promise<PGliteType> {
    if (!pgPromise) pgPromise = createInstance();
    return await pgPromise;
}

export async function runPostgisQuery(
    query: string,
    params?: any[]
): Promise<Record<string, any>[]> {
    const pg = await getPGlitePostgis();
    const stmt = query.trim();
    const looksMulti =
        stmt.split(";").filter((s: string) => s.trim()).length > 1;
    if (looksMulti) {
        const ret = await pg.exec(stmt);
        const lastWithRows = [...ret]
            .reverse()
            .find((r: any) => r?.rows?.length);
        if (lastWithRows?.rows) return lastWithRows.rows as any;
        return ret.map((r: any, idx: number) => ({
            statement: idx + 1,
            affectedRows:
                typeof r?.affectedRows === "number" ? r.affectedRows : null
        }));
    }
    const result = await pg.query(stmt, params);
    if (result?.rows) return result.rows as any;
    return [{ "Query result:": "No result returned." }];
}

export async function importGeoJsonFromUrl(
    targetUrl: string
): Promise<ImportSpatialResult> {
    return importSpatialFromDistribution(targetUrl, "GEOJSON");
}

function toFeatureCollectionFromCsv(
    text: string,
    maxFeatures?: number
): { collection: GeoFeatureCollection; totalValid: number } {
    const parsed = Papa.parse<Record<string, any>>(text, {
        header: true,
        skipEmptyLines: true
    });
    if (parsed.errors?.length) {
        throw new Error(`CSV parse failed: ${parsed.errors[0]?.message}`);
    }
    const rows = parsed.data || [];
    if (!rows.length) {
        return {
            collection: { type: "FeatureCollection", features: [] },
            totalValid: 0
        };
    }

    const first = rows[0];
    const keyMap = Object.keys(first).reduce<Record<string, string>>(
        (acc, k) => {
            acc[k.trim().toLowerCase()] = k;
            return acc;
        },
        {}
    );

    const lonKey =
        keyMap["lon"] ||
        keyMap["lng"] ||
        keyMap["longitude"] ||
        keyMap["x"] ||
        "";
    const latKey = keyMap["lat"] || keyMap["latitude"] || keyMap["y"] || "";
    if (!lonKey || !latKey) {
        throw new Error("Cannot detect lat/lon columns from CSV.");
    }

    const limit =
        typeof maxFeatures === "number" && maxFeatures > 0
            ? normalizeImportLimit(maxFeatures)
            : Number.POSITIVE_INFINITY;
    const features: GeoFeature[] = [];
    let totalValid = 0;
    for (const r of rows) {
        const lon = Number(r[lonKey]);
        const lat = Number(r[latKey]);
        if (!Number.isFinite(lon) || !Number.isFinite(lat)) {
            continue;
        }
        totalValid++;
        if (features.length < limit) {
            features.push({
                type: "Feature",
                geometry: { type: "Point", coordinates: [lon, lat] },
                properties: r ?? null
            });
        }
    }

    return {
        collection: { type: "FeatureCollection", features },
        totalValid
    };
}

async function toFeatureCollectionFromDistribution(
    targetUrl: string,
    format?: string,
    distributionTitle?: string,
    maxFeatures?: number
): Promise<{ collection: GeoFeatureCollection; totalValid: number }> {
    const fmt = normalizeFormat(format);
    const capLimit =
        typeof maxFeatures === "number" && maxFeatures > 0
            ? normalizeImportLimit(maxFeatures)
            : null;
    const finish = (fc: GeoFeatureCollection) => {
        if (capLimit != null) {
            return capFeatureCollectionAtParse(fc, capLimit);
        }
        let totalValid = 0;
        for (const f of fc.features) {
            if (f?.geometry) {
                totalValid++;
            }
        }
        return { collection: fc, totalValid };
    };

    if (fmt === "CSV-GEO-AU") {
        const text = await fetchTextViaGeoProxy(targetUrl);
        return toFeatureCollectionFromCsv(text, maxFeatures);
    }

    if (fmt === "WFS") {
        const typeNameFromUrl = getUrlParamValue(targetUrl, [
            "typeNames",
            "TYPENAMES",
            "typeName",
            "typename",
            "TYPENAME"
        ]);
        const discoveredTypeName = typeNameFromUrl
            ? null
            : await discoverWfsTypeName(targetUrl);
        const fallbackTypeName =
            typeNameFromUrl || discoveredTypeName || distributionTitle || null;

        const baseGetFeature = addOrUpdateUrlParam(
            addOrUpdateUrlParam(targetUrl, "service", "WFS"),
            "request",
            "GetFeature"
        );
        const baseWithTypeName = fallbackTypeName
            ? addOrUpdateUrlParam(baseGetFeature, "typeName", fallbackTypeName)
            : baseGetFeature;
        const baseWithTypeNames = fallbackTypeName
            ? addOrUpdateUrlParam(baseGetFeature, "typeNames", fallbackTypeName)
            : baseGetFeature;

        const wfsCandidates = [
            addOrUpdateUrlParam(
                baseWithTypeName,
                "outputFormat",
                "application/json"
            ),
            addOrUpdateUrlParam(baseWithTypeName, "outputFormat", "json"),
            addOrUpdateUrlParam(baseWithTypeName, "outputFormat", "geojson"),
            addOrUpdateUrlParam(
                addOrUpdateUrlParam(baseWithTypeName, "version", "2.0.0"),
                "outputFormat",
                "application/json"
            ),
            addOrUpdateUrlParam(
                addOrUpdateUrlParam(baseWithTypeName, "version", "1.1.0"),
                "outputFormat",
                "application/json"
            ),
            addOrUpdateUrlParam(
                baseWithTypeNames,
                "outputFormat",
                "application/json"
            ),
            addOrUpdateUrlParam(baseWithTypeNames, "outputFormat", "json"),
            addOrUpdateUrlParam(baseWithTypeNames, "outputFormat", "geojson"),
            addOrUpdateUrlParam(
                addOrUpdateUrlParam(baseWithTypeNames, "version", "2.0.0"),
                "outputFormat",
                "application/json"
            ),
            addOrUpdateUrlParam(
                addOrUpdateUrlParam(baseWithTypeNames, "version", "1.1.0"),
                "outputFormat",
                "application/json"
            ),
            baseWithTypeName,
            baseWithTypeNames,
            targetUrl
        ];
        const uniqueCandidates = [
            ...new Set(
                capLimit != null
                    ? wfsCandidates.map((u) =>
                          addWfsFeatureCountCap(u, capLimit)
                      )
                    : wfsCandidates
            )
        ];
        let lastError: unknown = null;
        for (const wfsUrl of uniqueCandidates) {
            try {
                const raw = await fetchGeoJsonViaGeoProxy<any>(wfsUrl);
                return finish(normalizeToFeatureCollection(raw));
            } catch (e) {
                lastError = e;
            }
        }
        throw new Error(
            `WFS fetch failed after ${
                uniqueCandidates.length
            } attempts: ${String(lastError)}`
        );
    }

    if (fmt === "KML") {
        const text = await fetchTextViaGeoProxy(targetUrl);
        const parser = new DOMParser();
        const xml = parser.parseFromString(text, "text/xml");
        const raw = kmlToGeoJson(xml as any);
        return finish(normalizeToFeatureCollection(raw));
    }

    if (
        fmt === "SHP" ||
        fmt === "SHAPEFILE" ||
        targetUrl.toLowerCase().endsWith(".zip")
    ) {
        const buffer = await fetchArrayBufferViaGeoProxy(targetUrl);
        const raw = await shp(buffer);
        if (Array.isArray(raw)) {
            const merged: GeoFeature[] = raw
                .filter((fc) => fc?.type === "FeatureCollection")
                .flatMap((fc) => fc.features || []);
            return finish({
                type: "FeatureCollection",
                features: merged
            });
        }
        return finish(normalizeToFeatureCollection(raw));
    }

    // Default path: treat as GeoJSON.
    const raw = await fetchGeoJsonViaGeoProxy<any>(targetUrl);
    return finish(normalizeToFeatureCollection(raw));
}

export async function importSpatialFromDistribution(
    targetUrl: string,
    format?: string,
    distributionTitle?: string,
    options?: { maxFeatures?: number }
): Promise<ImportSpatialResult> {
    const pg = await getPGlitePostgis();
    const maxFeatures = normalizeImportLimit(options?.maxFeatures);
    const {
        collection: fc,
        totalValid
    } = await toFeatureCollectionFromDistribution(
        targetUrl,
        format,
        distributionTitle,
        maxFeatures
    );
    const importFeatures = fc.features;

    await pg.exec("TRUNCATE features;");
    let inserted = 0;
    for (const f of importFeatures) {
        await pg.query(
            `WITH g AS (
                SELECT ST_GeomFromGeoJSON($2) AS raw_geom
             )
             INSERT INTO features (properties, geom)
             SELECT
                $1::jsonb,
                CASE
                    WHEN raw_geom IS NULL THEN NULL
                    -- Heuristic A: projected meter coordinates (very likely EPSG:3857).
                    WHEN
                        (
                            abs(ST_XMin(raw_geom)) > 180 OR
                            abs(ST_XMax(raw_geom)) > 180 OR
                            abs(ST_YMin(raw_geom)) > 90 OR
                            abs(ST_YMax(raw_geom)) > 90
                        )
                        AND
                        (
                            abs(ST_XMin(raw_geom)) > 1000 OR
                            abs(ST_XMax(raw_geom)) > 1000 OR
                            abs(ST_YMin(raw_geom)) > 1000 OR
                            abs(ST_YMax(raw_geom)) > 1000
                        )
                    THEN ST_Transform(ST_SetSRID(raw_geom, 3857), 4326)
                    -- Heuristic B: lon/lat swapped (x within latitude range, y within longitude range).
                    WHEN
                        abs(ST_XMin(raw_geom)) <= 90 AND
                        abs(ST_XMax(raw_geom)) <= 90 AND
                        abs(ST_YMin(raw_geom)) <= 180 AND
                        abs(ST_YMax(raw_geom)) <= 180
                    THEN ST_SetSRID(ST_FlipCoordinates(raw_geom), 4326)
                    -- Default: treat as standard lon/lat GeoJSON.
                    ELSE ST_SetSRID(raw_geom, 4326)
                END
             FROM g;`,
            [f.properties ?? null, JSON.stringify(f.geometry)]
        );
        inserted++;
    }
    loadedDistribution = { url: targetUrl, inserted, maxFeatures };
    return {
        inserted,
        totalFeatures: totalValid,
        skippedFeatures: Math.max(totalValid - inserted, 0),
        maxFeatures,
        truncated: totalValid > inserted
    };
}
