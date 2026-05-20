import type { Location } from "history";
import type { History } from "history";
import type { ParsedDataset, ParsedDistribution } from "helpers/record";
import { emptyPublisher } from "helpers/record";
import AgentChain from "../AgentChain";
import type { InitProgressCallback } from "@mlc-ai/web-llm";
import { getPGlitePostgis } from "../../../libs/pglitePostgis";
import {
    buildGeoEvalFakeDistributionUrl,
    clearEvalDistributionUrlMappings,
    registerEvalDistributionMapping
} from "./evalDistributionUrlMap";

export type GeoEvalDatasetMeta = {
    id: string;
    label: string;
    ddl_file: string;
    jsonl_file: string;
    zip_file: string | null;
    /** Magda fixtures: static GeoJSON under `/eval-data/magda/geojson/`. */
    geojson_file?: string | null;
    format?: string;
    /** When true, gold SQL targets `features` directly (no compat VIEW needed). */
    skip_compat_view?: boolean;
    /** Subpath under `/eval-data/` for JSONL (default `magda/cases`). */
    cases_path?: string;
    table: string;
    columns: string[];
    cases_total: number;
    cases_single_table: number;
    cases_multi_table: number;
};

function minimalDistribution(
    partial: Partial<ParsedDistribution> &
        Pick<ParsedDistribution, "title" | "format">
): ParsedDistribution {
    return {
        ...partial,
        description: partial.description ?? "",
        license: partial.license ?? "",
        linkActive: true,
        linkStatusAvailable: true,
        isTimeSeries: false,
        compatiblePreviews: partial.compatiblePreviews ?? {},
        visualizationInfo: partial.visualizationInfo ?? {},
        sourceDetails: partial.sourceDetails ?? {},
        ckanResource: partial.ckanResource ?? {},
        rawData: partial.rawData ?? ({} as ParsedDistribution["rawData"])
    };
}

/**
 * ParsedDataset shaped like registry parse output — enough for profile + router + GeoSQL tool.
 */
export function buildParsedDatasetForGeoEval(
    meta: GeoEvalDatasetMeta
): ParsedDataset {
    if (!meta.geojson_file) {
        throw new Error(`Dataset ${meta.id} needs geojson_file`);
    }
    const fakeUrl = buildGeoEvalFakeDistributionUrl(meta.id, meta.geojson_file);
    const dist: ParsedDistribution = minimalDistribution({
        identifier: `eval-dist-${meta.id}`,
        title: meta.table || meta.label,
        description: `GeoSQL eval fixture (${meta.id})`,
        format: meta.format || "GEOJSON",
        downloadURL: fakeUrl
    });
    return {
        identifier: meta.id,
        title: meta.label || meta.id,
        description: `GeoSQL benchmark fixture ${meta.id}`,
        landingPage: "",
        tags: ["magda-eval"],
        distributions: [dist],
        themes: [],
        publisher: emptyPublisher,
        linkedDataRating: 0,
        contactPoint: "",
        access: {} as ParsedDataset["access"],
        rawData: {} as ParsedDataset["rawData"]
    };
}

/** Register fake registry URL → local static asset under `/eval-data/...`. */
export function registerGeoEvalDatasetMappings(meta: GeoEvalDatasetMeta): void {
    if (!meta.geojson_file) {
        return;
    }
    const fakeUrl = buildGeoEvalFakeDistributionUrl(meta.id, meta.geojson_file);
    const staticPath = `/eval-data/magda/geojson/${meta.geojson_file}`;
    registerEvalDistributionMapping(fakeUrl, staticPath);
}

export function evalCasesUrlForDataset(meta: GeoEvalDatasetMeta): string {
    const base = meta.cases_path || "magda/cases";
    return `/eval-data/${base}/${meta.jsonl_file}`;
}

export function evalSchemaUrlForDataset(meta: GeoEvalDatasetMeta): string {
    if ((meta.cases_path || "magda/cases") === "magda/cases") {
        return `/eval-data/magda/schema/${meta.ddl_file}`;
    }
    return `/eval-data/ddl/${meta.ddl_file}`;
}

export function resetGeoEvalDistributionMappings(): void {
    clearEvalDistributionUrlMappings();
}

/** Apply gold-SQL compat VIEW so benchmark SQL against legacy table names works. */
export async function applyGoldSqlCompatView(tableName: string): Promise<void> {
    const resp = await fetch(`/eval-data/features-views/${tableName}.sql`);
    if (!resp.ok) {
        throw new Error(
            `Missing compat view for ${tableName} (${resp.status}). Keep \`skip_compat_view: true\` in Magda eval metadata, or prepare a compat SQL under public/eval-data/features-views/.`
        );
    }
    const sql = await resp.text();
    const pg = await getPGlitePostgis();
    await pg.exec(sql);
}

function createStubHistory(pathname: string): History {
    let loc = {
        pathname,
        search: "",
        hash: "",
        state: undefined,
        key: "default"
    } as Location;
    return {
        length: 1,
        action: "POP",
        location: loc,
        push: (locOrPath: string | Location) => {
            loc =
                typeof locOrPath === "string"
                    ? ({ ...loc, pathname: locOrPath } as Location)
                    : locOrPath;
        },
        replace: (locOrPath: string | Location) => {
            loc =
                typeof locOrPath === "string"
                    ? ({ ...loc, pathname: locOrPath } as Location)
                    : locOrPath;
        },
        go: () => undefined,
        goBack: () => undefined,
        goForward: () => undefined,
        block: () => () => undefined,
        listen: () => () => undefined,
        createHref: (l: Location) => l.pathname,
        createLocation: (path: string) =>
            ({
                pathname: path,
                search: "",
                hash: "",
                state: undefined,
                key: "default"
            } as Location)
    } as History;
}

/**
 * Isolated AgentChain for GeoSQL eval — does not overwrite `window.chatBotAgentChain`.
 */
export function createGeoEvalAgentChain(
    loadProgressCallback?: InitProgressCallback
): AgentChain {
    const history = createStubHistory("/dataset/geosql-eval-feed");
    return new AgentChain(
        "geosql-eval",
        history.location,
        history,
        undefined,
        undefined,
        loadProgressCallback,
        {
            attachToWindowDebug: false,
            webLlmCreateOptions: {
                /**
                 * Default WebLLM keepAlive is 10s. Importing eval shapefiles / heavy
                 * PostGIS work can exceed that without any `engine.chat` traffic; the
                 * extension then disconnects and the next prompt full-reloads weights.
                 */
                keepAliveMs: 2 * 60 * 60 * 1000
            }
        }
    );
}
