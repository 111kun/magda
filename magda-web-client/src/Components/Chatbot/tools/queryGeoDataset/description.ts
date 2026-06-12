/**
 * Prompt description builders for GeoSQL tool:
 * - Compose per-distribution YAML metadata blocks
 * - Assemble the final tool description with constraints/examples
 */
import { ParsedDataset, ParsedDistribution } from "helpers/record";
import toYaml from "libs/toYaml";
import { ChainInput, SpatialProfileItem } from "../../commons";
import { webLlmChatCompletion, webLlmResetChat } from "../../webLlmSerial";
import {
    importSpatialFromDistribution,
    runPostgisQuery
} from "../../../../libs/pglitePostgis";
import { getDistributionUrl } from "./distribution";
import {
    PropertySchemaBinding,
    PropertyFieldEntry,
    formatPropertySchemaForDescription,
    getGeoDistributionSampleHint,
    sampleGeoPropertySchema
} from "./schema";

type BuildGeoFileSampleOptions = {
    /** Skip `importSpatialFromDistribution` inside sample hints (spatial already loaded). */
    skipSpatialImportForSample?: boolean;
};

type GeoFileProfile = {
    id: number;
    title: string;
    format: string;
    geom: string;
    feature_count?: number;
    properties_schema: PropertySchemaBinding;
    sample?: string;
};

function truncateText(input: string, maxLen: number): string {
    const txt = (input || "").trim();
    if (!txt) {
        return "";
    }
    return txt.length > maxLen ? `${txt.slice(0, maxLen)}...` : txt;
}

function buildDatasetMetadataBrief(
    dataset: ParsedDataset | undefined,
    distItems: { idx: number; dist: ParsedDistribution }[]
): string {
    const lines: string[] = [];
    if (dataset) {
        lines.push(`dataset_title: ${dataset.title || "n/a"}`);
        lines.push(
            `dataset_description: ${
                truncateText(dataset.description || "", 260) || "n/a"
            }`
        );
        lines.push(
            `dataset_themes: ${
                dataset.themes?.length ? dataset.themes.join(", ") : "n/a"
            }`
        );
        lines.push(
            `dataset_tags: ${
                dataset.tags?.length ? dataset.tags.join(", ") : "n/a"
            }`
        );
        lines.push(`dataset_publisher: ${dataset.publisher?.name || "n/a"}`);
    }
    const distMeta = distItems.slice(0, 3).map((item) => ({
        id: item.idx,
        title: item.dist.title,
        format: item.dist.format,
        description: truncateText(item.dist.description || "", 180) || "n/a"
    }));
    lines.push(`distribution_metadata: ${toYaml(distMeta).trim()}`);
    return lines.join("\n");
}

async function buildGeoFileProfiles(
    distItems: { idx: number; dist: ParsedDistribution }[],
    sampleOptions?: BuildGeoFileSampleOptions
): Promise<GeoFileProfile[]> {
    const profiles: GeoFileProfile[] = [];
    const samplePreviewLimit = 2;
    for (let i = 0; i < distItems.length; i++) {
        const id = distItems[i].idx;
        const dist = distItems[i].dist;
        const sampleHint =
            i < samplePreviewLimit
                ? await getGeoDistributionSampleHint(dist, {
                      skipSpatialImport:
                          sampleOptions?.skipSpatialImportForSample
                  })
                : null;
        let propSchema: PropertySchemaBinding = {
            status: "sampling_failed",
            message: "Not sampled."
        };
        let geomLabel = "unknown";
        let featureCount = 0;
        if (i < samplePreviewLimit) {
            try {
                await importSpatialFromDistribution(
                    getDistributionUrl(dist) || "",
                    dist.format,
                    dist.title
                );
                const geomRows = await runPostgisQuery(
                    `SELECT GeometryType(geom) AS geom_type
                     FROM features WHERE geom IS NOT NULL LIMIT 50`
                );
                const families = new Set<string>();
                for (const row of geomRows || []) {
                    families.add(
                        normalizeGeomFamily(String(row?.geom_type || ""))
                    );
                }
                geomLabel = [...families].sort().join("/") || "unknown";
                featureCount = geomRows?.length || 0;
                propSchema = formatPropertySchemaForDescription(
                    await sampleGeoPropertySchema()
                );
            } catch {
                // leave defaults
            }
        }
        profiles.push({
            id,
            title: dist.title,
            format: dist.format,
            geom: geomLabel,
            feature_count: featureCount || undefined,
            properties_schema: propSchema,
            ...(sampleHint ? { sample: sampleHint.slice(0, 200) } : {})
        });
    }
    return profiles;
}

const MAX_EXAMPLES = 5;

async function buildGeoFileProfilesFromSpatialProfile(
    distItems: { idx: number; dist: ParsedDistribution }[],
    spatialProfileItems: SpatialProfileItem[],
    sampleOptions?: BuildGeoFileSampleOptions
): Promise<GeoFileProfile[]> {
    const profileByIdx = new Map<number, SpatialProfileItem>();
    spatialProfileItems.forEach((item) =>
        profileByIdx.set(item.distributionIndex, item)
    );
    const profiles: GeoFileProfile[] = [];
    for (let i = 0; i < distItems.length; i++) {
        const { idx, dist } = distItems[i];
        const profile = profileByIdx.get(idx);
        const geomFamilies = (profile?.geometryTypes || [])
            .map((item) => normalizeGeomFamily(item.type))
            .filter((value, index, array) => array.indexOf(value) === index);
        const keys = profile?.propertyKeys || [];
        const valueSamples = profile?.valueSamples || {};
        const propSchema: PropertySchemaBinding = keys.length
            ? {
                  status: "ok",
                  keys: Object.fromEntries(
                      keys.map((key) => {
                          const entry: PropertyFieldEntry = { type: "mixed" };
                          const vs = valueSamples[key];
                          if (vs) {
                              entry.examples = vs.values.slice(0, MAX_EXAMPLES);
                              entry.distinct = vs.approxDistinct;
                          }
                          return [key, entry];
                      })
                  )
              }
            : {
                  status: "empty",
                  message: "No profiled keys."
              };
        const featureCount = (profile?.geometryTypes || []).reduce(
            (acc, item) => acc + (item.count || 0),
            0
        );
        const sampleHint =
            i < 2
                ? await getGeoDistributionSampleHint(dist, {
                      skipSpatialImport:
                          sampleOptions?.skipSpatialImportForSample
                  })
                : null;
        profiles.push({
            id: idx,
            title: dist.title,
            format: dist.format,
            geom: geomFamilies.join("/") || "unknown",
            feature_count: featureCount || undefined,
            properties_schema: propSchema,
            ...(sampleHint ? { sample: sampleHint.slice(0, 200) } : {})
        });
    }
    return profiles;
}

function buildGeoDatasetIntroContextFromProfiles(
    profiles: GeoFileProfile[],
    metadataBrief?: string
): string | null {
    if (!profiles.length) {
        return null;
    }
    const previewProfiles = profiles.slice(0, 2);
    const lines = previewProfiles.map((profile) => {
        const propSchema = profile.properties_schema;
        const fields =
            propSchema.status === "ok"
                ? Object.keys(propSchema.keys).slice(0, 12).join(", ")
                : "n/a";
        return `- [${profile.id}] ${profile.title}: geom=${profile.geom}; keys=${fields}`;
    });
    return [metadataBrief, "Spatial file summary:", lines.join("\n")]
        .filter((part) => !!part)
        .join("\n");
}

export async function buildGeoFileDescriptions(
    distItems: { idx: number; dist: ParsedDistribution }[]
): Promise<string[]> {
    const profiles = await buildGeoFileProfiles(distItems);
    return profiles.map((profile) => toYaml(profile));
}

export async function buildGeoFileDescriptionsAndIntro(
    distItems: { idx: number; dist: ParsedDistribution }[],
    dataset?: ParsedDataset,
    spatialProfileItems?: SpatialProfileItem[],
    buildOptions?: BuildGeoFileSampleOptions
): Promise<{
    fileDescItems: string[];
    introContext: string | null;
    metadataBrief: string;
}> {
    const sampleOpts = buildOptions?.skipSpatialImportForSample
        ? { skipSpatialImportForSample: true as const }
        : undefined;
    const profiles =
        spatialProfileItems?.length && spatialProfileItems.length > 0
            ? await buildGeoFileProfilesFromSpatialProfile(
                  distItems,
                  spatialProfileItems,
                  sampleOpts
              )
            : await buildGeoFileProfiles(distItems, sampleOpts);
    const metadataBrief = buildDatasetMetadataBrief(dataset, distItems);
    return {
        fileDescItems: profiles.map((profile) => toYaml(profile)),
        introContext: buildGeoDatasetIntroContextFromProfiles(
            profiles,
            metadataBrief
        ),
        metadataBrief
    };
}

function normalizeGeomFamily(
    geomType: string
): "point" | "line" | "polygon" | "other" {
    const txt = (geomType || "").toUpperCase();
    if (txt.includes("POINT")) return "point";
    if (txt.includes("LINE")) return "line";
    if (txt.includes("POLYGON")) return "polygon";
    return "other";
}

export async function buildGeoDatasetIntroContext(
    distItems: { idx: number; dist: ParsedDistribution }[]
): Promise<string | null> {
    const profiles = await buildGeoFileProfiles(distItems);
    return buildGeoDatasetIntroContextFromProfiles(profiles);
}

/** LLM dataset blurb for chat welcome (not tied to a user question). */
export async function generateGeoDatasetIntro(
    input: ChainInput,
    introContext: string | null
): Promise<string | null> {
    if (!introContext) {
        return null;
    }
    try {
        const engine = await input.model.getEngine();
        await webLlmResetChat(engine);
        const reply = await webLlmChatCompletion(engine, {
            messages: [
                {
                    role: "system",
                    content:
                        "You are Magda, a helpful data assistant. Write a short, natural introduction for the current spatial dataset. " +
                        "Use plain prose (no YAML labels, no markdown fences, no mention of internal schema binding). " +
                        "Summarise what the dataset appears to contain and suggest the kinds of geo questions the user can ask."
                },
                {
                    role: "user",
                    content:
                        "The user just opened the dataset chat panel and has not asked a question yet.\n\n" +
                        `Spatial dataset context:\n${introContext}`
                }
            ]
        });
        const text = reply?.choices?.[0]?.message?.content?.trim();
        return text || null;
    } catch {
        return null;
    }
}

export function buildGeoSqlToolDescription(
    fileDescItems: string[],
    metadataBrief?: string
): string {
    return (
        "Execute PostGIS SQL against spatial data loaded into a local PGlite database. " +
        "First pick a spatial file by distributionIndex, then supply a single GeoSQL statement.\n" +
        "Strict output contract for the sqlQuery argument:\n" +
        "- The sqlQuery string MUST contain executable SQL only and MUST start directly with SELECT or WITH.\n" +
        "- Do NOT include apologies, natural-language explanations, markdown fences, JSON wrappers, labels, comments, or text before/after the SQL.\n" +
        "- Invalid example: `Apologies... ```sql SELECT ...``` `. Valid example: `SELECT ... FROM features LIMIT 100`.\n" +
        (metadataBrief
            ? "Dataset metadata context (use this to understand entity meaning before writing SQL):\n" +
              metadataBrief +
              "\n"
            : "") +
        "To generate a valid GeoSQL, follow these steps:\n" +
        "1) Identify the geometry type (Point/Line/Polygon).\n" +
        "2) Check if a distance calculation is needed. If yes, MUST use ::geography for meter units.\n" +
        "3) Inspect the properties JSONB keys provided in the sample. Use ->> for text filters and (properties->>'key')::float for numeric filters.\n" +
        "4) Ensure SRID 4326 is used for any new point creation.\n" +
        "Schema Metadata (deterministic binding):\n" +
        "- After import, data lives in virtual table `features(id serial, properties jsonb, geom geometry)`.\n" +
        "- `features` is the ONLY SQL table name available in the browser PostGIS database; never use dataset titles, distribution titles, filenames, or derived names as table names.\n" +
        "- `properties` keys are case-sensitive in JSONB; do not change key casing.\n" +
        "- MUST use only keys from `properties_schema.keys` map; do not invent or normalize key names.\n" +
        "Execution Rules:\n" +
        "For place-distance queries, provide `placeName` and use token `__REF_POINT__` in SQL. " +
        "The tool resolves place coordinates by searching current dataset first; if not found, it falls back to OpenStreetMap Nominatim.\n" +
        "For nearest-to-dataset-feature queries where the reference point is identified by an existing column/key and value (e.g. id=12, street='King Street', species='Oak'), do NOT use `placeName` or `__REF_POINT__`; use a CTE/self-join against `features` to select the reference row.\n" +
        "Only use `placeName`/`__REF_POINT__` when the reference point is not expressed as an existing dataset column/key filter.\n" +
        "GeoSQL guidelines:\n" +
        "- When feasible, include `ST_AsText(geom) AS geom_wkt` for map rendering compatibility.\n" +
        "- Unless user explicitly requests raw geometry/GeoJSON, do not return raw `geom`; prefer WKT output.\n" +
        "- If you use `GeometryType(...)` filters, compare against UPPERCASE literals only (e.g. 'POINT', 'LINESTRING', 'POLYGON', 'MULTIPOLYGON').\n" +
        "- For JSONB properties access, key name MUST match YAML exactly (case-sensitive), e.g. use `properties->>'Name'` if YAML key is `Name`.\n" +
        "- If SQL uses GROUP BY, every non-grouped selected expression MUST be aggregated; never select raw `geom` or plain `ST_Area(geom)` in grouped queries.\n" +
        "- Area calculations MUST be in square meters using geography (e.g. `ST_Area(geom::geography)`), and length/distance MUST be in meters using geography.\n" +
        "- For one-to-many name relationships (same Name appears on multiple features), explicitly choose logic: aggregate (e.g. `SUM(ST_Area(geom::geography))`) or keep feature-level rows. Do not mix both ambiguously.\n" +
        "- Match natural-language variants and common misspellings using metadata context (e.g. `kindergarden` ~= `kindergarten`) before deciding filters.\n" +
        "- Prefer typed access for numeric/boolean/object/array keys: `properties->'FieldName'`; cast as needed (e.g. (properties->>'count')::numeric).\n" +
        "- Use `properties->>'FieldName'` for plain text comparisons/output.\n" +
        "- For distance/length in meters, cast to geography (e.g. ST_Length(geom::geography), ST_DWithin(...::geography,...::geography, meters)).\n" +
        "- Prefer robust line filters: GeometryType(geom) IN ('LINESTRING','MULTILINESTRING') OR ST_Dimension(geom)=1. Avoid only checking one exact type.\n" +
        "- For polygon operations, handle MULTIPOLYGON as well.\n" +
        "Examples:\n" +
        "- Attributes: SELECT properties->>'name' AS n, ST_AsText(geom) FROM features LIMIT 100\n" +
        "- Distance in meters (WGS84): SELECT * FROM features WHERE ST_DWithin(geom::geography, ST_SetSRID(ST_MakePoint(151.0, -33.86),4326)::geography, 5000) LIMIT 100\n" +
        "- Distance using place token: SELECT properties->>'Figure_Description' AS name FROM features WHERE ST_DWithin(geom::geography, __REF_POINT__::geography, 5000) LIMIT 100\n" +
        "- Line length (meters): SELECT id, ST_Length(geom::geography) AS length_m FROM features WHERE GeometryType(geom) IN ('LINESTRING','MULTILINESTRING') LIMIT 100\n" +
        "Common spatial query patterns (few-shot templates):\n" +
        "- Buffer/proximity query: SELECT id, properties->>'name' AS name FROM features WHERE ST_DWithin(geom::geography, __REF_POINT__::geography, 1000) LIMIT 100\n" +
        "- Attribute aggregation: SELECT properties->>'category' AS category, COUNT(*) AS total FROM features GROUP BY 1 ORDER BY total DESC LIMIT 100\n" +
        "- Aggregated area by name (sqm): SELECT properties->>'Name' AS area_name, SUM(ST_Area(geom::geography)) AS area_m2 FROM features WHERE UPPER(GeometryType(geom)) IN ('POLYGON','MULTIPOLYGON') GROUP BY properties->>'Name' ORDER BY area_m2 DESC LIMIT 100\n" +
        "- Nearest-neighbor query: SELECT id, properties->>'name' AS name, ST_Distance(geom::geography, __REF_POINT__::geography) AS distance_m FROM features ORDER BY geom <-> __REF_POINT__ LIMIT 5\n" +
        "- Complex numeric filter: SELECT id, properties->>'name' AS name FROM features WHERE (properties->>'population')::int > 1000 LIMIT 100\n" +
        "Available spatial files — set distributionIndex to the `id` value (same indexing as SQL Console source()):\n" +
        fileDescItems.join("\n")
    );
}
