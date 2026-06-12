import React, {
    useCallback,
    useEffect,
    useMemo,
    useRef,
    useState
} from "react";
import { Link, useHistory } from "react-router-dom";
import { useDispatch, useSelector } from "react-redux";
import {
    Button,
    ButtonToolbar,
    Input,
    Loader,
    Message,
    Panel,
    Radio,
    RadioGroup
} from "rsuite";
import SelectPicker from "rsuite/SelectPicker";
import MagdaNamespacesConsumer from "Components/i18n/MagdaNamespacesConsumer";
import AgentChain from "./AgentChain";
import { resolveEvalOpenAiDefaults } from "./ChatEvalOpenAi";
import { fetchDatasetFromRegistry } from "actions/recordActions";
import { StateType } from "reducers/reducer";
import { ParsedDataset } from "helpers/record";
import { config } from "config";
import { runPostgisQuery } from "libs/pglitePostgis";
import { fetchRecord } from "api-clients/RegistryApis";
import {
    buildReport,
    classifySqlError,
    downloadCombinedJsonReport,
    downloadCsvSummary,
    downloadJsonReport,
    EvalCaseRow,
    GeoSqlEvalReport,
    isReadableSql
} from "helpers/geoSqlEvalReport";
import {
    formatDurationMs,
    parseLlmUsageFromSystemLogs
} from "helpers/geoSqlEvalMetrics";
import { generateBaselineDirectSql } from "helpers/geoSqlBaselineDirect";
import {
    formatEvalCaseTimeoutLabel,
    resolveEvalCaseTimeoutMs,
    withEvalCaseTimeout
} from "helpers/geoSqlEvalCaseTimeout";
import { buildGeoFileDescriptionsAndIntro } from "./tools/queryGeoDataset/description";
import { isGeoSpatialDistribution } from "./tools/queryGeoDataset/distribution";
import {
    clearEvalCheckpoint,
    EVAL_SLUG_ORDER,
    EvalRunMode,
    GeoSqlEvalCheckpoint,
    loadEvalCheckpoint,
    newRunId,
    saveEvalCheckpoint
} from "helpers/geoSqlEvalCheckpoint";
import { parseDataset } from "helpers/record";
import {
    compareQueryResults,
    rowsToComparableSignature
} from "helpers/geoSqlEvalRowFingerprint";
import {
    ChatEventMessage,
    EVENT_TYPE_ERROR,
    EVENT_TYPE_RUN_LOG
} from "./Messaging";
import reportError from "helpers/reportError";

const LS_DATASET_IDS = "magdaGeoSqlEvalDatasetIds";
const LS_LLM_PROVIDER = "magdaGeoSqlEvalLlmProvider";
const LS_OPENAI_KEY = "magdaGeoSqlEvalOpenAiApiKey";
const LS_OPENAI_BASE = "magdaGeoSqlEvalOpenAiBaseUrl";
const LS_OPENAI_MODEL = "magdaGeoSqlEvalOpenAiModel";
const LS_EVAL_PIPELINE = "magdaGeoSqlEvalPipeline";

export type EvalLlmProvider = "webllm" | "openai";
export type EvalPipelineMode =
    | "agent"
    | "agent_full_planner"
    | "baseline_direct";

function loadEvalPipeline(): EvalPipelineMode {
    try {
        const v = localStorage.getItem(LS_EVAL_PIPELINE);
        if (v === "baseline_direct") return "baseline_direct";
        if (v === "agent") return "agent";
        return "agent_full_planner";
    } catch {
        return "agent_full_planner";
    }
}

function geoDistItems(dataset: ParsedDataset) {
    return (dataset.distributions || [])
        .map((dist, idx) => ({ idx, dist }))
        .filter((item) => isGeoSpatialDistribution(item.dist));
}

function loadEvalLlmProvider(): EvalLlmProvider {
    try {
        const v = localStorage.getItem(LS_LLM_PROVIDER);
        return v === "openai" ? "openai" : "webllm";
    } catch {
        return "webllm";
    }
}

function loadOpenAiEvalSettings(): {
    apiKey: string;
    baseUrl: string;
    model: string;
} {
    const defaults = resolveEvalOpenAiDefaults();
    try {
        return {
            apiKey: localStorage.getItem(LS_OPENAI_KEY) || "",
            baseUrl: localStorage.getItem(LS_OPENAI_BASE) || defaults.baseUrl,
            model: localStorage.getItem(LS_OPENAI_MODEL) || defaults.model
        };
    } catch {
        return { apiKey: "", baseUrl: defaults.baseUrl, model: defaults.model };
    }
}

function persistOpenAiEvalSettings(
    apiKey: string,
    baseUrl: string,
    model: string
) {
    localStorage.setItem(LS_OPENAI_KEY, apiKey);
    localStorage.setItem(LS_OPENAI_BASE, baseUrl.trim());
    localStorage.setItem(LS_OPENAI_MODEL, model.trim());
}

type ManifestEntry = {
    title: string;
    magda_dataset_id: string;
};

type ManifestMap = Record<string, ManifestEntry>;

type EvalCase = {
    id: string;
    dataset_slug: string;
    question: string;
    gold_sql: string;
    distribution_index?: number;
    tags?: string[];
};

type HarnessLogLine = {
    at: string;
    level: "info" | "warn" | "error" | "ok";
    message: string;
};

function loadIdOverrides(): Record<string, string> {
    try {
        const raw = localStorage.getItem(LS_DATASET_IDS);
        if (!raw) return {};
        const o = JSON.parse(raw) as Record<string, string>;
        return o && typeof o === "object" ? o : {};
    } catch {
        return {};
    }
}

function saveIdOverride(slug: string, id: string) {
    const next = loadIdOverrides();
    if (id.trim()) {
        next[slug] = id.trim();
    } else {
        delete next[slug];
    }
    localStorage.setItem(LS_DATASET_IDS, JSON.stringify(next));
}

function parseJsonl(text: string): EvalCase[] {
    const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
    return lines.map((line, i) => {
        try {
            return JSON.parse(line) as EvalCase;
        } catch (e) {
            throw new Error(`JSONL line ${i + 1}: ${e}`);
        }
    });
}

function caseFileForSlug(slug: string): string {
    if (slug === "land_zones") return "land_zones.jsonl";
    if (slug === "manningham_trees") return "manningham_trees.jsonl";
    if (slug === "road_segment") return "road_segment.jsonl";
    return `${slug}.jsonl`;
}

async function tryExecuteSql(
    sql: string | undefined
): Promise<{ ok: boolean; rows?: Record<string, unknown>[]; error?: string }> {
    if (!isReadableSql(sql)) {
        return { ok: false, error: "empty or non-SELECT SQL" };
    }
    try {
        const rows = (await runPostgisQuery(sql!)) as Record<string, unknown>[];
        return { ok: true, rows };
    } catch (e) {
        return { ok: false, error: String(e) };
    }
}

async function collectStream(
    stream: AsyncIterable<ChatEventMessage>
): Promise<{ runLogs: string[]; streamError?: string }> {
    const runLogs: string[] = [];
    let streamError: string | undefined;
    for await (const ev of stream) {
        if (ev.event === EVENT_TYPE_RUN_LOG && ev.data?.msg) {
            runLogs.push(String(ev.data.msg));
        }
        if (ev.event === EVENT_TYPE_ERROR) {
            const err = ev.data?.error;
            streamError =
                err instanceof Error
                    ? err.message
                    : typeof err === "string"
                    ? err
                    : String(err ?? "stream error");
        }
    }
    return { runLogs, streamError };
}

async function fetchCasesForSlug(slug: string): Promise<EvalCase[]> {
    const file = caseFileForSlug(slug);
    const res = await fetch(`/magda-eval/cases/${file}`);
    if (!res.ok) throw new Error(`${file} HTTP ${res.status}`);
    return parseJsonl(await res.text());
}

async function fetchParsedDataset(id: string) {
    const raw = await fetchRecord(id);
    const parsed = parseDataset(raw);
    if (!parsed.identifier) {
        throw new Error(`Dataset ${id} could not be parsed from registry.`);
    }
    return parsed;
}

const GeoSqlEvalRunnerInner: React.FC<{ appName: string }> = ({ appName }) => {
    const history = useHistory();
    const dispatch = useDispatch();
    const dataset = useSelector<StateType, ParsedDataset | undefined>(
        (s) => s.record.dataset
    );
    const datasetIsFetching = useSelector<StateType, boolean>(
        (s) => s.record.datasetIsFetching
    );
    const datasetFetchError = useSelector<
        StateType,
        StateType["record"]["datasetFetchError"]
    >((s) => s.record.datasetFetchError);

    const [manifest, setManifest] = useState<ManifestMap | null>(null);
    const [manifestError, setManifestError] = useState<string | null>(null);
    const [slug, setSlug] = useState<string | null>(null);
    const [cases, setCases] = useState<EvalCase[] | null>(null);
    const [casesError, setCasesError] = useState<string | null>(null);
    const [datasetIdInput, setDatasetIdInput] = useState("");
    const [llmProgress, setLlmProgress] = useState<string | null>(null);
    const [runError, setRunError] = useState<string | null>(null);
    const [running, setRunning] = useState(false);
    const [runMode, setRunMode] = useState<EvalRunMode | null>(null);
    const [lastReport, setLastReport] = useState<GeoSqlEvalReport | null>(null);
    const [allReports, setAllReports] = useState<GeoSqlEvalReport[] | null>(
        null
    );
    const [harnessLog, setHarnessLog] = useState<HarnessLogLine[]>([]);
    const [checkpoint, setCheckpoint] = useState<GeoSqlEvalCheckpoint | null>(
        () => loadEvalCheckpoint()
    );
    const openAiDefaults = useMemo(() => resolveEvalOpenAiDefaults(), []);
    const [llmProvider, setLlmProvider] = useState<EvalLlmProvider>(() =>
        loadEvalLlmProvider()
    );
    const [evalPipeline, setEvalPipeline] = useState<EvalPipelineMode>(() =>
        loadEvalPipeline()
    );
    const [openAiApiKey, setOpenAiApiKey] = useState("");
    const [openAiBaseUrl, setOpenAiBaseUrl] = useState(openAiDefaults.baseUrl);
    const [openAiModel, setOpenAiModel] = useState(openAiDefaults.model);

    const agentRef = useRef<AgentChain | null>(null);
    const cancelRef = useRef(false);
    const logEndRef = useRef<HTMLDivElement | null>(null);

    useEffect(() => {
        const s = loadOpenAiEvalSettings();
        setOpenAiApiKey(s.apiKey);
        setOpenAiBaseUrl(s.baseUrl);
        setOpenAiModel(s.model);
    }, []);

    const appendLog = useCallback(
        (message: string, level: HarnessLogLine["level"] = "info") => {
            const line: HarnessLogLine = {
                at: new Date().toISOString(),
                level,
                message
            };
            setHarnessLog((prev) => [...prev, line]);
        },
        []
    );

    useEffect(() => {
        logEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }, [harnessLog]);

    useEffect(() => {
        if (!running) return;
        const onBeforeUnload = (e: BeforeUnloadEvent) => {
            e.preventDefault();
            e.returnValue = "";
        };
        window.addEventListener("beforeunload", onBeforeUnload);
        return () => window.removeEventListener("beforeunload", onBeforeUnload);
    }, [running]);

    useEffect(() => {
        let cancelled = false;
        (async () => {
            try {
                const res = await fetch("/magda-eval/manifest.json");
                if (!res.ok) throw new Error(`manifest ${res.status}`);
                const data = (await res.json()) as ManifestMap;
                if (cancelled) return;
                setManifest(data);
                const keys = Object.keys(data);
                const overrides = loadIdOverrides();
                const first = keys[0] || null;
                setSlug(first);
                if (first) {
                    setDatasetIdInput(
                        overrides[first] || data[first]?.magda_dataset_id || ""
                    );
                }
            } catch (e) {
                if (!cancelled) {
                    setManifestError(
                        `Failed to load /magda-eval/manifest.json. Run yarn sync-magda-eval first. ${e}`
                    );
                }
            }
        })();
        return () => {
            cancelled = true;
        };
    }, []);

    useEffect(() => {
        if (!slug) {
            setCases(null);
            return;
        }
        let cancelled = false;
        setCasesError(null);
        setCases(null);
        (async () => {
            try {
                const file = caseFileForSlug(slug);
                const res = await fetch(`/magda-eval/cases/${file}`);
                if (!res.ok) throw new Error(`${file} ${res.status}`);
                const text = await res.text();
                if (cancelled) return;
                setCases(parseJsonl(text));
            } catch (e) {
                if (!cancelled) setCasesError(String(e));
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [slug]);

    useEffect(() => {
        if (!manifest || !slug) return;
        const overrides = loadIdOverrides();
        setDatasetIdInput(
            overrides[slug] || manifest[slug]?.magda_dataset_id || ""
        );
    }, [slug, manifest]);

    const effectiveDatasetId = datasetIdInput.trim();

    useEffect(() => {
        if (!effectiveDatasetId) return;
        dispatch(fetchDatasetFromRegistry(effectiveDatasetId) as any);
    }, [dispatch, effectiveDatasetId]);

    const datasetReady = useMemo(() => {
        if (!effectiveDatasetId) return false;
        if (datasetIsFetching || datasetFetchError) return false;
        if (!dataset?.identifier) return false;
        return dataset.identifier === effectiveDatasetId;
    }, [dataset, effectiveDatasetId, datasetIsFetching, datasetFetchError]);

    const pickerData = useMemo(() => {
        if (!manifest) return [];
        return Object.keys(manifest).map((k) => ({
            label: manifest[k]?.title || k,
            value: k
        }));
    }, [manifest]);

    const persistDatasetId = useCallback(() => {
        if (slug) saveIdOverride(slug, datasetIdInput);
    }, [slug, datasetIdInput]);

    const clearLogs = useCallback(() => setHarnessLog([]), []);

    const cancelRun = useCallback(() => {
        cancelRef.current = true;
        appendLog("Cancel requested — stopping after current step…", "warn");
    }, [appendLog]);

    const discardCheckpoint = useCallback(() => {
        clearEvalCheckpoint();
        setCheckpoint(null);
        appendLog("Checkpoint discarded.", "info");
    }, [appendLog]);

    const persistCheckpointState = useCallback((cp: GeoSqlEvalCheckpoint) => {
        saveEvalCheckpoint(cp);
        setCheckpoint(cp);
    }, []);

    const runOneDataset = useCallback(
        async (params: {
            targetSlug: string;
            targetCases: EvalCase[];
            targetDataset: ParsedDataset;
            targetDatasetId: string;
            agent: AgentChain;
            mode: EvalRunMode;
            runId: string;
            startCaseIndex: number;
            initialCaseRows: EvalCaseRow[];
            completedSlugs: string[];
            reportsBySlug: Record<string, GeoSqlEvalReport>;
            harnessLogSnapshot: GeoSqlEvalReport["harness_log"];
        }): Promise<GeoSqlEvalReport | null> => {
            const {
                targetSlug,
                targetCases,
                targetDataset,
                targetDatasetId,
                agent,
                mode,
                runId,
                startCaseIndex,
                initialCaseRows,
                completedSlugs,
                reportsBySlug,
                harnessLogSnapshot
            } = params;

            const snapLog = (
                message: string,
                level: HarnessLogLine["level"] = "info"
            ) => {
                const at = new Date().toISOString();
                harnessLogSnapshot.push({ at, level, message });
                appendLog(message, level);
            };

            const datasetRunStartedAt = new Date().toISOString();
            const datasetRunT0 = performance.now();
            let warmupWallMs = 0;

            const fakeLocation = {
                pathname: `/dataset/${targetDatasetId}`,
                search: "",
                hash: "",
                state: undefined
            } as any;
            agent.setNavLocation(fakeLocation);
            agent.setDataset(targetDataset);

            snapLog(
                `Phase 1/3: warmupOnly (profile + spatial import, no LLM) — ${targetSlug}`,
                "info"
            );
            agent.clearDatasetProfileCache();
            const warmupT0 = performance.now();
            const warmupStream = await agent.stream("warmup", {
                warmupOnly: true
            });
            const warmupCollected = await collectStream(warmupStream);
            warmupWallMs = performance.now() - warmupT0;
            for (const line of warmupCollected.runLogs) {
                snapLog(`[System] ${line}`, "info");
            }
            if (cancelRef.current) {
                snapLog("Run cancelled during warmup.", "warn");
                return null;
            }
            if (warmupCollected.streamError) {
                throw new Error(warmupCollected.streamError);
            }

            const spatialItems =
                agent.keyContextData.datasetProfile?.spatial?.items || [];
            if (!spatialItems.length) {
                throw new Error(
                    "No spatial distribution or profile import for this dataset."
                );
            }
            snapLog(
                `Warmup done: ${
                    spatialItems.length
                } spatial profile item(s) (${formatDurationMs(warmupWallMs)})`,
                "ok"
            );

            let baselinePrepared: {
                metadataBrief: string;
                fileDescItems: string[];
            } | null = null;
            if (evalPipeline === "baseline_direct") {
                const distItems = geoDistItems(targetDataset);
                baselinePrepared = await buildGeoFileDescriptionsAndIntro(
                    distItems,
                    targetDataset,
                    spatialItems,
                    { skipSpatialImportForSample: true }
                );
                snapLog(
                    `Baseline direct: ${baselinePrepared.fileDescItems.length} schema YAML block(s) ready.`,
                    "ok"
                );
            }

            const caseTimeoutMs = resolveEvalCaseTimeoutMs(llmProvider);
            snapLog(
                evalPipeline === "baseline_direct"
                    ? "Phase 2/3: per-case baseline (profile + question → LLM SQL → execute)"
                    : "Phase 2/3: per-case stream (spatial_sql → plan → execute → capture final SQL)",
                "info"
            );
            snapLog(
                `Per-case timeout: ${formatEvalCaseTimeoutLabel(
                    caseTimeoutMs
                )} (LLM phase; then skip to next case)`,
                "info"
            );

            const caseRows: EvalCaseRow[] = [...initialCaseRows];
            const baselineEngine =
                evalPipeline === "baseline_direct"
                    ? await agent.model.getEngine()
                    : null;

            for (let i = startCaseIndex; i < targetCases.length; i++) {
                if (cancelRef.current) {
                    snapLog("Run cancelled.", "warn");
                    persistCheckpointState({
                        runId,
                        mode,
                        startedAt:
                            checkpoint?.startedAt || new Date().toISOString(),
                        updatedAt: new Date().toISOString(),
                        slugs:
                            mode === "all"
                                ? [...EVAL_SLUG_ORDER]
                                : [targetSlug],
                        completedSlugs,
                        currentSlug: targetSlug,
                        currentCaseIndex: i,
                        reports: reportsBySlug
                    });
                    return null;
                }

                const c = targetCases[i];
                const caseStartedAt = new Date().toISOString();
                const caseT0 = performance.now();
                snapLog(
                    `[${i + 1}/${targetCases.length}] ${
                        c.id
                    } — Q: ${c.question.slice(0, 80)}${
                        c.question.length > 80 ? "…" : ""
                    }`,
                    "info"
                );

                try {
                    if (c.dataset_slug !== targetSlug) {
                        caseRows.push({
                            case_id: c.id,
                            question: c.question,
                            tags: c.tags,
                            gold_sql: c.gold_sql,
                            layer_a: {
                                syntax_accuracy_first: false,
                                syntax_accuracy_final: false,
                                execution_pass_first: false,
                                execution_pass_final: false,
                                error_bucket_first: "routing",
                                error_bucket_final: "routing",
                                repair_gain: false
                            },
                            layer_b: {
                                result_match: false,
                                match_mode: "none",
                                gold_fingerprint: "",
                                model_fingerprint: "",
                                gold_row_count: 0,
                                model_row_count: 0
                            },
                            error_message: `dataset_slug mismatch (expected ${targetSlug})`,
                            timing: {
                                wall_ms: performance.now() - caseT0,
                                started_at: caseStartedAt,
                                finished_at: new Date().toISOString()
                            }
                        });
                        snapLog("  ✗ slug mismatch, skipped", "warn");
                        continue;
                    }

                    const llmPhase = await withEvalCaseTimeout(
                        c.id,
                        caseTimeoutMs,
                        async () => {
                            let collected: {
                                runLogs: string[];
                                streamError?: string;
                            };
                            let sqlFirst: string | undefined;
                            let sqlFinal: string | undefined;
                            let sanitizerFixes: string[] | undefined;
                            let caseLlmUsage: ReturnType<typeof parseLlmUsageFromSystemLogs>;

                            if (evalPipeline === "baseline_direct") {
                                if (!baselinePrepared || !baselineEngine) {
                                    throw new Error(
                                        "Baseline context not prepared."
                                    );
                                }
                                const baseline = await generateBaselineDirectSql(
                                    baselineEngine,
                                    {
                                        question: c.question,
                                        metadataBrief:
                                            baselinePrepared.metadataBrief,
                                        fileDescItems:
                                            baselinePrepared.fileDescItems
                                    }
                                );
                                collected = { runLogs: baseline.systemLogs };
                                caseLlmUsage =
                                    baseline.llm_usage ||
                                    parseLlmUsageFromSystemLogs(
                                        baseline.systemLogs
                                    );
                                sqlFinal = baseline.sql?.trim();
                                sqlFirst = sqlFinal;
                                if (baseline.rejectReason && !sqlFinal) {
                                    collected.streamError =
                                        baseline.rejectReason;
                                }
                            } else {
                                const caseStream = await agent.stream(
                                    c.question,
                                    {
                                        geoEvalCaptureExecutedSql: true,
                                        geoEvalDisableDeterministicRenderer:
                                            evalPipeline ===
                                            "agent_full_planner"
                                    }
                                );
                                collected = await collectStream(caseStream);
                                caseLlmUsage = parseLlmUsageFromSystemLogs(
                                    collected.runLogs
                                );
                                const input = agent.lastEvalChainInput;
                                sqlFirst = input?.evalCapturedExecutedSqlFirst?.trim();
                                sqlFinal = input?.evalCapturedExecutedSql?.trim();
                                sanitizerFixes =
                                    input?.evalCapturedSanitizerFixes;
                            }

                            return {
                                collected,
                                sqlFirst,
                                sqlFinal,
                                sanitizerFixes,
                                caseLlmUsage
                            };
                        }
                    );

                    const {
                        collected,
                        sqlFirst,
                        sqlFinal,
                        sanitizerFixes,
                        caseLlmUsage
                    } = llmPhase;

                    const caseFinishedAt = new Date().toISOString();
                    const caseWallMs = performance.now() - caseT0;
                    for (const line of collected.runLogs) {
                        snapLog(`  [System] ${line}`, "info");
                    }
                    if (collected.streamError) {
                        snapLog(
                            `  Stream error: ${collected.streamError}`,
                            "warn"
                        );
                    }

                    const saFirst = isReadableSql(sqlFirst);
                    const saFinal = isReadableSql(sqlFinal);
                    const execFirst = await tryExecuteSql(sqlFirst);
                    const execFinal = await tryExecuteSql(sqlFinal);
                    const repairGain =
                        !execFirst.ok && execFinal.ok && !!sqlFinal;

                    let goldRows: Record<string, unknown>[] = [];
                    let goldExecOk = false;
                    let goldErr = "";
                    try {
                        goldRows = (await runPostgisQuery(
                            c.gold_sql
                        )) as Record<string, unknown>[];
                        goldExecOk = true;
                    } catch (e) {
                        goldErr = String(e);
                    }

                    const goldFp = goldExecOk
                        ? rowsToComparableSignature(goldRows)
                        : "";
                    let modelFp = "";
                    let modelRowCount = 0;
                    let resultMatch = false;
                    let matchMode: EvalCaseRow["layer_b"]["match_mode"] =
                        "none";

                    if (execFinal.ok && execFinal.rows) {
                        modelFp = rowsToComparableSignature(execFinal.rows);
                        modelRowCount = execFinal.rows.length;
                        if (goldExecOk) {
                            const compared = compareQueryResults(
                                goldRows,
                                execFinal.rows
                            );
                            resultMatch = compared.match;
                            matchMode = compared.mode;
                        }
                    }

                    const errFirst = execFirst.error || collected.streamError;
                    const errFinal = !sqlFinal
                        ? "No final executed GeoSQL captured"
                        : execFinal.error;

                    const row: EvalCaseRow = {
                        case_id: c.id,
                        question: c.question,
                        tags: c.tags,
                        gold_sql: c.gold_sql,
                        model_sql_first: sqlFirst,
                        model_sql_final: sqlFinal,
                        sanitizer_fixes: sanitizerFixes,
                        layer_a: {
                            syntax_accuracy_first: saFirst,
                            syntax_accuracy_final: saFinal,
                            execution_pass_first: execFirst.ok,
                            execution_pass_final: execFinal.ok,
                            error_bucket_first: execFirst.ok
                                ? "none"
                                : classifySqlError(errFirst || ""),
                            error_bucket_final: execFinal.ok
                                ? "none"
                                : sqlFinal
                                ? classifySqlError(errFinal || "")
                                : "routing",
                            repair_gain: repairGain
                        },
                        layer_b: {
                            result_match: resultMatch,
                            match_mode: matchMode,
                            gold_fingerprint: goldFp,
                            model_fingerprint: modelFp,
                            gold_row_count: goldRows.length,
                            model_row_count: modelRowCount
                        },
                        error_message:
                            resultMatch || execFinal.ok
                                ? undefined
                                : errFinal || errFirst || goldErr,
                        system_logs: collected.runLogs,
                        timing: {
                            wall_ms: caseWallMs,
                            started_at: caseStartedAt,
                            finished_at: caseFinishedAt
                        },
                        llm_usage: caseLlmUsage.call_count
                            ? caseLlmUsage
                            : undefined
                    };
                    caseRows.push(row);

                    if (resultMatch) {
                        snapLog(
                            matchMode === "scalar"
                                ? "  ✓ Layer B pass (scalar)"
                                : "  ✓ Layer B pass (row set)",
                            "ok"
                        );
                    } else if (!sqlFinal) {
                        snapLog("  ✗ No final SQL captured", "error");
                    } else if (!execFinal.ok) {
                        snapLog(
                            `  ✗ Layer A final exec failed (${row.layer_a.error_bucket_final})`,
                            "error"
                        );
                    } else {
                        snapLog(
                            matchMode === "scalar"
                                ? "  ✗ Layer B scalar mismatch"
                                : "  ✗ Layer B row set mismatch",
                            "warn"
                        );
                    }
                    snapLog(
                        `  Layer A: SA ${saFirst ? "✓" : "✗"}/${
                            saFinal ? "✓" : "✗"
                        } · EPR ${execFirst.ok ? "✓" : "✗"}/${
                            execFinal.ok ? "✓" : "✗"
                        }${repairGain ? " · repair+" : ""} · ${formatDurationMs(
                            caseWallMs
                        )}${
                            caseLlmUsage.call_count
                                ? ` · LLM ${caseLlmUsage.total_tokens} tok (${caseLlmUsage.call_count} calls)`
                                : ""
                        }`,
                        "info"
                    );
                } catch (caseErr) {
                    const caseWallMs = performance.now() - caseT0;
                    const errText = String(caseErr);
                    const timedOut = errText.includes("timed out");
                    snapLog(
                        timedOut
                            ? `  ✗ Case timeout — ${errText} · ${formatDurationMs(
                                  caseWallMs
                              )}`
                            : `  ✗ Case error: ${errText} · ${formatDurationMs(
                                  caseWallMs
                              )}`,
                        timedOut ? "warn" : "error"
                    );
                    caseRows.push({
                        case_id: c.id,
                        question: c.question,
                        tags: c.tags,
                        gold_sql: c.gold_sql,
                        layer_a: {
                            syntax_accuracy_first: false,
                            syntax_accuracy_final: false,
                            execution_pass_first: false,
                            execution_pass_final: false,
                            error_bucket_first: "runtime",
                            error_bucket_final: "runtime",
                            repair_gain: false
                        },
                        layer_b: {
                            result_match: false,
                            match_mode: "none",
                            gold_fingerprint: "",
                            model_fingerprint: "",
                            gold_row_count: 0,
                            model_row_count: 0
                        },
                        error_message: String(caseErr),
                        timing: {
                            wall_ms: caseWallMs,
                            started_at: caseStartedAt,
                            finished_at: new Date().toISOString()
                        }
                    });
                }

                const partialReport = buildReport({
                    slug: targetSlug,
                    magdaDatasetId: targetDatasetId,
                    datasetTitle: targetDataset.title,
                    caseFile: caseFileForSlug(targetSlug),
                    appName,
                    cases: caseRows,
                    harnessLog: harnessLogSnapshot,
                    llmProvider,
                    openAiModel:
                        llmProvider === "openai"
                            ? openAiModel.trim()
                            : undefined,
                    evalPipeline
                });
                reportsBySlug[targetSlug] = partialReport;
                persistCheckpointState({
                    runId,
                    mode,
                    startedAt:
                        checkpoint?.startedAt || new Date().toISOString(),
                    updatedAt: new Date().toISOString(),
                    slugs: mode === "all" ? [...EVAL_SLUG_ORDER] : [targetSlug],
                    completedSlugs,
                    currentSlug: targetSlug,
                    currentCaseIndex: i + 1,
                    reports: reportsBySlug
                });
            }

            snapLog("Phase 3/3: aggregate Layer A / Layer B", "info");
            const datasetRunFinishedAt = new Date().toISOString();
            const casesWallMsSum = caseRows.reduce(
                (sum, row) => sum + (row.timing?.wall_ms || 0),
                0
            );
            const report = buildReport({
                slug: targetSlug,
                magdaDatasetId: targetDatasetId,
                datasetTitle: targetDataset.title,
                caseFile: caseFileForSlug(targetSlug),
                appName,
                cases: caseRows,
                harnessLog: harnessLogSnapshot,
                llmProvider,
                openAiModel:
                    llmProvider === "openai" ? openAiModel.trim() : undefined,
                evalPipeline,
                runTiming: {
                    started_at: datasetRunStartedAt,
                    finished_at: datasetRunFinishedAt,
                    wall_ms: performance.now() - datasetRunT0,
                    warmup_wall_ms: warmupWallMs,
                    cases_wall_ms_sum: casesWallMsSum
                }
            });
            reportsBySlug[targetSlug] = report;

            const s = report.summary;
            const tok = s.llm_usage?.total_tokens;
            snapLog(
                `Done ${targetSlug} — Layer B ${(
                    s.layer_b.result_accuracy * 100
                ).toFixed(1)}% (${s.layer_b.result_match_count}/${
                    s.n
                }) · ${formatDurationMs(report.meta.run_timing?.wall_ms || 0)}${
                    tok != null
                        ? ` · LLM ${tok} tokens (${
                              s.llm_usage?.call_count || 0
                          } usage lines)`
                        : ""
                }`,
                "ok"
            );
            return report;
        },
        [
            appName,
            appendLog,
            checkpoint?.startedAt,
            persistCheckpointState,
            llmProvider,
            openAiModel,
            evalPipeline
        ]
    );

    const ensureAgent = useCallback(
        async (
            initialDataset: ParsedDataset,
            datasetId: string
        ): Promise<AgentChain> => {
            if (agentRef.current) {
                return agentRef.current;
            }
            const fakeLocation = {
                pathname: `/dataset/${datasetId}`,
                search: "",
                hash: "",
                state: undefined
            } as any;
            const providerLabel =
                llmProvider === "openai" ? "OpenAI API" : "WebLLM (local)";
            appendLog(
                `Creating AgentChain and initializing ${providerLabel}…`,
                "info"
            );
            const progressTag = llmProvider === "openai" ? "OpenAI" : "WebLLM";
            const agent = await AgentChain.createForEval(
                appName || "Magda",
                fakeLocation,
                history,
                initialDataset,
                undefined,
                (r) => {
                    const t =
                        r.progress >= 1
                            ? `${progressTag} ready`
                            : r.text || "Loading…";
                    setLlmProgress(t);
                    if (r.progress < 1 && r.text) {
                        appendLog(`[${progressTag}] ${r.text}`, "info");
                    }
                },
                (e) =>
                    reportError(`GeoSQL eval: ${providerLabel} ${e}`, {
                        duration: 8000
                    }),
                llmProvider === "openai"
                    ? {
                          llmProvider: "openai",
                          openAi: {
                              apiKey:
                                  openAiApiKey.trim() || openAiDefaults.apiKey,
                              baseUrl: openAiBaseUrl.trim(),
                              model: openAiModel.trim()
                          }
                      }
                    : { llmProvider: "webllm" }
            );
            agentRef.current = agent;
            await agent.initialize((e) => {
                throw e;
            });
            appendLog(`${providerLabel} initialization complete`, "ok");
            return agent;
        },
        [
            appName,
            history,
            appendLog,
            llmProvider,
            openAiApiKey,
            openAiBaseUrl,
            openAiModel,
            openAiDefaults.apiKey,
            evalPipeline
        ]
    );

    const runEvalCore = useCallback(
        async (mode: EvalRunMode, resumeCp?: GeoSqlEvalCheckpoint | null) => {
            setRunError(null);
            setAllReports(null);
            if (!resumeCp) {
                setLastReport(null);
                setHarnessLog([]);
            }
            cancelRef.current = false;
            if (!resumeCp) {
                agentRef.current = null;
            }

            if (!config.enableChatbot || !config.enablePglitePostgis) {
                setRunError(
                    "Server must enable enableChatbot and enablePglitePostgis."
                );
                return;
            }

            if (llmProvider === "openai") {
                const key = openAiApiKey.trim() || openAiDefaults.apiKey || "";
                const base = openAiBaseUrl.trim() || openAiDefaults.baseUrl;
                const needsKey = base.includes("api.openai.com");
                if (needsKey && !key) {
                    setRunError(
                        "OpenAI: API key required for api.openai.com (field below or REACT_APP_OPENAI_API_KEY in .env.local)."
                    );
                    return;
                }
                persistOpenAiEvalSettings(
                    openAiApiKey,
                    openAiBaseUrl,
                    openAiModel
                );
            }
            localStorage.setItem(LS_LLM_PROVIDER, llmProvider);
            localStorage.setItem(LS_EVAL_PIPELINE, evalPipeline);

            const runId = resumeCp?.runId || newRunId();
            const startedAt = resumeCp?.startedAt || new Date().toISOString();
            const reportsBySlug: Record<string, GeoSqlEvalReport> = {
                ...(resumeCp?.reports || {})
            };
            const completedSlugs = [...(resumeCp?.completedSlugs || [])];
            const harnessLogSnapshot: GeoSqlEvalReport["harness_log"] = [];

            const slugsToRun =
                mode === "all"
                    ? EVAL_SLUG_ORDER.filter((s) => manifest?.[s])
                    : slug
                    ? [slug]
                    : [];

            if (!slugsToRun.length) {
                setRunError("No dataset slug selected.");
                return;
            }

            setRunning(true);
            setRunMode(mode);
            const evalRunT0 = performance.now();

            try {
                const pipelineLabel =
                    evalPipeline === "baseline_direct"
                        ? "baseline direct (profile + question → SQL)"
                        : evalPipeline === "agent_full_planner"
                        ? "AgentChain planner-only (no deterministic SQL)"
                        : "AgentChain deterministic (production default)";
                appendLog(
                    resumeCp
                        ? `=== Resuming eval (${mode}) run ${runId} — ${pipelineLabel} ===`
                        : `=== Starting eval (${mode}) — ${pipelineLabel} ===`,
                    "info"
                );
                if (mode === "all") {
                    appendLog(
                        `All datasets (${slugsToRun.length}): ${slugsToRun.join(
                            ", "
                        )}`,
                        "info"
                    );
                }

                let agent: AgentChain | null = null;

                for (const targetSlug of slugsToRun) {
                    if (cancelRef.current) break;
                    if (completedSlugs.includes(targetSlug)) {
                        appendLog(
                            `Skipping completed dataset: ${targetSlug}`,
                            "info"
                        );
                        continue;
                    }

                    const overrides = loadIdOverrides();
                    const targetDatasetId = (
                        overrides[targetSlug] ||
                        manifest?.[targetSlug]?.magda_dataset_id ||
                        ""
                    ).trim();
                    if (!targetDatasetId) {
                        throw new Error(
                            `Missing Magda dataset id for slug "${targetSlug}".`
                        );
                    }

                    if (mode === "single") {
                        setSlug(targetSlug);
                        setDatasetIdInput(targetDatasetId);
                    }

                    appendLog(
                        `Loading dataset ${targetSlug} (${targetDatasetId})…`,
                        "info"
                    );
                    dispatch(fetchDatasetFromRegistry(targetDatasetId) as any);
                    const targetDataset = await fetchParsedDataset(
                        targetDatasetId
                    );
                    const targetCases = await fetchCasesForSlug(targetSlug);
                    appendLog(
                        `Loaded ${targetCases.length} case(s) for ${targetSlug}`,
                        "info"
                    );

                    if (!agent) {
                        agent = await ensureAgent(
                            targetDataset,
                            targetDatasetId
                        );
                    }

                    const resumeThisSlug =
                        resumeCp?.currentSlug === targetSlug &&
                        resumeCp.currentCaseIndex > 0;
                    const startCaseIndex = resumeThisSlug
                        ? resumeCp!.currentCaseIndex
                        : 0;
                    const initialCaseRows = resumeThisSlug
                        ? [...(reportsBySlug[targetSlug]?.cases || [])]
                        : [];

                    if (resumeThisSlug) {
                        appendLog(
                            `Resuming ${targetSlug} from case ${
                                startCaseIndex + 1
                            }`,
                            "info"
                        );
                    }

                    const report = await runOneDataset({
                        targetSlug,
                        targetCases,
                        targetDataset,
                        targetDatasetId,
                        agent,
                        mode,
                        runId,
                        startCaseIndex,
                        initialCaseRows,
                        completedSlugs,
                        reportsBySlug,
                        harnessLogSnapshot
                    });

                    if (!report || cancelRef.current) {
                        appendLog(
                            "Run stopped — partial results saved to checkpoint (localStorage). Use Resume to continue.",
                            "warn"
                        );
                        break;
                    }

                    completedSlugs.push(targetSlug);
                    persistCheckpointState({
                        runId,
                        mode,
                        startedAt,
                        updatedAt: new Date().toISOString(),
                        slugs: [...slugsToRun],
                        completedSlugs,
                        currentSlug: null,
                        currentCaseIndex: 0,
                        reports: reportsBySlug
                    });

                    if (mode === "single") {
                        setLastReport(report);
                        setCases(targetCases);
                    }
                }

                const finishedReports = slugsToRun
                    .map((s) => reportsBySlug[s])
                    .filter(Boolean) as GeoSqlEvalReport[];

                if (mode === "all" && finishedReports.length) {
                    setAllReports(finishedReports);
                    setLastReport(finishedReports[finishedReports.length - 1]);
                    const totalN = finishedReports.reduce(
                        (a, r) => a + r.summary.n,
                        0
                    );
                    const totalMatch = finishedReports.reduce(
                        (a, r) => a + r.summary.layer_b.result_match_count,
                        0
                    );
                    const totalWallMs = finishedReports.reduce(
                        (a, r) => a + (r.meta.run_timing?.wall_ms || 0),
                        0
                    );
                    const totalTokens = finishedReports.reduce(
                        (a, r) =>
                            a + (r.meta.llm_usage_total?.total_tokens || 0),
                        0
                    );
                    appendLog(
                        `All datasets finished — Layer B ${totalMatch}/${totalN} cases matched overall · ${formatDurationMs(
                            totalWallMs
                        )}${totalTokens ? ` · LLM ${totalTokens} tokens` : ""}`,
                        "ok"
                    );
                }

                if (
                    !cancelRef.current &&
                    completedSlugs.length === slugsToRun.length
                ) {
                    clearEvalCheckpoint();
                    setCheckpoint(null);
                    appendLog(
                        `Checkpoint cleared (run completed). Wall time ${formatDurationMs(
                            performance.now() - evalRunT0
                        )}.`,
                        "ok"
                    );
                }
            } catch (e) {
                appendLog(`Eval aborted: ${e}`, "error");
                setRunError(String(e));
                appendLog(
                    "Partial progress may be in checkpoint — use Resume after fixing the issue.",
                    "warn"
                );
            } finally {
                setRunning(false);
                setRunMode(null);
                setLlmProgress(null);
            }
        },
        [
            slug,
            manifest,
            dispatch,
            appendLog,
            ensureAgent,
            runOneDataset,
            persistCheckpointState,
            evalPipeline,
            llmProvider,
            openAiApiKey,
            openAiBaseUrl,
            openAiModel,
            openAiDefaults.apiKey
        ]
    );

    const runEval = useCallback(() => runEvalCore("single", null), [
        runEvalCore
    ]);

    const runAllEval = useCallback(() => runEvalCore("all", null), [
        runEvalCore
    ]);

    const resumeEval = useCallback(() => {
        const cp = loadEvalCheckpoint();
        if (!cp) return;
        setCheckpoint(cp);
        if (cp.currentSlug) setSlug(cp.currentSlug);
        void runEvalCore(cp.mode, cp);
    }, [runEvalCore]);

    const passCount = lastReport?.summary.layer_b.result_match_count ?? 0;
    const totalCount = lastReport?.summary.n ?? 0;

    const logLevelColor = (level: HarnessLogLine["level"]) => {
        switch (level) {
            case "error":
                return "#c0392b";
            case "warn":
                return "#d68910";
            case "ok":
                return "#1e8449";
            default:
                return "#333";
        }
    };

    const canRun =
        config.enableChatbot &&
        config.enablePglitePostgis &&
        !running &&
        manifest;

    return (
        <div className="container" style={{ padding: "24px 16px 48px" }}>
            <h2>Magda GeoSQL evaluation (full pipeline)</h2>
            <p style={{ maxWidth: 920 }}>
                <strong>Layer A</strong> — syntax accuracy (SA) and execution
                pass rate (EPR, first/final); <strong>Layer B</strong> —
                semantic match vs <code>gold_sql</code>. Uses production path{" "}
                <code>AgentChain</code> → <code>spatial_sql</code> →{" "}
                <code>queryGeoDataset</code>.
            </p>
            <p style={{ maxWidth: 920, fontSize: 13, color: "#555" }}>
                <strong>Resilience:</strong> progress is checkpointed to{" "}
                <code>localStorage</code> after each case (resume after refresh
                or crash). Closing the tab while running triggers a browser
                warning. Use <strong>Cancel</strong> to stop gracefully; partial
                reports remain downloadable.
            </p>

            {manifestError ? (
                <Message type="error" showIcon>
                    {manifestError}
                </Message>
            ) : null}

            {!config.enableChatbot || !config.enablePglitePostgis ? (
                <Message type="warning" showIcon>
                    This deployment does not have enableChatbot or
                    enablePglitePostgis enabled.
                </Message>
            ) : null}

            {checkpoint && !running ? (
                <Message type="info" showIcon style={{ marginTop: 12 }}>
                    Saved checkpoint ({checkpoint.mode}):{" "}
                    {checkpoint.completedSlugs.length} /{" "}
                    {checkpoint.slugs.length} dataset(s) done
                    {checkpoint.currentSlug
                        ? ` — resume at ${checkpoint.currentSlug} case ${
                              checkpoint.currentCaseIndex + 1
                          }`
                        : ""}
                    .
                    <ButtonToolbar style={{ marginTop: 8 }}>
                        <Button
                            size="sm"
                            appearance="primary"
                            onClick={() => void resumeEval()}
                        >
                            Resume
                        </Button>
                        <Button size="sm" onClick={discardCheckpoint}>
                            Discard checkpoint
                        </Button>
                    </ButtonToolbar>
                </Message>
            ) : null}

            <Panel bordered style={{ marginTop: 16 }}>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 16 }}>
                    <div style={{ minWidth: 260 }}>
                        <div style={{ marginBottom: 8 }}>Eval dataset</div>
                        <SelectPicker
                            data={pickerData}
                            value={slug}
                            onChange={(v) => setSlug(v as string)}
                            style={{ width: "100%" }}
                            searchable={false}
                            cleanable={false}
                            disabled={!pickerData.length || running}
                        />
                    </div>
                    <div style={{ flex: 1, minWidth: 280 }}>
                        <div style={{ marginBottom: 8 }}>
                            Magda dataset identifier
                        </div>
                        <Input
                            value={datasetIdInput}
                            onChange={setDatasetIdInput}
                            onBlur={persistDatasetId}
                            disabled={running}
                            placeholder="Same as /dataset/&lt;id&gt;"
                        />
                        {effectiveDatasetId ? (
                            <div style={{ marginTop: 8 }}>
                                <Link
                                    to={`/dataset/${effectiveDatasetId}`}
                                    target="_blank"
                                    rel="noreferrer"
                                >
                                    Open dataset page
                                </Link>
                            </div>
                        ) : null}
                    </div>
                </div>

                <div
                    style={{
                        marginTop: 20,
                        paddingTop: 16,
                        borderTop: "1px solid #e5e5e5"
                    }}
                >
                    <div style={{ marginBottom: 8, fontWeight: 600 }}>
                        LLM backend (eval only)
                    </div>
                    <div style={{ marginBottom: 16 }}>
                        <div style={{ marginBottom: 8, fontWeight: 600 }}>
                            Eval pipeline
                        </div>
                        <RadioGroup
                            name="evalPipeline"
                            value={evalPipeline}
                            onChange={(v) => {
                                const mode = v as EvalPipelineMode;
                                setEvalPipeline(mode);
                                localStorage.setItem(LS_EVAL_PIPELINE, mode);
                                agentRef.current = null;
                            }}
                            disabled={running}
                        >
                            <Radio value="agent">
                                Agent — deterministic (task-spec + AST SQL
                                renderer)
                            </Radio>
                            <Radio value="agent_full_planner">
                                Agent — planner only (task-spec, every case uses
                                Planner LLM)
                            </Radio>
                            <Radio value="baseline_direct">
                                Baseline direct — dataset profile + question →
                                one LLM SQL (no routing / task-spec)
                            </Radio>
                        </RadioGroup>
                    </div>
                    <RadioGroup
                        name="evalLlmProvider"
                        value={llmProvider}
                        onChange={(v) => {
                            setLlmProvider(v as EvalLlmProvider);
                            agentRef.current = null;
                        }}
                        disabled={running}
                    >
                        <Radio value="webllm">
                            WebLLM — local browser model (Chrome extension)
                        </Radio>
                        <Radio value="openai">
                            OpenAI API — Chat Completions (no extension)
                        </Radio>
                    </RadioGroup>
                    {llmProvider === "openai" ? (
                        <div
                            style={{
                                marginTop: 12,
                                display: "grid",
                                gap: 10,
                                maxWidth: 640
                            }}
                        >
                            <div>
                                <div style={{ marginBottom: 4, fontSize: 13 }}>
                                    API key (stored in localStorage for this
                                    browser)
                                </div>
                                <Input
                                    type="password"
                                    value={openAiApiKey}
                                    onChange={setOpenAiApiKey}
                                    disabled={running}
                                    placeholder={
                                        openAiDefaults.apiKey
                                            ? "Using REACT_APP_OPENAI_API_KEY from env"
                                            : "sk-…"
                                    }
                                />
                            </div>
                            <div>
                                <div style={{ marginBottom: 4, fontSize: 13 }}>
                                    Base URL
                                </div>
                                <Input
                                    value={openAiBaseUrl}
                                    onChange={setOpenAiBaseUrl}
                                    disabled={running}
                                    placeholder={openAiDefaults.baseUrl}
                                />
                            </div>
                            <div>
                                <div style={{ marginBottom: 4, fontSize: 13 }}>
                                    Model
                                </div>
                                <Input
                                    value={openAiModel}
                                    onChange={setOpenAiModel}
                                    disabled={running}
                                    placeholder={openAiDefaults.model}
                                />
                            </div>
                            <p
                                style={{
                                    fontSize: 12,
                                    color: "#666",
                                    margin: 0
                                }}
                            >
                                Env overrides:{" "}
                                <code>REACT_APP_OPENAI_API_KEY</code>,{" "}
                                <code>REACT_APP_OPENAI_BASE_URL</code>,{" "}
                                <code>REACT_APP_OPENAI_MODEL</code>. Prefer a
                                backend proxy in production so the key is not in
                                the bundle.
                            </p>
                        </div>
                    ) : null}
                </div>

                {datasetIsFetching ? (
                    <Loader content="Loading dataset from registry…" />
                ) : null}
                {datasetFetchError ? (
                    <Message type="error" style={{ marginTop: 12 }} showIcon>
                        {typeof datasetFetchError === "object" &&
                        datasetFetchError &&
                        "detail" in datasetFetchError
                            ? String(
                                  (datasetFetchError as { detail?: string })
                                      .detail
                              )
                            : String(datasetFetchError)}
                    </Message>
                ) : null}
                {datasetReady ? (
                    <Message type="success" style={{ marginTop: 12 }} showIcon>
                        Loaded: {dataset?.title}
                    </Message>
                ) : effectiveDatasetId && !datasetIsFetching ? (
                    <Message type="info" style={{ marginTop: 12 }} showIcon>
                        Waiting for registry dataset…
                    </Message>
                ) : null}

                {casesError ? (
                    <Message type="error" style={{ marginTop: 12 }} showIcon>
                        {casesError}
                    </Message>
                ) : cases ? (
                    <Message type="info" style={{ marginTop: 12 }} showIcon>
                        {cases.length} case(s) loaded ({slug}).
                    </Message>
                ) : null}

                {running && runMode === "all" ? (
                    <Message type="info" style={{ marginTop: 12 }} showIcon>
                        Running all three datasets sequentially — do not close
                        this tab. Progress is saved after each case.
                    </Message>
                ) : null}

                {llmProgress ? (
                    <div style={{ marginTop: 8, color: "#666" }}>
                        {llmProgress}
                    </div>
                ) : null}

                {runError ? (
                    <Message type="error" style={{ marginTop: 12 }} showIcon>
                        {runError}
                    </Message>
                ) : null}

                <ButtonToolbar style={{ marginTop: 16 }}>
                    <Button
                        appearance="primary"
                        loading={running && runMode === "single"}
                        disabled={
                            running ||
                            !datasetReady ||
                            !cases?.length ||
                            !canRun
                        }
                        onClick={() => void runEval()}
                    >
                        Run current dataset
                    </Button>
                    <Button
                        appearance="ghost"
                        loading={running && runMode === "all"}
                        disabled={!canRun}
                        onClick={() => void runAllEval()}
                    >
                        Run all 3 datasets
                    </Button>
                    {running ? (
                        <Button color="red" onClick={cancelRun}>
                            Cancel
                        </Button>
                    ) : null}
                    <Button disabled={running} onClick={clearLogs}>
                        Clear log
                    </Button>
                    <Button
                        disabled={!lastReport}
                        onClick={() =>
                            lastReport && downloadJsonReport(lastReport)
                        }
                    >
                        Download JSON
                    </Button>
                    <Button
                        disabled={!lastReport}
                        onClick={() =>
                            lastReport && downloadCsvSummary(lastReport)
                        }
                    >
                        Download CSV summary
                    </Button>
                    <Button
                        disabled={!allReports?.length}
                        onClick={() =>
                            allReports && downloadCombinedJsonReport(allReports)
                        }
                    >
                        Download combined JSON
                    </Button>
                </ButtonToolbar>
            </Panel>

            <Panel
                header="Run log (harness + system logs)"
                bordered
                style={{ marginTop: 16 }}
            >
                <div
                    style={{
                        height: 320,
                        overflowY: "auto",
                        background: "#1e1e1e",
                        color: "#d4d4d4",
                        fontFamily:
                            "ui-monospace, SFMono-Regular, Menlo, monospace",
                        fontSize: 12,
                        lineHeight: 1.5,
                        padding: 12,
                        borderRadius: 4
                    }}
                >
                    {harnessLog.length === 0 ? (
                        <div style={{ color: "#888" }}>
                            Start a run to see phase progress here. Each case
                            includes AgentChain system logs.
                        </div>
                    ) : (
                        harnessLog.map((line, idx) => (
                            <div
                                key={`${line.at}-${idx}`}
                                style={{
                                    marginBottom: 4,
                                    color: logLevelColor(line.level)
                                }}
                            >
                                <span style={{ color: "#888" }}>
                                    {line.at.slice(11, 19)}
                                </span>{" "}
                                {line.message}
                            </div>
                        ))
                    )}
                    <div ref={logEndRef} />
                </div>
            </Panel>

            {allReports && allReports.length > 1 ? (
                <Panel
                    header="All-datasets summary"
                    bordered
                    style={{ marginTop: 16 }}
                >
                    <table className="table">
                        <thead>
                            <tr>
                                <th>Dataset</th>
                                <th>Cases</th>
                                <th>Layer B</th>
                                <th>EPR (final)</th>
                                <th>Run time</th>
                                <th>LLM tokens</th>
                            </tr>
                        </thead>
                        <tbody>
                            {allReports.map((r) => (
                                <tr key={r.meta.dataset_slug}>
                                    <td>
                                        <code>{r.meta.dataset_slug}</code>
                                        <div style={{ fontSize: 11 }}>
                                            {r.meta.dataset_title}
                                        </div>
                                    </td>
                                    <td>{r.summary.n}</td>
                                    <td>
                                        {r.summary.layer_b.result_match_count}/
                                        {r.summary.n} (
                                        {(
                                            r.summary.layer_b.result_accuracy *
                                            100
                                        ).toFixed(1)}
                                        %)
                                    </td>
                                    <td>
                                        {(
                                            r.summary.layer_a.epr_final * 100
                                        ).toFixed(1)}
                                        %
                                    </td>
                                    <td>
                                        {r.meta.run_timing
                                            ? formatDurationMs(
                                                  r.meta.run_timing.wall_ms
                                              )
                                            : "—"}
                                    </td>
                                    <td>
                                        {r.meta.llm_usage_total?.total_tokens ??
                                            "—"}
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </Panel>
            ) : null}

            {lastReport ? (
                <Panel
                    header={`Results — Layer B ${passCount} / ${totalCount} passed (${lastReport.meta.dataset_slug})`}
                    bordered
                    style={{ marginTop: 16 }}
                >
                    <div
                        style={{
                            display: "grid",
                            gridTemplateColumns:
                                "repeat(auto-fill, minmax(200px, 1fr))",
                            gap: 12,
                            marginBottom: 16,
                            fontSize: 13
                        }}
                    >
                        <div>
                            <strong>Layer A · SA (first)</strong>
                            <br />
                            {(
                                lastReport.summary.layer_a
                                    .syntax_accuracy_first * 100
                            ).toFixed(1)}
                            %
                        </div>
                        <div>
                            <strong>Layer A · SA (final)</strong>
                            <br />
                            {(
                                lastReport.summary.layer_a
                                    .syntax_accuracy_final * 100
                            ).toFixed(1)}
                            %
                        </div>
                        <div>
                            <strong>Layer A · EPR (first)</strong>
                            <br />
                            {(
                                lastReport.summary.layer_a.epr_first * 100
                            ).toFixed(1)}
                            %
                        </div>
                        <div>
                            <strong>Layer A · EPR (final)</strong>
                            <br />
                            {(
                                lastReport.summary.layer_a.epr_final * 100
                            ).toFixed(1)}
                            %
                        </div>
                        <div>
                            <strong>Repair gain</strong>
                            <br />
                            {lastReport.summary.layer_a.repair_gain_count}{" "}
                            case(s)
                        </div>
                        <div>
                            <strong>Layer B · result accuracy</strong>
                            <br />
                            {(
                                lastReport.summary.layer_b.result_accuracy * 100
                            ).toFixed(1)}
                            %
                        </div>
                        {lastReport.meta.run_timing ? (
                            <div>
                                <strong>Run time</strong>
                                <br />
                                {formatDurationMs(
                                    lastReport.meta.run_timing.wall_ms
                                )}
                                {lastReport.meta.run_timing.warmup_wall_ms !=
                                null ? (
                                    <>
                                        <br />
                                        <span style={{ color: "#666" }}>
                                            warmup{" "}
                                            {formatDurationMs(
                                                lastReport.meta.run_timing
                                                    .warmup_wall_ms
                                            )}
                                        </span>
                                    </>
                                ) : null}
                            </div>
                        ) : null}
                        {lastReport.meta.llm_usage_total ? (
                            <div>
                                <strong>LLM tokens</strong>
                                <br />
                                {lastReport.meta.llm_usage_total.total_tokens} (
                                {lastReport.meta.llm_usage_total.call_count}{" "}
                                calls)
                            </div>
                        ) : null}
                    </div>

                    <div style={{ overflowX: "auto" }}>
                        <table className="table">
                            <thead>
                                <tr>
                                    <th>Case</th>
                                    <th>Layer B</th>
                                    <th>EPR first/final</th>
                                    <th>Time</th>
                                    <th>Tokens</th>
                                    <th>Notes</th>
                                </tr>
                            </thead>
                            <tbody>
                                {lastReport.cases.map((r) => (
                                    <tr key={r.case_id}>
                                        <td>
                                            <code>{r.case_id}</code>
                                            <div
                                                style={{
                                                    fontSize: 11,
                                                    color: "#666",
                                                    maxWidth: 360
                                                }}
                                            >
                                                {r.question}
                                            </div>
                                        </td>
                                        <td>
                                            {r.layer_b.result_match ? "✓" : "✗"}
                                        </td>
                                        <td style={{ fontSize: 12 }}>
                                            {r.layer_a.execution_pass_first
                                                ? "✓"
                                                : "✗"}
                                            /
                                            {r.layer_a.execution_pass_final
                                                ? "✓"
                                                : "✗"}
                                        </td>
                                        <td style={{ fontSize: 12 }}>
                                            {r.timing
                                                ? formatDurationMs(
                                                      r.timing.wall_ms
                                                  )
                                                : "—"}
                                        </td>
                                        <td style={{ fontSize: 12 }}>
                                            {r.llm_usage?.total_tokens ?? "—"}
                                        </td>
                                        <td style={{ fontSize: 12 }}>
                                            {r.error_message ? (
                                                <span style={{ color: "#c00" }}>
                                                    {r.error_message.slice(
                                                        0,
                                                        120
                                                    )}
                                                </span>
                                            ) : r.layer_b.result_match ? (
                                                "Match"
                                            ) : (
                                                <details>
                                                    <summary>Model SQL</summary>
                                                    <pre
                                                        style={{
                                                            whiteSpace:
                                                                "pre-wrap",
                                                            maxHeight: 160,
                                                            overflow: "auto",
                                                            fontSize: 11
                                                        }}
                                                    >
                                                        {r.model_sql_final}
                                                    </pre>
                                                </details>
                                            )}
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                </Panel>
            ) : null}
        </div>
    );
};

const GeoSqlEvalRunnerPage: React.FC = () => (
    <MagdaNamespacesConsumer ns={["global"]}>
        {(translate) => (
            <GeoSqlEvalRunnerInner appName={translate(["appName", "Magda"])} />
        )}
    </MagdaNamespacesConsumer>
);

export default GeoSqlEvalRunnerPage;
