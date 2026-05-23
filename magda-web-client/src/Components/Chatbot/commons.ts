import type AsyncQueue from "@ai-zen/async-queue";
import type { ChatEventMessage } from "./Messaging";
import type { History, Location } from "history";
import type { MagdaLlmModel } from "./magdaLlmModel";
import { ParsedDataset, ParsedDistribution } from "helpers/record";
export type LocationType = "DATASET_PAGE" | "DISTRIBUTION_PAGE" | "OTHERS";

export type GeometryTypeCount = {
    type: string;
    count: number;
};

export type ValueSampleProfile = {
    mode: "full" | "partial";
    values: string[];
    approxDistinct: number;
};

export interface TabularProfileItem {
    distributionIndex: number;
    title: string;
    format: string;
    columns?: string[];
    sampleRows?: Record<string, any>[];
    rowCount?: number;
    error?: string;
}

export interface SpatialProfileItem {
    distributionIndex: number;
    title: string;
    format: string;
    status?: "ready" | "error" | "failed" | "not_loaded";
    geometryTypes?: GeometryTypeCount[];
    propertyKeys?: string[];
    sampledFeatureCount?: number;
    sampleRows?: Record<string, any>[];
    /** Per-property value samples for enum-like grounding in prompts. */
    valueSamples?: Record<string, ValueSampleProfile>;
    bbox?: [number, number, number, number];
    bboxWkt?: string;
    error?: string;
}

type ProfileStatus = "ready" | "error";

export interface DatasetProfile {
    versionKey: string;
    locationType: LocationType;
    datasetIdentifier?: string;
    datasetTitle?: string;
    datasetDescription?: string;
    datasetTags?: string[];
    datasetThemes?: string[];
    distributionCount: number;
    tabular: {
        status: "not_loaded" | ProfileStatus;
        items: TabularProfileItem[];
        updatedAt?: number;
    };
    spatial: {
        status: "not_loaded" | ProfileStatus;
        items: SpatialProfileItem[];
        updatedAt?: number;
    };
}

/**
 * Store information might be useful for future message generation.
 * e.g. User might ask "Draw the results as a chart".
 * If we store previous query result, we will be able to regenerate chart from the previous result without redoing the query.
 * Why not store full conversation history? We have very limited context window (2K) when run LLM in browser.
 * Other data we might consider store in future: search result
 * @interface KeyContextData
 */
export interface KeyContextData {
    // latest query result
    queryResult: any;
    datasetProfile?: DatasetProfile;
    datasetProfileUpdatedAt?: number;
    datasetProfileVersionKey?: string;
}

/** Optional dataset-scope hint for routing (see chatRouteRouter). */
export type SpatialCoverageHint = {
    /** Normalised tokens from title, description, tags, themes. */
    scopeTokens: string[];
    /** Short paragraph injected into the spatial classifier prompt. */
    scopeHintForLlm: string;
};

export interface ChainInput {
    appName: string;
    question: string;
    queue: AsyncQueue<ChatEventMessage>;
    history: History;
    location: Location;
    model: MagdaLlmModel;
    dataset: ParsedDataset | undefined;
    distribution: ParsedDistribution | undefined;
    keyContextData: KeyContextData;
    /** Set by AgentChain before spatial routing when a dataset profile is available. */
    spatialCoverage?: SpatialCoverageHint;
    /** GeoSQL eval harness: queryGeoDataset fills executed SQL after a successful run. */
    geoEvalCaptureExecutedSql?: boolean;
    /** Eval: skip deterministic/spatial SQL renderers; every case uses Planner LLM. */
    geoEvalDisableDeterministicRenderer?: boolean;
    /** When true, createChain only runs profile enrichment and skips LLM routing/tools. */
    warmupOnly?: boolean;
    evalCapturedExecutedSqlFirst?: string;
    evalCapturedExecutedSql?: string;
    evalCapturedSanitizerFixes?: string[];
}

export function getLocationType(location: Location): LocationType {
    const { pathname } = location;
    if (pathname.indexOf("/dataset/") !== -1) {
        return "DATASET_PAGE";
    } else if (pathname.indexOf("/distribution/") !== -1) {
        return "DISTRIBUTION_PAGE";
    } else {
        return "OTHERS";
    }
}
