import getProxiedResourceUrl from "./getProxiedResourceUrl";

type Options = {
    disableCache?: boolean;
};

export default function resolveDistributionResourceUrl(
    sourceUrl: string,
    options?: Options
): string {
    return getProxiedResourceUrl(sourceUrl, options?.disableCache);
}
