/**
 * Maps opaque fake distribution URLs (standing in for remote Magda/registry URLs)
 * to same-origin static paths served under `/eval-data/...`.
 * Used only by `getDistributionUrl` when running GeoSQL eval harnesses.
 */

const registry = new Map<string, string>();

function normalizeUrlKey(url: string): string {
    try {
        const u = new URL(
            url.trim(),
            typeof window !== "undefined"
                ? window.location.origin
                : "http://localhost"
        );
        u.hash = "";
        return u.href;
    } catch {
        return url.trim();
    }
}

export function clearEvalDistributionUrlMappings(): void {
    registry.clear();
}

/**
 * Register that fetching `fakeAbsoluteUrl` should load static assets at `sameOriginPath`
 * (must start with `/`, e.g. `/eval-data/magda/geojson/foo.geojson`).
 */
export function registerEvalDistributionMapping(
    fakeAbsoluteUrl: string,
    sameOriginStaticPath: string
): void {
    const path = sameOriginStaticPath.trim();
    if (!path.startsWith("/")) {
        throw new Error(
            `evalDistributionUrlMap: sameOriginStaticPath must be absolute path on origin: ${sameOriginStaticPath}`
        );
    }
    registry.set(normalizeUrlKey(fakeAbsoluteUrl), path);
}

/** Stable fake URL builder — pair with `registerEvalDistributionMapping`. */
export function buildGeoEvalFakeDistributionUrl(
    datasetId: string,
    resourceFileName: string
): string {
    const encDs = encodeURIComponent(datasetId);
    const encZip = encodeURIComponent(resourceFileName);
    return `https://geosql-eval.invalid/registry/dataset/${encDs}/distribution/resource/${encZip}`;
}

/**
 * If `sourceUrl` was registered, returns full same-origin URL for browser fetch.
 * Otherwise returns `sourceUrl` unchanged.
 */
export function rewriteEvalDistributionSourceUrl(sourceUrl: string): string {
    const raw = sourceUrl.trim();
    if (!raw || registry.size === 0) {
        return raw;
    }
    const key = normalizeUrlKey(raw);
    const hit = registry.get(key);
    if (!hit) {
        return raw;
    }
    if (typeof window === "undefined" || !window.location?.origin) {
        return raw;
    }
    return new URL(hit, window.location.origin).href;
}
