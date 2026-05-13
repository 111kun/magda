import React, {
    useCallback,
    useEffect,
    useMemo,
    useRef,
    useState
} from "react";
import type { Location } from "history";
import type { InitProgressReport } from "@mlc-ai/web-llm";
import {
    importSpatialFromDistribution,
    runPostgisQuery
} from "../../../libs/pglitePostgis";
import type { ChatEventMessage } from "../Messaging";
import { EVENT_TYPE_RUN_LOG } from "../Messaging";
import AgentChain from "../AgentChain";
import { getDistributionUrl } from "../tools/queryGeoDataset/distribution";
import {
    applyGoldSqlCompatView,
    buildParsedDatasetForGeoEval,
    createGeoEvalAgentChain,
    registerGeoEvalDatasetMappings,
    resetGeoEvalDistributionMappings
} from "./geoEvalFixtures";
import type { GeoEvalDatasetMeta } from "./geoEvalFixtures";

/** Report trace only: real planner is inside AgentChain + queryGeoDataset. */
type GeoSqlEvalPlannerTrace = "query" | "not_applicable";

type EvalCase = {
    id: string;
    question: string;
    gold_sql?: string;
    expected_route?: string;
    op_family?: string;
    tags?: string[];
    ddl_files?: string[];
};

type DatasetMeta = GeoEvalDatasetMeta;

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
        planner_type: GeoSqlEvalPlannerTrace;
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
    if (msg === "no_executed_sql" || msg === "no_generated_sql") {
        return "unknown";
    }
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

/** Gold / generated SQL execution uses the same production PGLite as AgentChain. */
async function executeSql(sql: string): Promise<PgExecResult> {
    if (!sql?.trim()) {
        return { ok: false, rows: [], hash: null, error: "empty SQL" };
    }
    try {
        const rows = await runPostgisQuery(sql);
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

/** Same text as `createChain` run log: `Router action: ${action}. ${reason}` */
function parseRouterActionFromRunLog(
    msg: string
): {
    action: string;
    reason: string;
} | null {
    const prefix = "Router action: ";
    if (!msg.startsWith(prefix)) {
        return null;
    }
    const rest = msg.slice(prefix.length);
    const dot = rest.indexOf(". ");
    if (dot === -1) {
        const action = rest.trim();
        return action ? { action, reason: "" } : null;
    }
    return {
        action: rest.slice(0, dot).trim(),
        reason: rest.slice(dot + 2).trim()
    };
}

type DrainChainOutcome = { route?: string; routeSource?: string };

type DrainChainStreamOptions = {
    /** Mirror System Logs into the eval panel so long WebLLM steps do not look hung. */
    onRunLog?: (msg: string) => void;
    /** Cap forwarded run_log size (GeoSQL blocks can be large). */
    maxRunLogChars?: number;
};

/**
 * Drains the stream queue. Also extracts the last router line from run_log
 * events (no extra `decideChatRoute` — that already runs inside `chain.stream`).
 */
async function drainChainStream(
    iter: AsyncIterable<unknown>,
    opts?: DrainChainStreamOptions
): Promise<DrainChainOutcome> {
    const maxRun = opts?.maxRunLogChars ?? 600;
    let route: string | undefined;
    let routeSource: string | undefined;
    for await (const ev of iter) {
        if (
            ev &&
            typeof ev === "object" &&
            "event" in (ev as object) &&
            (ev as ChatEventMessage).event === EVENT_TYPE_RUN_LOG
        ) {
            const msg = String((ev as ChatEventMessage).data?.msg ?? "");
            if (opts?.onRunLog && msg.trim()) {
                opts.onRunLog(
                    msg.length > maxRun ? `${msg.slice(0, maxRun)}…` : msg
                );
            }
            const parsed = parseRouterActionFromRunLog(msg);
            if (parsed) {
                route = parsed.action;
                routeSource = parsed.reason;
            }
        }
    }
    return { route, routeSource };
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
    const evalChainRef = useRef<AgentChain | null>(null);

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
                    }). From magda-web-client run \`npm run sync-eval-data\` (writes public/eval-data/) to enable presets, or paste JSONL manually below.`
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

    useEffect(() => {
        evalChainRef.current = null;
    }, [modelName]);

    const initEvalAgentChain = useCallback(async () => {
        if (evalChainRef.current) {
            return evalChainRef.current;
        }
        appendLog(`Creating isolated AgentChain + WebLLM (${modelName})…`);
        const chain = createGeoEvalAgentChain((report: InitProgressReport) => {
            setProgress(
                `${report.text} (${(report.progress * 100).toFixed(1)}%)`
            );
        });
        await chain.initialize((e) =>
            appendLog(`WebLLM init error: ${String(e)}`)
        );
        await chain.updateModelConfig({ model: modelName }, (e) =>
            appendLog(`Model config: ${String(e)}`)
        );
        evalChainRef.current = chain;
        appendLog(
            "Eval harness ready: production AgentChain + datasetProfile enrichment + fake registry URLs → /eval-data."
        );
        setProgress("Model ready.");
        return chain;
    }, [appendLog, modelName]);

    const evaluateCasesForDataset = useCallback(
        async (
            agentChain: AgentChain,
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
            if (!datasetMeta?.zip_file) {
                appendLog(
                    "Dataset preset missing zip_file — cannot map fake download URL to local static assets."
                );
                return null;
            }

            const distTitle = datasetMeta.table || "eval-dist";
            const datasetId = datasetMeta.id || "manual";
            const startedAt = new Date().toISOString();
            const results: CaseResult[] = [];

            resetGeoEvalDistributionMappings();
            registerGeoEvalDatasetMappings(datasetMeta);
            const parsed = buildParsedDatasetForGeoEval(datasetMeta);
            agentChain.setDataset(parsed);
            agentChain.setDistribution(undefined);
            agentChain.setNavLocation({
                pathname: `/dataset/geosql-eval-${datasetId}`,
                search: "",
                hash: "",
                state: undefined,
                key: "default"
            } as Location);
            agentChain.clearDatasetProfileCache();

            appendLog(
                `[${datasetId}] Warmup: enrichSpatialProfile (production import + profile)…`
            );
            await drainChainStream(
                await agentChain.stream(".", { warmupOnly: true }),
                {
                    onRunLog: (m) => appendLog(`[${datasetId}] warmup: ${m}`)
                }
            );
            appendLog(`[${datasetId}] Applying gold-sql compat VIEW…`);
            await applyGoldSqlCompatView(datasetMeta.table);

            const evalDist = parsed.distributions[0];
            const evalUrl = getDistributionUrl(evalDist);
            if (!evalUrl) {
                appendLog(
                    `[${datasetId}] No distribution URL for eval import — aborting.`
                );
                return null;
            }
            appendLog(
                `[${datasetId}] One-time full spatial load for eval (PostGIS \`features\`; zip import may take several minutes)…`
            );
            await importSpatialFromDistribution(
                evalUrl,
                evalDist.format,
                evalDist.title
            );
            appendLog(`[${datasetId}] Full spatial load finished.`);

            for (let i = 0; i < cases.length; i++) {
                const caseItem = cases[i];
                appendLog(
                    `[${datasetId}] [${i + 1}/${cases.length}] ${
                        caseItem.id
                    } — AgentChain + WebLLM GeoSQL (browser planner can take several minutes per case; logs follow).`
                );

                let route = "unknown";
                let routeSource = "fallback";
                let plannerType: GeoSqlEvalPlannerTrace = "not_applicable";
                let finalSql = "";
                let firstSql = "";
                let fixes: string[] = [];
                let errorCategory: string | null = null;
                let prodReturned: string | null = null;

                try {
                    const drained = await drainChainStream(
                        await agentChain.stream(caseItem.question, {
                            geoEvalCaptureExecutedSql: true
                        }),
                        {
                            onRunLog: (m) =>
                                appendLog(
                                    `[${datasetId}] [${caseItem.id}] ${m}`
                                )
                        }
                    );
                    route = drained.route ?? "unknown";
                    routeSource = drained.routeSource ?? "fallback";
                    const cap = agentChain.lastEvalChainInput;
                    finalSql = cap?.evalCapturedExecutedSql?.trim() || "";
                    firstSql = cap?.evalCapturedExecutedSqlFirst?.trim() || "";
                    fixes = cap?.evalCapturedSanitizerFixes || [];
                    prodReturned =
                        finalSql || firstSql ? "__tool_finished__" : null;
                    plannerType =
                        finalSql || firstSql ? "query" : "not_applicable";
                } catch (e) {
                    errorCategory = "runtime";
                    appendLog(
                        `[${caseItem.id}] error: ${(e as Error).message}`
                    );
                }

                const hasQuery = !!firstSql && !errorCategory;
                const goldResult = await executeSql(caseItem.gold_sql || "");
                const firstResult = firstSql
                    ? await executeSql(firstSql)
                    : {
                          ok: false,
                          rows: [],
                          hash: null,
                          error: "no_generated_sql"
                      };
                const finalResult = finalSql
                    ? await executeSql(finalSql)
                    : {
                          ok: false,
                          rows: [],
                          hash: null,
                          error: "no_executed_sql"
                      };

                const firstErr = errorCategory || firstResult.error;
                const prodOk = prodReturned !== null;
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
                        execution_pass_final: finalResult.ok,
                        error_category_first: firstErr
                            ? classifyExecutionError(firstErr)
                            : plannerType === "not_applicable"
                            ? "unknown"
                            : null,
                        error_category_final: finalErr
                            ? classifyExecutionError(finalErr)
                            : plannerType === "not_applicable"
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
                        planner_type: plannerType,
                        generated_sql_first: firstSql || null,
                        generated_sql_final: finalSql || null,
                        gold_sql: caseItem.gold_sql || null,
                        gold_rows_hash: goldResult.hash,
                        first_rows_hash: firstResult.hash,
                        final_rows_hash: finalResult.hash,
                        sanitizer_fixes: fixes,
                        notes: `AgentChain path; fake URL→/eval-data; gold_ok=${goldResult.ok}, first_ok=${firstResult.ok}, final_ok=${finalResult.ok}; capture_ok=${prodOk}`
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
                    adapter: "agentchain-production-parity",
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
            const chain = await initEvalAgentChain();
            const built = await evaluateCasesForDataset(
                chain,
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
        initEvalAgentChain,
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
            const chain = await initEvalAgentChain();
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
                        chain,
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
        initEvalAgentChain,
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
                Single-table cases only. Uses an isolated{" "}
                <code>AgentChain</code> (same <code>createChain</code> path as
                the dataset chatbot): <code>datasetProfile</code> enrichment,{" "}
                <code>decideChatRoute</code>, and <code>queryGeoDataset</code>.
                Distribution download URLs are fake registry URLs rewritten to{" "}
                <code>/eval-data/tiger-files/*.zip</code> via{" "}
                <code>getDistributionUrl</code>. Dev/eval only.
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
                    type="button"
                    onClick={runEval}
                    disabled={running}
                    style={{ padding: "8px 16px" }}
                >
                    {running ? "Running..." : "Run evaluation"}
                </button>
                <button
                    type="button"
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
                        type="button"
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
