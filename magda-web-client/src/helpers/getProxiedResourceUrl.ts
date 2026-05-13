import { config } from "../config";
import isStorageApiUrl from "./isStorageApiUrl";
import getStorageApiResourceAccessUrl from "./getStorageApiResourceAccessUrl";

/**
 * When the UI runs on localhost but `config.proxyUrl` points at a remote Magda
 * (e.g. dev.magda.io), wrapping a same-origin URL like
 * `http://localhost:6108/eval-data/...` makes the *remote* server fetch loopback —
 * blocked as SSRF → 403. The browser can fetch same-origin resources directly.
 */
function isBrowserSameOriginResource(resourceUrl: string): boolean {
    if (typeof window === "undefined" || !window.location?.origin) {
        return false;
    }
    try {
        const resolved = new URL(resourceUrl, window.location.origin);
        return resolved.origin === window.location.origin;
    } catch {
        return false;
    }
}

export default function getProxiedResourceUrl(
    resourceUrl: string,
    disableCache: boolean = false
) {
    if (isStorageApiUrl(resourceUrl)) {
        return getStorageApiResourceAccessUrl(resourceUrl);
    }
    if (isBrowserSameOriginResource(resourceUrl)) {
        return resourceUrl;
    }
    return config.proxyUrl + (disableCache ? "_0d/" : "") + resourceUrl;
}
