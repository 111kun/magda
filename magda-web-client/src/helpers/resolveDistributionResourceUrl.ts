import { config } from "../config";
import getProxiedResourceUrl from "./getProxiedResourceUrl";

type Options = {
    disableCache?: boolean;
    distributionId?: string;
};

export default function resolveDistributionResourceUrl(
    sourceUrl: string,
    options?: Options
): string {
    const enableEvalApi = !!config?.evalLocalDistributionApiEnabled;
    const evalApiPath = config?.evalLocalDistributionApiPath;

    if (enableEvalApi && evalApiPath) {
        const params = new URLSearchParams();
        if (sourceUrl) {
            params.set("sourceUrl", sourceUrl);
        }
        if (options?.distributionId) {
            params.set("distributionId", options.distributionId);
        }
        const sep = evalApiPath.includes("?") ? "&" : "?";
        return `${evalApiPath}${sep}${params.toString()}`;
    }
    return getProxiedResourceUrl(sourceUrl, options?.disableCache);
}
