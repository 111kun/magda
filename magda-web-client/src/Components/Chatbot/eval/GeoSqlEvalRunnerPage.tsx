import React, {
    useCallback,
    useEffect,
    useMemo,
    useRef,
    useState
} from "react";
import type { InitProgressReport } from "@mlc-ai/web-llm";
import ChatWebLLM from "../ChatWebLLM";
import {
    getPGlitePostgisEval,
    importSpatialFromDistribution,
    runPostgisQueryEval
} from "../../../libs/pglitePostgis";
import {
    planGeoSqlQuery,
    queryGeoSpatialWithSQLQuery
} from "../tools/queryGeoDataset";
import {
    classifySpatialIntentForEval,
    GeoSqlEvalPlan
} from "./GeoSqlEvalService";

type EvalCase = {
    id: string;
    question: string;
    gold_sql?: string;
    expected_route?: string;
    op_family?: string;
    tags?: string[];
    ddl_files?: string[];
};

type DatasetMeta = {
    id: string;
    label: string;
    ddl_file: string;
    jsonl_file: string;
    zip_file: string | null;
    table: string;
    columns: string[];
    cases_total: number;
    cases_single_table: number;
    cases_multi_table: number;
};

type CaseResult = {
    case_id: string;
    question: string;
    expected_route?: string;
    op_family?: string;
    single_table_only: boolean;
    ddl_files?: string[];
    layerA: {
        syntax_valid_first: boolean;
        execution_pass_first: boolean;
        execution_pass_final: boolean;
        error_category_first: string | null;
        error_category_final: string | null;
    };
    layerB: {
        result_correct_first: boolean;
        result_correct_final: boolean;
    };
    traces: {
        model_mode: "real-webllm";
        route: string;
        route_source: string;
        planner_type: GeoSqlEvalPlan["type"];
        generated_sql_first: string | null;
        generated_sql_final: string | null;
        gold_sql: string | null;
        gold_rows_hash: string | null;
        first_rows_hash: string | null;
        final_rows_hash: string | null;
        sanitizer_fixes: string[];
        notes: string;
    };
};

type Report = {
    run: {
        tag: string;
        dataset_id: string;
        dataset_table: string;
        started_at: string;
        finished_at: string;
        adapter: string;
        cases_count: number;
        model: string;
    };
    summary: {
        sample_count: number;
        layerA: {
            syntax_accuracy: number;
            epr_first: number;
            epr_final: number;
            error_buckets: Record<string, number>;
        };
        by_route: Record<string, number>;
        by_op_family: Record<string, number>;
        by_single_vs_multi: { single_table: number; multi_table: number };
    };
    results: CaseResult[];
};

type AllDatasetsReport = {
    run: {
        tag: string;
        started_at: string;
        finished_at: string;
        adapter: string;
        datasets_count: number;
        model: string;
        mode: "single-table-only";
    };
    summary: Report["summary"];
    dataset_reports: Array<{
        dataset_id: string;
        dataset_table: string;
        cases_count: number;
        summary: Report["summary"];
    }>;
    results: CaseResult[];
};

const DEFAULT_MODEL = "Hermes-3-Llama-3.1-8B-q4f16_1-MLC";
const META_URL = "/eval-data/datasets-meta.json";
const MAX_IMPORT_FEATURES = 1000;

type PgExecResult = {
    ok: boolean;
    rows: Record<string, any>[];
    hash: string | null;
    error?: string;
};

function hashRows(rows: Record<string, any>[]): string {
    const normalized = rows.map((r) => {
        const obj: Record<string, any> = {};
        Object.keys(r)
            .sort()
            .forEach((k) => {
                const v = r[k];
                obj[k] = typeof v === "number" ? Number(v.toFixed(8)) : v;
            });
        return JSON.stringify(obj);
    });
    normalized.sort();
    return JSON.stringify(normalized);
}

function classifyExecutionError(message?: string): string {
    const msg = (message || "").toLowerCase();
    if (msg.includes("syntax error")) return "syntax";
    if (msg.includes("does not exist") || msg.includes("column"))
        return "schema";
    if (msg.includes("function")) return "function";
    if (msg.includes("operator does not exist") || msg.includes("type"))
        return "type";
    if (msg.includes("transform") || msg.includes("srid")) return "crs";
    if (msg) return "runtime";
    return "unknown";
}

async function executeSql(sql: string): Promise<PgExecResult> {
    if (!sql?.trim()) {
        return { ok: false, rows: [], hash: null, error: "empty SQL" };
    }
    try {
        const rows = await runPostgisQueryEval(sql);
        return { ok: true, rows, hash: hashRows(rows) };
    } catch (e) {
        return {
            ok: false,
            rows: [],
            hash: null,
            error: (e as Error).message || String(e)
        };
    }
}

/**
 * Match production Magda import path (`importSpatialFromDistribution`) into the
 * isolated eval PGLite DB, then apply the gold_sql compat VIEW on top.
 */
async function bootstrapEvalDatasetWithProductionImport(opts: {
    table: string;
    zipFile: string;
}): Promise<{
    inserted: number;
    truncated: boolean;
    totalFeatures: number;
    sampleYaml: string;
}> {
    const { table, zipFile } = opts;
    const base =
        typeof window !== "undefined" && window.location?.origin
            ? window.location.origin
            : "";
    const zipUrl = `${base}/eval-data/tiger-files/${zipFile}`;
    const importResult = await importSpatialFromDistribution(
        zipUrl,
        "SHAPEFILE",
        table,
        { maxFeatures: MAX_IMPORT_FEATURES, pgliteTarget: "eval" }
    );
    const viewResp = await fetch(`/eval-data/features-views/${table}.sql`);
    if (!viewResp.ok) {
        throw new Error(
            `Missing compat view for ${table} (${viewResp.status}). Run: node geosql-eval/scripts/sync-eval-assets.mjs`
        );
    }
    const viewSql = await viewResp.text();
    const pg = await getPGlitePostgisEval();
    await pg.exec(viewSql);
    const sampleRows = await runPostgisQueryEval(
        `SELECT jsonb_build_object('id', id, 'properties', properties) AS row FROM features ORDER BY id LIMIT 8`
    );
    const sampleYaml = JSON.stringify(
        sampleRows.map((r) => r.row),
        null,
        2
    );
    return {
        inserted: importResult.inserted,
        truncated: importResult.truncated,
        totalFeatures: importResult.totalFeatures,
        sampleYaml
    };
}

function inferOpFamily(sql: string | undefined): string {
    const s = (sql || "").toLowerCase();
    if (/\bst_dwithin\b|\bst_distance\b|\bnearest\b/.test(s)) return "distance";
    if (/\bst_intersects\b|\bst_contains\b|\bst_within\b/.test(s))
        return "topological";
    if (/\bst_buffer\b/.test(s)) return "buffer";
    if (/\bjoin\b/.test(s)) return "join";
    return "other";
}

function ratio(num: number, den: number) {
    return den > 0 ? Number((num / den).toFixed(4)) : 0;
}

function buildSummary(results: CaseResult[]) {
    const total = results.length;
    const errorBuckets: Record<string, number> = {
        syntax: 0,
        schema: 0,
        function: 0,
        type: 0,
        crs: 0,
        runtime: 0,
        unknown: 0
    };
    let syntax = 0;
    let eprFirst = 0;
    let eprFinal = 0;
    let single = 0;
    let multi = 0;
    const byRoute: Record<string, number> = {};
    const byOp: Record<string, number> = {};

    for (const r of results) {
        if (r.layerA.syntax_valid_first) syntax += 1;
        if (r.layerA.execution_pass_first) eprFirst += 1;
        if (r.layerA.execution_pass_final) eprFinal += 1;
        if (r.single_table_only) single += 1;
        else multi += 1;
        const bucket =
            (r.layerA.error_category_first ||
                r.layerA.error_category_final ||
                "unknown") in errorBuckets
                ? r.layerA.error_category_first ||
                  r.layerA.error_category_final ||
                  "unknown"
                : "unknown";
        errorBuckets[bucket] = (errorBuckets[bucket] || 0) + 1;
        const route = r.traces.route || "unknown";
        byRoute[route] = (byRoute[route] || 0) + 1;
        const op = r.op_family || "other";
        byOp[op] = (byOp[op] || 0) + 1;
    }

    return {
        sample_count: total,
        layerA: {
            syntax_accuracy: ratio(syntax, total),
            epr_first: ratio(eprFirst, total),
            epr_final: ratio(eprFinal, total),
            error_buckets: errorBuckets
        },
        by_route: byRoute,
        by_op_family: byOp,
        by_single_vs_multi: { single_table: single, multi_table: multi }
    };
}

function isSingleTableCase(caseItem: EvalCase) {
    return Array.isArray(caseItem.ddl_files) && caseItem.ddl_files.length === 1;
}

function parseJsonl(text: string): EvalCase[] {
    return text
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => !!l)
        .map((line, idx) => {
            try {
                const raw = JSON.parse(line);
                return {
                    id: raw.id || `case-${idx + 1}`,
                    question: raw.question || raw.natural_query || "",
                    gold_sql: raw.gold_sql || raw.sql_query || "",
                    expected_route: raw.expected_route || "unknown",
                    op_family: raw.op_family,
                    tags: Array.isArray(raw.tags) ? raw.tags : [],
                    ddl_files: Array.isArray(raw.ddl_files) ? raw.ddl_files : []
                } as EvalCase;
            } catch (e) {
                throw new Error(
                    `Invalid JSON at line ${idx + 1}: ${(e as Error).message}`
                );
            }
        });
}

function downloadJson(filename: string, data: unknown) {
    const now = new Date();
    const ts =
        [
            now.getFullYear(),
            String(now.getMonth() + 1).padStart(2, "0"),
            String(now.getDate()).padStart(2, "0")
        ].join("") +
        "-" +
        [
            String(now.getHours()).padStart(2, "0"),
            String(now.getMinutes()).padStart(2, "0"),
            String(now.getSeconds()).padStart(2, "0")
        ].join("");

    const withTs = filename.replace(/\.json$/i, `-${ts}.json`);
    const blob = new Blob([JSON.stringify(data, null, 2)], {
        type: "application/json"
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = withTs;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
}

function buildEvalChainInput(
    model: ChatWebLLM,
    question: string,
    propertyKeys: string[],
    distTitle: string
) {
    return {
        appName: "geosql-eval",
        question,
        // queue/history/location are required by ChainInput typing but not
        // touched by GeoSqlEvalService planner/router/sanitizer.
        queue: { push: () => undefined, done: () => undefined } as any,
        history: {} as any,
        location: { pathname: "/eval/geosql" } as any,
        model,
        dataset: undefined,
        distribution: undefined,
        keyContextData: {
            queryResult: undefined,
            datasetProfile: {
                versionKey: "eval",
                locationType: "DATASET_PAGE" as const,
                distributionCount: 1,
                tabular: { status: "not_loaded" as const, items: [] },
                spatial: {
                    status: "ready" as const,
                    items: [
                        {
                            distributionIndex: 0,
                            title: distTitle,
                            format: "geojson",
                            status: "ready" as const,
                            propertyKeys: propertyKeys.length
                                ? propertyKeys
                                : ["name", "fullname", "namelsad", "geom"]
                        }
                    ]
                }
            }
        }
    } as any;
}

const GeoSqlEvalRunnerPage: React.FC = () => {
    const [tag, setTag] = useState("baseline");
    const [modelName, setModelName] = useState(DEFAULT_MODEL);
    const [datasets, setDatasets] = useState<DatasetMeta[]>([]);
    const [selectedDatasetId, setSelectedDatasetId] = useState<string>("");
    const [casesText, setCasesText] = useState("");
    const [ddlText, setDdlText] = useState("");
    const [progress, setProgress] = useState<string>("");
    const [running, setRunning] = useState(false);
    const [report, setReport] = useState<Report | null>(null);
    const [logs, setLogs] = useState<string[]>([]);
    const modelRef = useRef<ChatWebLLM | null>(null);

    const appendLog = useCallback((msg: string) => {
        setLogs((prev) => [
            ...prev,
            `[${new Date().toLocaleTimeString()}] ${msg}`
        ]);
    }, []);

    const selectedDataset = useMemo(
        () => datasets.find((d) => d.id === selectedDatasetId) || null,
        [datasets, selectedDatasetId]
    );

    useEffect(() => {
        fetch(META_URL)
            .then((r) => {
                if (!r.ok) throw new Error(`fetch ${META_URL} -> ${r.status}`);
                return r.json();
            })
            .then((data: DatasetMeta[]) => {
                setDatasets(data);
                appendLog(
                    `Loaded ${data.length} dataset preset(s) from ${META_URL}`
                );
            })
            .catch((e) => {
                appendLog(
                    `Could not load dataset presets (${
                        (e as Error).message
                    }). Run 'node geosql-eval/scripts/sync-eval-assets.mjs' to enable presets, or paste JSONL manually below.`
                );
            });
    }, [appendLog]);

    useEffect(() => {
        if (!selectedDataset) return;
        const casesUrl = `/eval-data/by-ddl/${selectedDataset.jsonl_file}`;
        const ddlUrl = `/eval-data/ddl/${selectedDataset.ddl_file}`;
        Promise.all([
            fetch(casesUrl).then((r) => r.text()),
            fetch(ddlUrl).then((r) => r.text())
        ])
            .then(([cases, ddl]) => {
                setCasesText(cases);
                setDdlText(ddl);
                appendLog(
                    `Loaded preset '${selectedDataset.id}': ${selectedDataset.cases_total} case(s), table=${selectedDataset.table}, ${selectedDataset.columns.length} column(s)`
                );
            })
            .catch((e) => {
                appendLog(
                    `Failed to load preset assets: ${(e as Error).message}`
                );
            });
    }, [selectedDataset, appendLog]);

    const handleFile = useCallback((file: File) => {
        const reader = new FileReader();
        reader.onload = () => {
            setCasesText(String(reader.result || ""));
        };
        reader.readAsText(file);
    }, []);

    const initModel = useCallback(async () => {
        if (modelRef.current) {
            return modelRef.current;
        }
        appendLog(`Initialising WebLLM model: ${modelName}`);
        const model = ChatWebLLM.createDefaultModel({
            model: modelName,
            loadProgressCallback: (report: InitProgressReport) => {
                setProgress(
                    `${report.text} (${(report.progress * 100).toFixed(1)}%)`
                );
            }
        });
        await model.initialize();
        modelRef.current = model;
        appendLog("WebLLM model initialised.");
        setProgress("Model ready.");
        return model;
    }, [appendLog, modelName]);

    const evaluateCasesForDataset = useCallback(
        async (
            model: ChatWebLLM,
            sourceCases: EvalCase[],
            datasetMeta: DatasetMeta | null
        ) => {
            const cases = sourceCases.filter(isSingleTableCase);
            if (!cases.length) {
                appendLog(
                    `[${
                        datasetMeta?.id || "manual"
                    }] no single-table cases, skipped.`
                );
                return null;
            }
            const propKeys = datasetMeta?.columns || [];
            const distTitle = datasetMeta?.table || "eval-dist";
            const datasetId = datasetMeta?.id || "manual";
            const startedAt = new Date().toISOString();
            const results: CaseResult[] = [];
            let sampleYaml = "[]";
            const zipBase =
                typeof window !== "undefined" && window.location?.origin
                    ? window.location.origin
                    : "";
            const evalZipUrl = datasetMeta?.zip_file
                ? `${zipBase}/eval-data/tiger-files/${datasetMeta.zip_file}`
                : "";
            const evalDistItems = [
                {
                    idx: 0,
                    dist: {
                        // IMPORTANT: keep planner/tool grounded on `features` only.
                        // Do not surface TIGER table names here; otherwise the model
                        // may incorrectly query `tl_...` instead of `features`.
                        title: "eval_spatial_0",
                        format: "ESRI SHAPEFILE",
                        downloadURL: evalZipUrl
                    } as any
                }
            ];

            if (datasetMeta?.zip_file) {
                const loaded = await bootstrapEvalDatasetWithProductionImport({
                    table: datasetMeta.table,
                    zipFile: datasetMeta.zip_file
                });
                sampleYaml = loaded.sampleYaml;
                appendLog(
                    `[${datasetId}] production-path import (eval PGLite): ${
                        loaded.inserted
                    }/${loaded.totalFeatures} rows in \`features\`${
                        loaded.truncated ? " (truncated)" : ""
                    }; compat VIEW ${datasetMeta.table} applied`
                );
            } else {
                appendLog(
                    `[${datasetId}] no tiger zip mapped; Layer B / gold execution may fail.`
                );
            }

            const propKeysForPlanner = propKeys.filter(
                (k) => k && k.toLowerCase() !== "geom"
            );
            const metadataBrief =
                `Magda-style geosql eval: imported spatial data lives in table \`features\` (id, properties JSONB, geom). ` +
                `Planner must emit SQL against \`features\` only. ` +
                `Property keys (from profile / shapefile attributes): ${
                    propKeysForPlanner.join(", ") || "N/A"
                }.`;

            const fileDescItems = [
                [
                    "schema_binding:",
                    "  table: features",
                    "  properties_schema:",
                    "    existing_keys:",
                    ...propKeysForPlanner.map((k) => `      - ${k}`)
                ].join("\n"),
                `sample_imported_rows (truncated JSON):\n${sampleYaml}`
            ];

            for (let i = 0; i < cases.length; i++) {
                const caseItem = cases[i];
                appendLog(
                    `[${datasetId}] [${i + 1}/${cases.length}] ${
                        caseItem.id
                    } - running`
                );
                const input = buildEvalChainInput(
                    model,
                    caseItem.question,
                    propKeys,
                    distTitle
                );
                (input as any).__geoDistItems = evalDistItems;
                (input as any).__geoMetadataBrief = metadataBrief;
                (input as any).__geoFileDescItems = fileDescItems;
                (input as any).__geoProfilePropertyKeysByIdx = {
                    0: propKeysForPlanner
                };
                (input as any).__geoEvalPgliteTarget = "eval";
                (input as any).__geoEvalSkipImport = true;

                let route = "unknown";
                let routeSource = "fallback";
                let plan: GeoSqlEvalPlan = {
                    type: "not_applicable",
                    reason: "Not run"
                };
                let finalSql = "";
                let firstSql = "";
                let fixes: string[] = [];
                let errorCategory: string | null = null;
                let prodReturned: string | null = null;
                try {
                    const intent = await classifySpatialIntentForEval(input);
                    route = intent.route;
                    routeSource = intent.source;
                    (input as any).__geoIntent = intent;

                    plan = await planGeoSqlQuery.call(
                        input,
                        evalDistItems,
                        metadataBrief,
                        fileDescItems
                    );
                    if (plan.type === "query") {
                        firstSql = plan.sqlQuery || "";
                        prodReturned = await queryGeoSpatialWithSQLQuery.call(
                            input,
                            plan.distributionIndex,
                            plan.sqlQuery,
                            plan.placeName,
                            plan.countrycodes
                        );
                        finalSql =
                            (input as any).__geoEvalExecutedSqlFinal || "";
                        const sf = (input as any).__geoEvalSanitizerFixes;
                        fixes = Array.isArray(sf) ? sf : [];
                    }
                } catch (e) {
                    errorCategory = "runtime";
                    appendLog(
                        `[${caseItem.id}] error: ${(e as Error).message}`
                    );
                }

                const hasQuery =
                    plan.type === "query" &&
                    !!firstSql.trim() &&
                    !errorCategory;
                const goldResult = await executeSql(caseItem.gold_sql || "");
                const firstResult =
                    plan.type === "query"
                        ? await executeSql(firstSql)
                        : {
                              ok: false,
                              rows: [],
                              hash: null,
                              error: "planner_not_query"
                          };
                const finalResult =
                    plan.type === "query"
                        ? await executeSql(finalSql)
                        : {
                              ok: false,
                              rows: [],
                              hash: null,
                              error: "planner_not_query"
                          };

                const firstErr = errorCategory || firstResult.error;
                const prodOk =
                    plan.type === "query" ? prodReturned !== null : false;
                const finalErr = errorCategory || finalResult.error;
                const resultCorrectFirst =
                    goldResult.ok &&
                    firstResult.ok &&
                    goldResult.hash === firstResult.hash;
                const resultCorrectFinal =
                    goldResult.ok &&
                    finalResult.ok &&
                    goldResult.hash === finalResult.hash;
                results.push({
                    case_id: caseItem.id,
                    question: caseItem.question,
                    expected_route: caseItem.expected_route,
                    op_family:
                        caseItem.op_family || inferOpFamily(caseItem.gold_sql),
                    single_table_only: true,
                    ddl_files: caseItem.ddl_files,
                    layerA: {
                        syntax_valid_first: hasQuery,
                        execution_pass_first: firstResult.ok,
                        execution_pass_final: prodOk,
                        error_category_first: firstErr
                            ? classifyExecutionError(firstErr)
                            : plan.type === "not_applicable"
                            ? "unknown"
                            : null,
                        error_category_final: finalErr
                            ? classifyExecutionError(finalErr)
                            : plan.type === "not_applicable"
                            ? "unknown"
                            : null
                    },
                    layerB: {
                        result_correct_first: resultCorrectFirst,
                        result_correct_final: resultCorrectFinal
                    },
                    traces: {
                        model_mode: "real-webllm",
                        route,
                        route_source: routeSource,
                        planner_type: plan.type,
                        generated_sql_first:
                            plan.type === "query" ? firstSql : null,
                        generated_sql_final: finalSql || null,
                        gold_sql: caseItem.gold_sql || null,
                        gold_rows_hash: goldResult.hash,
                        first_rows_hash: firstResult.hash,
                        final_rows_hash: finalResult.hash,
                        sanitizer_fixes: fixes,
                        notes: `LayerB compare by result hash; gold_ok=${goldResult.ok}, first_ok=${firstResult.ok}, final_ok=${finalResult.ok}; production_query_tool_ok=${prodOk}`
                    }
                });
            }

            const built: Report = {
                run: {
                    tag,
                    dataset_id: datasetId,
                    dataset_table: distTitle,
                    started_at: startedAt,
                    finished_at: new Date().toISOString(),
                    adapter: "browser-webllm-runner",
                    cases_count: results.length,
                    model: modelName
                },
                summary: buildSummary(results),
                results
            };
            return built;
        },
        [appendLog, modelName, tag]
    );

    const runEval = useCallback(async () => {
        setReport(null);
        setLogs([]);
        let cases: EvalCase[];
        try {
            cases = parseJsonl(casesText);
        } catch (e) {
            appendLog(`Failed to parse JSONL: ${(e as Error).message}`);
            return;
        }
        cases = cases.filter(isSingleTableCase);
        if (!cases.length) {
            appendLog("No cases to run after filtering.");
            return;
        }

        setRunning(true);
        try {
            const model = await initModel();
            const built = await evaluateCasesForDataset(
                model,
                cases,
                selectedDataset
            );
            if (!built) {
                appendLog("No single-table cases available.");
                return;
            }
            setReport(built);
            appendLog("Run finished.");
        } catch (e) {
            appendLog(`Run failed: ${(e as Error).message}`);
        } finally {
            setRunning(false);
        }
    }, [
        appendLog,
        casesText,
        evaluateCasesForDataset,
        initModel,
        selectedDataset
    ]);

    const runAllDatasetsSingleTable = useCallback(async () => {
        setReport(null);
        setLogs([]);
        if (!datasets.length) {
            appendLog("No dataset presets loaded.");
            return;
        }
        setRunning(true);
        try {
            const model = await initModel();
            const startedAt = new Date().toISOString();
            const datasetReports: AllDatasetsReport["dataset_reports"] = [];
            const allResults: CaseResult[] = [];

            for (const ds of datasets) {
                try {
                    appendLog(`[all] loading dataset ${ds.id}`);
                    const casesRaw = await fetch(
                        `/eval-data/by-ddl/${ds.jsonl_file}`
                    ).then((r) => r.text());
                    const parsedCases = parseJsonl(casesRaw);
                    const built = await evaluateCasesForDataset(
                        model,
                        parsedCases,
                        ds
                    );
                    if (!built) {
                        continue;
                    }
                    datasetReports.push({
                        dataset_id: built.run.dataset_id,
                        dataset_table: built.run.dataset_table,
                        cases_count: built.run.cases_count,
                        summary: built.summary
                    });
                    allResults.push(...built.results);
                } catch (e) {
                    appendLog(
                        `[all] dataset ${ds.id} failed: ${(e as Error).message}`
                    );
                }
            }

            if (!allResults.length) {
                appendLog("No single-table results produced across datasets.");
                return;
            }

            const combined: AllDatasetsReport = {
                run: {
                    tag,
                    started_at: startedAt,
                    finished_at: new Date().toISOString(),
                    adapter: "browser-webllm-runner",
                    datasets_count: datasetReports.length,
                    model: modelName,
                    mode: "single-table-only"
                },
                summary: buildSummary(allResults),
                dataset_reports: datasetReports,
                results: allResults
            };
            downloadJson(
                `geosql-eval-report-${tag}-all-datasets-single-table.json`,
                combined
            );
            appendLog(
                `[all] done. datasets=${datasetReports.length}, cases=${allResults.length}, auto-downloaded combined report.`
            );
        } catch (e) {
            appendLog(`[all] failed: ${(e as Error).message}`);
        } finally {
            setRunning(false);
        }
    }, [
        appendLog,
        datasets,
        evaluateCasesForDataset,
        initModel,
        modelName,
        tag
    ]);

    const summaryRows = useMemo(() => {
        if (!report) return [];
        const a = report.summary.layerA;
        const sm = report.summary.by_single_vs_multi;
        return [
            ["dataset_id", report.run.dataset_id],
            ["table", report.run.dataset_table],
            ["sample_count", String(report.summary.sample_count)],
            ["single_table_cases", String(sm.single_table)],
            ["multi_table_cases", String(sm.multi_table)],
            ["syntax_accuracy", String(a.syntax_accuracy)],
            ["epr_first", String(a.epr_first)],
            ["epr_final", String(a.epr_final)]
        ];
    }, [report]);

    return (
        <div
            style={{
                padding: 24,
                fontFamily: "system-ui, sans-serif",
                maxWidth: 980,
                margin: "0 auto"
            }}
        >
            <h2>GeoSQL Eval Runner (Browser, real WebLLM)</h2>
            <p style={{ color: "#555" }}>
                Per-dataset evaluation against <code>geosql-llm-eval</code>{" "}
                JSONL, restricted to single-table cases only. Runs router +
                planner + sanitizer with the same WebLLM model used by Magda's
                chatbot. This page is dev/eval only and is not linked from the
                main UI.
            </p>

            <div
                style={{
                    display: "grid",
                    gridTemplateColumns: "1fr 1fr",
                    gap: 16,
                    marginTop: 16
                }}
            >
                <label>
                    Run tag
                    <input
                        value={tag}
                        onChange={(e) => setTag(e.target.value)}
                        style={{ width: "100%", padding: 6 }}
                    />
                </label>
                <label>
                    WebLLM model
                    <input
                        value={modelName}
                        onChange={(e) => setModelName(e.target.value)}
                        style={{ width: "100%", padding: 6 }}
                    />
                </label>
            </div>

            <div style={{ marginTop: 16 }}>
                <label>
                    Dataset preset (recommended)
                    <select
                        value={selectedDatasetId}
                        onChange={(e) => setSelectedDatasetId(e.target.value)}
                        style={{ width: "100%", padding: 6 }}
                    >
                        <option value="">
                            -- pick a dataset (or paste JSONL below) --
                        </option>
                        {datasets.map((d) => (
                            <option key={d.id} value={d.id}>
                                {d.label} | total={d.cases_total} (single=
                                {d.cases_single_table}, multi=
                                {d.cases_multi_table})
                            </option>
                        ))}
                    </select>
                </label>
                <div style={{ marginTop: 8, color: "#444" }}>
                    Fixed mode: only cases with exactly one item in{" "}
                    <code>ddl_files</code> are evaluated.
                </div>
            </div>

            <div style={{ marginTop: 16 }}>
                <label>
                    Test cases (JSONL) - optional manual override
                    <input
                        type="file"
                        accept=".jsonl,.json,.txt"
                        onChange={(e) => {
                            const file = e.target.files?.[0];
                            if (file) handleFile(file);
                        }}
                    />
                </label>
                <textarea
                    value={casesText}
                    onChange={(e) => setCasesText(e.target.value)}
                    rows={6}
                    placeholder='{"id":"geo-001","question":"...","gold_sql":"..."}'
                    style={{
                        width: "100%",
                        padding: 8,
                        marginTop: 8,
                        fontFamily: "monospace",
                        fontSize: 12
                    }}
                />
            </div>

            {ddlText && (
                <details style={{ marginTop: 12 }}>
                    <summary>
                        DDL passed to planner ({selectedDataset?.table || "n/a"}
                        )
                    </summary>
                    <pre
                        style={{
                            background: "#f5f5f5",
                            padding: 8,
                            fontSize: 12,
                            maxHeight: 180,
                            overflow: "auto"
                        }}
                    >
                        {ddlText}
                    </pre>
                </details>
            )}

            <div style={{ marginTop: 16 }}>
                <button
                    onClick={runEval}
                    disabled={running}
                    style={{ padding: "8px 16px" }}
                >
                    {running ? "Running..." : "Run evaluation"}
                </button>
                <button
                    onClick={runAllDatasetsSingleTable}
                    disabled={running}
                    style={{ padding: "8px 16px", marginLeft: 8 }}
                >
                    {running
                        ? "Running..."
                        : "Run all datasets (single-table only)"}
                </button>
                {report && (
                    <button
                        onClick={() =>
                            downloadJson(
                                `geosql-eval-report-${tag}-${report.run.dataset_id}.json`,
                                report
                            )
                        }
                        style={{ padding: "8px 16px", marginLeft: 8 }}
                    >
                        Download report.json
                    </button>
                )}
                {progress && (
                    <div style={{ marginTop: 8, color: "#666" }}>
                        {progress}
                    </div>
                )}
            </div>

            {report && (
                <div style={{ marginTop: 24 }}>
                    <h3>Summary</h3>
                    <table
                        cellPadding={6}
                        style={{
                            borderCollapse: "collapse",
                            border: "1px solid #ccc"
                        }}
                    >
                        <tbody>
                            {summaryRows.map(([k, v]) => (
                                <tr key={k}>
                                    <td
                                        style={{
                                            border: "1px solid #ccc",
                                            fontWeight: 600
                                        }}
                                    >
                                        {k}
                                    </td>
                                    <td style={{ border: "1px solid #ccc" }}>
                                        {v}
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}

            <div style={{ marginTop: 24 }}>
                <h3>Logs</h3>
                <pre
                    style={{
                        maxHeight: 240,
                        overflow: "auto",
                        background: "#111",
                        color: "#0f0",
                        padding: 12,
                        fontSize: 12
                    }}
                >
                    {logs.join("\n")}
                </pre>
            </div>
        </div>
    );
};

export default GeoSqlEvalRunnerPage;
