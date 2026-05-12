import { ChainInput } from "../commons";
import {
    classifySpatialIntent,
    GeoReference,
    SpatialIntentResult
} from "../chatRouteRouter";
import { sanitizeGeoSql } from "../tools/queryGeoDataset/sql";
import { ParsedDistribution } from "helpers/record";

export type GeoSqlEvalPlan =
    | {
          type: "query";
          distributionIndex: number;
          sqlQuery: string;
          placeName?: string;
          countrycodes?: string;
      }
    | {
          type: "not_applicable";
          reason: string;
      };

function formatGeoReferenceForPlanner(reference: GeoReference | undefined) {
    if (!reference || reference.type === "none") {
        return "none";
    }
    if (reference.type === "internal") {
        return `internal key=${reference.key}, value=${reference.value}`;
    }
    return `external place=${reference.place}`;
}

function getPlannerPropertyKeys(input: ChainInput): string[] {
    const keys = new Set<string>();
    input.keyContextData?.datasetProfile?.spatial?.items?.forEach((item) => {
        item.propertyKeys?.forEach((key) => {
            if (key?.trim()) {
                keys.add(key.trim());
            }
        });
    });
    return [...keys];
}

function getParserReference(input: ChainInput): GeoReference | undefined {
    return (input as ChainInput & { __geoIntent?: SpatialIntentResult })
        .__geoIntent?.reference;
}

function normalizeRefPointToken(sql: string): string {
    return sql
        .replace(/\b_{0,2}REF_POINT_{2,}(?:geom|geometry)\b/gi, "__REF_POINT__")
        .replace(/\b_{0,2}REF_POINT_(?:geom|geometry)\b/gi, "__REF_POINT__")
        .replace(
            /(^|[^A-Za-z0-9_])_{0,2}REF_POINT_{0,2}(?=$|[^A-Za-z0-9_])/gi,
            "$1__REF_POINT__"
        )
        .replace(
            /ST_SetSRID\s*\(\s*ST_MakePoint\s*\(\s*__REF_POINT__\s*\.\s*(?:lon|lng|x)\s*,\s*__REF_POINT__\s*\.\s*(?:lat|y)\s*\)\s*,\s*4326\s*\)/gi,
            "__REF_POINT__"
        )
        .replace(
            /ST_MakePoint\s*\(\s*__REF_POINT__\s*\.\s*(?:lon|lng|x)\s*,\s*__REF_POINT__\s*\.\s*(?:lat|y)\s*\)/gi,
            "__REF_POINT__"
        )
        .replace(
            /__REF_POINT__\s*\.\s*(?:lon|lng|lat|x|y|geom|geometry)\b/gi,
            "__REF_POINT__"
        );
}

export async function classifySpatialIntentForEval(input: ChainInput) {
    return classifySpatialIntent(input);
}

export async function planGeoSqlForEval(
    input: ChainInput,
    dists: { idx: number; dist: ParsedDistribution }[],
    metadataBrief = "N/A",
    fileDescItems: string[] = []
): Promise<GeoSqlEvalPlan> {
    const engine = await input.model.getEngine();
    const distList = dists
        .map((item) => `${item.idx}: ${item.dist.title} (${item.dist.format})`)
        .join("\n");
    const parserReference = getParserReference(input);
    const plannerUserPrompt =
        `User question:\n${input.question}\n\n` +
        `Parser reference context:\n${formatGeoReferenceForPlanner(
            parserReference
        )}\n\n` +
        `Existing property keys:\n${
            getPlannerPropertyKeys(input).join(", ") || "N/A"
        }\n\n` +
        `Available spatial distributions:\n${distList}\n\n` +
        `Metadata brief:\n${metadataBrief}\n\n` +
        `Schema/sample YAML for GeoSQL generation:\n${
            fileDescItems.length ? fileDescItems.join("\n---\n") : "N/A"
        }`;

    const plannerSystemInstruction =
        "You are a GeoSQL planner for Magda dataset chat. " +
        "Output JSON only, no markdown. " +
        "If query is spatial, output " +
        '{"type":"query","distributionIndex":<int>,"sqlQuery":"<PostGIS SQL>","placeName":"<optional>","countrycodes":"<optional>"}. ' +
        "SQL must be one executable SELECT/WITH query against `features`. " +
        "If non-spatial, output " +
        '{"type":"not_applicable","reason":"<short reason>"}';

    const reply = await engine.chat.completions.create({
        stream: false,
        messages: [
            {
                role: "system",
                content: plannerSystemInstruction
            },
            {
                role: "user",
                content: plannerUserPrompt
            }
        ]
    });
    const raw = reply?.choices?.[0]?.message?.content?.trim();
    if (!raw) {
        return {
            type: "not_applicable",
            reason: "Planner did not return any result."
        };
    }
    try {
        const parsed = JSON.parse(raw) as Partial<GeoSqlEvalPlan>;
        if (
            parsed?.type === "query" &&
            typeof (parsed as any).distributionIndex === "number" &&
            typeof (parsed as any).sqlQuery === "string" &&
            (parsed as any).sqlQuery.trim()
        ) {
            return {
                type: "query",
                distributionIndex: (parsed as any).distributionIndex,
                sqlQuery: (parsed as any).sqlQuery,
                placeName:
                    typeof (parsed as any).placeName === "string"
                        ? (parsed as any).placeName
                        : undefined,
                countrycodes:
                    typeof (parsed as any).countrycodes === "string"
                        ? (parsed as any).countrycodes
                        : undefined
            };
        }
        if (
            parsed?.type === "not_applicable" &&
            typeof (parsed as any).reason === "string"
        ) {
            return {
                type: "not_applicable",
                reason: (parsed as any).reason
            };
        }
    } catch {
        // fall through
    }
    return {
        type: "not_applicable",
        reason: "Planner returned invalid JSON."
    };
}

export function sanitizeGeoSqlForEval(sqlQuery: string, propKeys?: string[]) {
    const normalizedSql = normalizeRefPointToken(sqlQuery || "");
    return sanitizeGeoSql(normalizedSql, propKeys || []);
}
