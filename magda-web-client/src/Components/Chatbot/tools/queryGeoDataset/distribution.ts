import { ParsedDistribution } from "helpers/record";
import resolveDistributionResourceUrl from "helpers/resolveDistributionResourceUrl";

const SPATIAL_FORMATS = new Set([
    "SHP",
    "SHAPEFILE",
    "GEOJSON",
    "JSON",
    "KML",
    "KMZ",
    "GPX",
    "WKT",
    "WKB",
    "CSV-GEO-AU",
    "CSV_GEO_AU"
]);

function normalizeFormat(format?: string): string {
    return (format || "").trim().toUpperCase();
}

export function getDistributionUrl(dist: ParsedDistribution): string | null {
    const sourceUrl =
        dist?.accessURL?.trim() || dist?.downloadURL?.trim() || "";
    if (!sourceUrl) {
        return null;
    }
    return resolveDistributionResourceUrl(sourceUrl, {
        distributionId: dist?.identifier
    });
}

export function isGeoSpatialDistribution(dist: ParsedDistribution): boolean {
    const fmt = normalizeFormat(dist?.format);
    if (!fmt) {
        return false;
    }
    if (SPATIAL_FORMATS.has(fmt)) {
        return true;
    }
    return /(GEO|SHAPE|KML|GPX|WKT|WKB)/.test(fmt);
}
