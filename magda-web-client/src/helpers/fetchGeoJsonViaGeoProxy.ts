import urijs from "urijs";
import { config, commonFetchRequestOptions } from "../config";

function createRequestOptions(): RequestInit {
    return {
        ...commonFetchRequestOptions,
        headers: {
            accept: "application/json,text/plain,*/*",
            ...(commonFetchRequestOptions.headers || {})
        }
    };
}

function getGeoProxyRequestUrl(targetUrl: string): string {
    const uiBaseUrl = config?.uiBaseUrl ? config.uiBaseUrl : "/";
    const endpoint = urijs(uiBaseUrl)
        .segment(["api", "geo", "proxy"])
        .toString();
    return `${endpoint}?url=${encodeURIComponent(targetUrl)}`;
}

/**
 * Same-origin URLs (e.g. webpack-served `/eval-data/...` zips for GeoSQL eval)
 * must not be forced through `/api/geo/proxy`: the server allowlist often returns
 * 403 for local/static targets while a normal same-origin fetch works.
 */
function shouldBypassGeoProxyForSameOrigin(targetUrl: string): boolean {
    if (typeof window === "undefined" || !window.location?.origin) {
        return false;
    }
    try {
        const resolved = new URL(targetUrl, window.location.origin);
        return resolved.origin === window.location.origin;
    } catch {
        return false;
    }
}

/**
 * `getDistributionUrl` / `getProxiedResourceUrl` already return a full
 * preview-map URL (`config.proxyUrl` + optional `_0d/` + upstream).
 * Sending that again through `/api/geo/proxy?url=...` double-wraps the
 * resource and breaks local dev (404 on geo proxy) or upstream (403).
 * Browser direct fetch matches dataset preview / SQL tabular loading.
 */
function shouldBypassGeoProxyForMagdaPreviewMapUrl(targetUrl: string): boolean {
    const proxy = config?.proxyUrl;
    if (!proxy || typeof targetUrl !== "string") {
        return false;
    }
    const t = targetUrl.trim();
    const p = proxy.trim();
    return t.startsWith(p);
}

async function fetchDirectOrThrow(
    url: string,
    requestOptions: RequestInit,
    label: string
): Promise<Response> {
    const res = await fetch(url, requestOptions);
    if (res.ok) {
        return res;
    }
    let errBody = "";
    try {
        errBody = (await res.text()).slice(0, 2000);
    } catch {
        // ignore
    }
    throw new Error(
        `${label} failed: ${res.status} ${res.statusText}${
            errBody ? `\n${errBody}` : ""
        }`
    );
}

async function fetchViaGeoProxy(targetUrl: string): Promise<Response> {
    const requestOptions = createRequestOptions();

    if (shouldBypassGeoProxyForMagdaPreviewMapUrl(targetUrl)) {
        return fetchDirectOrThrow(
            targetUrl.trim(),
            requestOptions,
            "Magda preview-map resource fetch"
        );
    }

    if (shouldBypassGeoProxyForSameOrigin(targetUrl)) {
        const resolved = new URL(targetUrl, window.location.origin).toString();
        return fetchDirectOrThrow(
            resolved,
            requestOptions,
            "Same-origin fetch"
        );
    }

    const requestUrl = getGeoProxyRequestUrl(targetUrl);
    let res: Response | null = null;
    try {
        res = await fetch(requestUrl, requestOptions);
    } catch (e) {
        // Network-level failure (e.g. proxy endpoint unavailable on local dev server).
        // Continue to fallback path below when possible.
        res = null;
    }
    if (res === null && config?.proxyUrl) {
        const fallbackUrl = `${config.proxyUrl}_0d/${targetUrl}`;
        const fallbackRes = await fetch(fallbackUrl, requestOptions);
        if (fallbackRes.ok) {
            return fallbackRes;
        }
        let fallbackErrBody = "";
        try {
            fallbackErrBody = (await fallbackRes.text()).slice(0, 2000);
        } catch (e) {
            // ignore
        }
        throw new Error(
            `Geo proxy fetch failed (fallback): ${fallbackRes.status} ${
                fallbackRes.statusText
            }${fallbackErrBody ? `\n${fallbackErrBody}` : ""}`
        );
    }
    if (res === null) {
        throw new Error(
            "Geo proxy fetch failed: network error and no fallback proxy configured."
        );
    }
    if (res.ok) {
        return res;
    }
    let errBody = "";
    try {
        errBody = (await res.text()).slice(0, 2000);
    } catch (e) {
        // ignore
    }

    // Fallback path for local web-client-only dev mode:
    // use existing preview-map proxy when web-server /api/geo/proxy is unavailable.
    if (res.status === 404 && config?.proxyUrl) {
        const fallbackUrl = `${config.proxyUrl}_0d/${targetUrl}`;
        const fallbackRes = await fetch(fallbackUrl, requestOptions);
        if (fallbackRes.ok) {
            return fallbackRes;
        }
        let fallbackErrBody = "";
        try {
            fallbackErrBody = (await fallbackRes.text()).slice(0, 2000);
        } catch (e) {
            // ignore
        }
        throw new Error(
            `Geo proxy fetch failed: ${fallbackRes.status} ${
                fallbackRes.statusText
            }${fallbackErrBody ? `\n${fallbackErrBody}` : ""}`
        );
    }
    throw new Error(
        `Geo proxy fetch failed: ${res.status} ${res.statusText}${
            errBody ? `\n${errBody}` : ""
        }`
    );
}

/**
 * Fetch JSON for spatial tooling. Prefer, in order:
 * - direct fetch when `targetUrl` is already a Magda preview-map proxy URL;
 * - same-origin direct fetch;
 * - GET /api/geo/proxy?url=<encoded> on the web-server (CORS-safe upstream fetch).
 */
export default async function fetchGeoJsonViaGeoProxy<T = any>(
    targetUrl: string
): Promise<T> {
    if (!targetUrl || typeof targetUrl !== "string") {
        throw new Error("Invalid targetUrl");
    }
    const res = await fetchViaGeoProxy(targetUrl);
    return (await res.json()) as T;
}

export async function fetchTextViaGeoProxy(targetUrl: string): Promise<string> {
    if (!targetUrl || typeof targetUrl !== "string") {
        throw new Error("Invalid targetUrl");
    }
    const res = await fetchViaGeoProxy(targetUrl);
    return await res.text();
}

export async function fetchArrayBufferViaGeoProxy(
    targetUrl: string
): Promise<ArrayBuffer> {
    if (!targetUrl || typeof targetUrl !== "string") {
        throw new Error("Invalid targetUrl");
    }
    const res = await fetchViaGeoProxy(targetUrl);
    return await res.arrayBuffer();
}
