import {
    ChainInput,
    DatasetProfile,
    SpatialProfileItem,
    TabularProfileItem
} from "./commons";
import { ParsedDistribution } from "helpers/record";
import {
    importSpatialFromDistribution,
    runPostgisQuery
} from "../../libs/pglitePostgis";
import {
    getDistributionUrl,
    isGeoSpatialDistribution
} from "./tools/queryGeoDataset/distribution";

function getLocationType(pathname: string): DatasetProfile["locationType"] {
    if (pathname.includes("/dataset/")) {
        return "DATASET_PAGE";
    }
    if (pathname.includes("/distribution/")) {
        return "DISTRIBUTION_PAGE";
    }
    return "OTHERS";
}

function listDistributions(input: ChainInput): ParsedDistribution[] {
    const { dataset, distribution } = input;
    if (distribution?.identifier) {
        return [distribution];
    }
    return dataset?.distributions?.length ? dataset.distributions : [];
}

export function makeDatasetProfileVersionKey(input: ChainInput): string {
    const locationType = getLocationType(input.location?.pathname || "");
    const datasetId = input.dataset?.identifier || "no_dataset";
    const distributionId = input.distribution?.identifier || "no_distribution";
    const distributionCount = listDistributions(input).length;
    return `${locationType}|${datasetId}|${distributionId}|${distributionCount}`;
}

function makeTabularItems(dists: ParsedDistribution[]): TabularProfileItem[] {
    return dists
        .map((dist, idx) => ({
            distributionIndex: idx,
            title: dist.title,
            format: dist.format
        }))
        .filter((item) => /CSV|XLS|XLSX|JSON|TSV/i.test(item.format || ""));
}

function makeSpatialItems(dists: ParsedDistribution[]): SpatialProfileItem[] {
    return dists
        .map((dist, idx) => ({ dist, idx }))
        .filter((item) => isGeoSpatialDistribution(item.dist))
        .map((item) => ({
            distributionIndex: item.idx,
            title: item.dist.title,
            format: item.dist.format
        }));
}

export function buildDatasetProfileBase(input: ChainInput): DatasetProfile {
    const dists = listDistributions(input);
    return {
        versionKey: makeDatasetProfileVersionKey(input),
        locationType: getLocationType(input.location?.pathname || ""),
        datasetIdentifier: input.dataset?.identifier,
        datasetTitle: input.dataset?.title,
        datasetDescription: input.dataset?.description,
        datasetTags: input.dataset?.tags || [],
        datasetThemes: input.dataset?.themes || [],
        distributionCount: dists.length,
        tabular: {
            status: "not_loaded",
            items: makeTabularItems(dists)
        },
        spatial: {
            status: "not_loaded",
            items: makeSpatialItems(dists)
        }
    };
}

export async function enrichTabularProfile(
    _input: ChainInput,
    profile: DatasetProfile
): Promise<void> {
    profile.tabular.status = "ready";
    profile.tabular.updatedAt = Date.now();
}

export async function enrichSpatialProfile(
    input: ChainInput,
    profile: DatasetProfile
): Promise<void> {
    const dists = listDistributions(input);
    const items: SpatialProfileItem[] = [];
    for (const item of profile.spatial.items) {
        const dist = dists[item.distributionIndex];
        const targetUrl = dist ? getDistributionUrl(dist) : null;
        if (!dist || !targetUrl) {
            items.push(item);
            continue;
        }
        try {
            await importSpatialFromDistribution(
                targetUrl,
                dist.format,
                dist.title,
                {
                    maxFeatures: 500
                }
            );
            const geomTypesRows = await runPostgisQuery(
                `SELECT GeometryType(geom) AS geom_type, COUNT(*)::int AS cnt
                 FROM features
                 WHERE geom IS NOT NULL
                 GROUP BY 1
                 ORDER BY 2 DESC
                 LIMIT 8`
            );
            const keyRows = await runPostgisQuery(
                `SELECT DISTINCT key
                 FROM features,
                      LATERAL jsonb_object_keys(properties) AS key
                 WHERE properties IS NOT NULL
                 LIMIT 60`
            );
            items.push({
                ...item,
                geometryTypes: (geomTypesRows || []).map((row) => ({
                    type: String(row.geom_type || ""),
                    count: Number(row.cnt || 0)
                })),
                propertyKeys: (keyRows || [])
                    .map((row) => String(row.key || "").trim())
                    .filter((key) => !!key),
                sampledFeatureCount: 500
            });
        } catch {
            items.push({
                ...item,
                error: "spatial profile sampling failed"
            });
        }
    }
    profile.spatial.items = items;
    profile.spatial.status = "ready";
    profile.spatial.updatedAt = Date.now();
}
