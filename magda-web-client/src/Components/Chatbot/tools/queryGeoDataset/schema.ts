/**
 * Schema sampling and binding helpers for GeoSQL:
 * - Sample `features.properties` keys/types from real rows
 * - Build deterministic YAML-ready schema binding payloads
 * - Provide compact sample hints for prompt grounding
 */
import {
    importSpatialFromDistribution,
    runPostgisQuery
} from "../../../../libs/pglitePostgis";
import { ParsedDistribution } from "helpers/record";
import toYaml from "libs/toYaml";
import { getDistributionUrl } from "./distribution";

function truncateText(input: string, maxLen: number): string {
    if (!input) return "";
    return input.length > maxLen ? input.slice(0, maxLen) + "..." : input;
}

export type SampledPropertyField = {
    key: string;
    inferredType:
        | "number"
        | "string"
        | "boolean"
        | "null"
        | "object"
        | "array"
        | "mixed";
    sampleValue: string;
    recommendedAccess: "->" | "->>";
};

/** Compact per-key schema entry for LLM prompt (Map value). */
export type PropertyFieldEntry = {
    type: string;
    examples?: string[];
    distinct?: number;
};

export type PropertySchemaBinding =
    | {
          status: "ok";
          keys: Record<string, PropertyFieldEntry>;
      }
    | { status: "empty" | "sampling_failed"; message: string };

export type GeoDatasetOverview = {
    intro: string;
    fields: string[];
    geometry_summary: {
        point_like: number;
        line_like: number;
        polygon_like: number;
        other: number;
    };
    sample_size: number;
};

function inferJsonValueType(
    value: unknown
): Exclude<SampledPropertyField["inferredType"], "mixed"> {
    if (value === null || typeof value === "undefined") {
        return "null";
    }
    if (Array.isArray(value)) {
        return "array";
    }
    if (typeof value === "number") {
        return "number";
    }
    if (typeof value === "string") {
        return "string";
    }
    if (typeof value === "boolean") {
        return "boolean";
    }
    return "object";
}

function mergeInferredTypes(
    current: SampledPropertyField["inferredType"] | undefined,
    next: Exclude<SampledPropertyField["inferredType"], "mixed">
): SampledPropertyField["inferredType"] {
    if (!current) {
        return next;
    }
    return current === next ? current : "mixed";
}

export async function sampleGeoPropertySchema(
    maxRows = 8,
    maxKeys = 60
): Promise<SampledPropertyField[] | null> {
    const rows = await runPostgisQuery(
        `SELECT properties FROM features WHERE properties IS NOT NULL LIMIT ${Math.max(
            1,
            Math.floor(maxRows)
        )}`
    );
    if (!rows?.length) {
        return null;
    }

    const typedMap = new Map<
        string,
        {
            inferredType: SampledPropertyField["inferredType"];
            sampleValue: string;
        }
    >();

    for (const row of rows) {
        const p = row?.properties;
        if (!p || typeof p !== "object" || Array.isArray(p)) {
            continue;
        }
        Object.entries(p).forEach(([key, rawValue]) => {
            const inferred = inferJsonValueType(rawValue);
            const current = typedMap.get(key);
            const mergedType = mergeInferredTypes(
                current?.inferredType,
                inferred
            );
            const sampleValue =
                current?.sampleValue ||
                truncateText(
                    typeof rawValue === "string"
                        ? rawValue
                        : JSON.stringify(rawValue),
                    80
                );
            typedMap.set(key, {
                inferredType: mergedType,
                sampleValue
            });
        });
    }

    const fields = [...typedMap.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .slice(0, maxKeys)
        .map(([key, item]) => {
            const recommendedAccess: SampledPropertyField["recommendedAccess"] =
                item.inferredType === "number" ||
                item.inferredType === "boolean" ||
                item.inferredType === "object" ||
                item.inferredType === "array"
                    ? "->"
                    : "->>";
            return {
                key,
                inferredType: item.inferredType,
                sampleValue: item.sampleValue,
                recommendedAccess
            };
        });

    return fields.length ? fields : null;
}

export type GeoDistributionSampleHintOptions = {
    /** When true, only read `features` — skip import (caller already loaded spatial). */
    skipSpatialImport?: boolean;
};

export async function getGeoDistributionSampleHint(
    dist: ParsedDistribution,
    options?: GeoDistributionSampleHintOptions
): Promise<string | null> {
    const targetUrl = getDistributionUrl(dist);
    if (!targetUrl) {
        return null;
    }
    try {
        if (!options?.skipSpatialImport) {
            await importSpatialFromDistribution(
                targetUrl,
                dist.format,
                dist.title
            );
        }
        const rows = await runPostgisQuery(
            `SELECT
                id,
                properties,
                GeometryType(geom) AS geom_type,
                ST_AsText(ST_Centroid(geom)) AS sample_centroid_wkt
             FROM features
             LIMIT 1`
        );
        if (!rows?.length) {
            return null;
        }
        const row = rows[0];
        const props =
            row?.properties && typeof row.properties === "object"
                ? row.properties
                : {};
        const propertySchema = await sampleGeoPropertySchema();
        const sample = {
            sample_geom_type: row?.geom_type || null,
            sample_property_keys: Object.keys(props).slice(0, 30),
            sample_property_schema:
                propertySchema?.map((item) => ({
                    key: item.key,
                    inferred_type: item.inferredType,
                    sample_value: item.sampleValue,
                    recommended_accessor: `properties${item.recommendedAccess}'${item.key}'`
                })) || [],
            sample_properties_preview: truncateText(JSON.stringify(props), 500),
            sample_centroid_wkt: row?.sample_centroid_wkt || null
        };
        return toYaml(sample);
    } catch {
        return null;
    }
}

export async function sampleGeoPropertyKeys(): Promise<string[] | null> {
    const rows = await runPostgisQuery(
        `SELECT properties FROM features WHERE properties IS NOT NULL LIMIT 3`
    );
    if (!rows?.length) {
        return null;
    }
    const keys = new Set<string>();
    for (const row of rows) {
        const p = row?.properties;
        if (p && typeof p === "object" && !Array.isArray(p)) {
            Object.keys(p).forEach((k) => keys.add(k));
        }
    }
    return keys.size ? [...keys].sort() : null;
}

export function formatPropertySchemaForDescription(
    fields: SampledPropertyField[] | null
): PropertySchemaBinding {
    if (!fields?.length) {
        return {
            status: "empty",
            message: "No sampled keys found in properties."
        };
    }
    const keys: Record<string, PropertyFieldEntry> = {};
    for (const f of fields) {
        const entry: PropertyFieldEntry = { type: f.inferredType };
        if (f.sampleValue) {
            entry.examples = [f.sampleValue];
        }
        keys[f.key] = entry;
    }
    return { status: "ok", keys };
}

export async function sampleGeoDatasetOverview(
    maxRows = 200
): Promise<GeoDatasetOverview | null> {
    const safeLimit = Math.max(20, Math.floor(maxRows));
    const rows = await runPostgisQuery(
        `SELECT
            properties,
            GeometryType(geom) AS geom_type
         FROM features
         LIMIT ${safeLimit}`
    );
    if (!rows?.length) {
        return null;
    }

    const keys = new Set<string>(["id", "properties", "geom"]);
    let pointLike = 0;
    let lineLike = 0;
    let polygonLike = 0;
    let other = 0;

    for (const row of rows) {
        const geomType = String(row?.geom_type || "").toUpperCase();
        if (geomType.includes("POINT")) {
            pointLike++;
        } else if (geomType.includes("LINE")) {
            lineLike++;
        } else if (geomType.includes("POLYGON")) {
            polygonLike++;
        } else {
            other++;
        }

        const p = row?.properties;
        if (p && typeof p === "object" && !Array.isArray(p)) {
            Object.keys(p).forEach((k) => keys.add(k));
        }
    }

    const geometryPhrases: string[] = [];
    if (pointLike) geometryPhrases.push(`points (${pointLike})`);
    if (lineLike) geometryPhrases.push(`lines (${lineLike})`);
    if (polygonLike) geometryPhrases.push(`polygons (${polygonLike})`);
    if (other) geometryPhrases.push(`other geometries (${other})`);

    return {
        intro:
            `This dataset sample includes ${rows.length} feature rows and appears to contain ` +
            (geometryPhrases.length
                ? geometryPhrases.join(", ")
                : "mixed geometries") +
            ".",
        fields: [...keys].sort(),
        geometry_summary: {
            point_like: pointLike,
            line_like: lineLike,
            polygon_like: polygonLike,
            other
        },
        sample_size: rows.length
    };
}
