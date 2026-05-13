import {
    ChainInput,
    DatasetProfile,
    SpatialProfileItem,
    TabularProfileItem,
    ValueSampleProfile
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

function quoteSqlLiteral(value: string): string {
    return `'${value.replace(/'/g, "''")}'`;
}

async function sampleValueProfilesForKeys(
    propertyKeys: string[]
): Promise<Record<string, ValueSampleProfile>> {
    const result: Record<string, ValueSampleProfile> = {};
    const candidateKeys = propertyKeys.slice(0, 24);
    for (const key of candidateKeys) {
        const keyLiteral = quoteSqlLiteral(key);
        const distinctRows = await runPostgisQuery(
            `SELECT COUNT(DISTINCT properties->>${keyLiteral})::int AS distinct_cnt
             FROM features
             WHERE properties ? ${keyLiteral}
               AND jsonb_typeof(properties->${keyLiteral}) = 'string'
               AND COALESCE(properties->>${keyLiteral}, '') <> ''`
        );
        const distinctCnt = Number(distinctRows?.[0]?.distinct_cnt || 0);
        if (!distinctCnt || distinctCnt <= 1) {
            continue;
        }
        if (distinctCnt <= 50) {
            const valuesRows = await runPostgisQuery(
                `SELECT DISTINCT properties->>${keyLiteral} AS value
                 FROM features
                 WHERE properties ? ${keyLiteral}
                   AND jsonb_typeof(properties->${keyLiteral}) = 'string'
                   AND COALESCE(properties->>${keyLiteral}, '') <> ''
                 ORDER BY 1
                 LIMIT 50`
            );
            const values = (valuesRows || [])
                .map((row) => String(row?.value || "").trim())
                .filter((v) => !!v);
            if (values.length) {
                result[key] = {
                    mode: "full",
                    values,
                    approxDistinct: distinctCnt
                };
            }
            continue;
        }
        const topRows = await runPostgisQuery(
            `SELECT properties->>${keyLiteral} AS value, COUNT(*)::int AS cnt
             FROM features
             WHERE properties ? ${keyLiteral}
               AND jsonb_typeof(properties->${keyLiteral}) = 'string'
               AND COALESCE(properties->>${keyLiteral}, '') <> ''
             GROUP BY 1
             ORDER BY cnt DESC
             LIMIT 12`
        );
        const values = (topRows || [])
            .map((row) => String(row?.value || "").trim())
            .filter((v) => !!v);
        if (values.length) {
            result[key] = {
                mode: "partial",
                values,
                approxDistinct: distinctCnt
            };
        }
    }
    return result;
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

    type SampledProfile = {
        geometryTypes: { type: string; count: number }[];
        propertyKeys: string[];
        sampleRows: Record<string, any>[];
        valueSamples: Record<string, ValueSampleProfile>;
        sampledFeatureCount: number;
    };
    let firstSuccessProfile: SampledProfile | null = null;

    for (const item of profile.spatial.items) {
        const dist = dists[item.distributionIndex];
        const targetUrl = dist ? getDistributionUrl(dist) : null;
        if (!dist || !targetUrl) {
            items.push(item);
            continue;
        }

        if (firstSuccessProfile) {
            items.push({
                ...item,
                ...firstSuccessProfile
            });
            continue;
        }

        try {
            await importSpatialFromDistribution(
                targetUrl,
                dist.format,
                dist.title
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
            const sampleRows = await runPostgisQuery(
                `SELECT properties
                 FROM features
                 WHERE properties IS NOT NULL
                 LIMIT 8`
            );
            const propertyKeys = (keyRows || [])
                .map((row) => String(row.key || "").trim())
                .filter((key) => !!key);
            const valueSamples = await sampleValueProfilesForKeys(propertyKeys);
            const cntRows = await runPostgisQuery(
                `SELECT COUNT(*)::int AS c FROM features`
            );
            const sampledFeatureCount = cntRows?.[0]?.c ?? 0;
            firstSuccessProfile = {
                geometryTypes: (geomTypesRows || []).map((row) => ({
                    type: String(row.geom_type || ""),
                    count: Number(row.cnt || 0)
                })),
                propertyKeys,
                sampleRows: (sampleRows || [])
                    .map((row) => row?.properties)
                    .filter((row) => !!row && typeof row === "object"),
                valueSamples,
                sampledFeatureCount
            };
            items.push({ ...item, ...firstSuccessProfile });
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
