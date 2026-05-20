import React, {
    useCallback,
    useEffect,
    useMemo,
    useRef,
    useState
} from "react";
import { Link, useHistory } from "react-router-dom";
import { useDispatch, useSelector } from "react-redux";
import { Button, ButtonToolbar, Input, Loader, Message, Panel } from "rsuite";
import SelectPicker from "rsuite/SelectPicker";
import MagdaNamespacesConsumer from "Components/i18n/MagdaNamespacesConsumer";
import AgentChain from "./AgentChain";
import { fetchDatasetFromRegistry } from "actions/recordActions";
import { StateType } from "reducers/reducer";
import { ParsedDataset } from "helpers/record";
import { config } from "config";
import { runPostgisQuery } from "libs/pglitePostgis";
import {
    buildReport,
    classifySqlError,
    downloadCsvSummary,
    downloadJsonReport,
    EvalCaseRow,
    GeoSqlEvalReport,
    compareQueryResults,
    isReadableSql,
    rowsToComparableSignature
} from "helpers/geoSqlEvalReport";
import {
    ChatEventMessage,
    EVENT_TYPE_ERROR,
    EVENT_TYPE_RUN_LOG
} from "./Messaging";
import reportError from "helpers/reportError";

const LS_DATASET_IDS = "magdaGeoSqlEvalDatasetIds";

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
    const [lastReport, setLastReport] = useState<GeoSqlEvalReport | null>(null);
    const [harnessLog, setHarnessLog] = useState<HarnessLogLine[]>([]);
    const agentRef = useRef<AgentChain | null>(null);
    const logEndRef = useRef<HTMLDivElement | null>(null);

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
                        `无法加载 /magda-eval/manifest.json。请先执行 yarn sync-magda-eval。详情：${e}`
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

    const runEval = useCallback(async () => {
        setRunError(null);
        setLastReport(null);
        setHarnessLog([]);
        if (!config.enableChatbot || !config.enablePglitePostgis) {
            setRunError(
                "需要开启服务端配置 enableChatbot 与 enablePglitePostgis。"
            );
            return;
        }
        if (!effectiveDatasetId) {
            setRunError("请填写 Magda 数据集 identifier。");
            return;
        }
        if (!datasetReady || !dataset) {
            setRunError("数据集尚未加载完成或 identifier 不匹配。");
            return;
        }
        if (!cases?.length || !slug) {
            setRunError("没有可用的评测用例（JSONL）。");
            return;
        }

        appendLog("=== 开始评测（生产 AgentChain 全链路）===", "info");
        appendLog(`数据集 slug: ${slug}`, "info");
        appendLog(`Magda dataset id: ${effectiveDatasetId}`, "info");
        appendLog(`用例数: ${cases.length}`, "info");

        const fakeLocation = {
            pathname: `/dataset/${effectiveDatasetId}`,
            search: "",
            hash: "",
            state: undefined
        } as any;

        appendLog("创建 AgentChain 并初始化 WebLLM…", "info");
        const agent = AgentChain.create(
            appName || "Magda",
            fakeLocation,
            history,
            dataset,
            undefined,
            (r) => {
                const t =
                    r.progress >= 1 ? "WebLLM 就绪" : r.text || "加载模型…";
                setLlmProgress(t);
                if (r.progress < 1 && r.text) {
                    appendLog(`[WebLLM] ${r.text}`, "info");
                }
            },
            (e) => reportError(`GeoSQL eval: WebLLM ${e}`, { duration: 8000 })
        );
        agentRef.current = agent;
        agent.setNavLocation(fakeLocation);
        agent.setDataset(dataset);

        try {
            await agent.initialize((e) => {
                throw e;
            });
        } catch (e) {
            appendLog(`WebLLM 初始化失败: ${e}`, "error");
            setRunError(`WebLLM 初始化失败：${e}`);
            return;
        }
        appendLog("WebLLM 初始化完成", "ok");

        setRunning(true);
        const caseRows: EvalCaseRow[] = [];
        const harnessLogSnapshot: GeoSqlEvalReport["harness_log"] = [];

        const snapLog = (
            message: string,
            level: HarnessLogLine["level"] = "info"
        ) => {
            const at = new Date().toISOString();
            harnessLogSnapshot.push({ at, level, message });
            appendLog(message, level);
        };

        try {
            snapLog(
                "阶段 1/3：warmupOnly（profile + 空间导入，跳过 LLM）",
                "info"
            );
            agent.clearDatasetProfileCache();
            const warmupStream = await agent.stream("warmup", {
                warmupOnly: true
            });
            const warmupCollected = await collectStream(warmupStream);
            for (const line of warmupCollected.runLogs) {
                snapLog(`[System] ${line}`, "info");
            }
            if (warmupCollected.streamError) {
                throw new Error(warmupCollected.streamError);
            }

            const spatialItems =
                agent.keyContextData.datasetProfile?.spatial?.items || [];
            if (!spatialItems.length) {
                throw new Error(
                    "当前数据集无空间分发或 profile 未导入空间数据。"
                );
            }
            snapLog(
                `Warmup 完成：${spatialItems.length} 个空间 profile 项`,
                "ok"
            );

            snapLog(
                "阶段 2/3：逐题 stream（spatial_sql → plan → execute → 捕获最终 SQL）",
                "info"
            );

            for (let i = 0; i < cases.length; i++) {
                const c = cases[i];
                snapLog(
                    `[${i + 1}/${cases.length}] ${
                        c.id
                    } — 提问: ${c.question.slice(0, 80)}${
                        c.question.length > 80 ? "…" : ""
                    }`,
                    "info"
                );

                if (c.dataset_slug !== slug) {
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
                        error_message: `dataset_slug 不匹配（期望 ${slug}）`
                    });
                    snapLog(`  ✗ slug 不匹配，跳过`, "warn");
                    continue;
                }

                const caseStream = await agent.stream(c.question, {
                    geoEvalCaptureExecutedSql: true
                });
                const collected = await collectStream(caseStream);
                for (const line of collected.runLogs) {
                    snapLog(`  [System] ${line}`, "info");
                }
                if (collected.streamError) {
                    snapLog(`  流错误: ${collected.streamError}`, "warn");
                }

                const input = agent.lastEvalChainInput;
                const sqlFirst = input?.evalCapturedExecutedSqlFirst?.trim();
                const sqlFinal = input?.evalCapturedExecutedSql?.trim();
                const sanitizerFixes = input?.evalCapturedSanitizerFixes;

                const saFirst = isReadableSql(sqlFirst);
                const saFinal = isReadableSql(sqlFinal);

                const execFirst = await tryExecuteSql(sqlFirst);
                const execFinal = await tryExecuteSql(sqlFinal);

                const repairGain = !execFirst.ok && execFinal.ok && !!sqlFinal;

                let goldRows: Record<string, unknown>[] = [];
                let goldExecOk = false;
                let goldErr = "";
                try {
                    goldRows = (await runPostgisQuery(c.gold_sql)) as Record<
                        string,
                        unknown
                    >[];
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
                let matchMode: EvalCaseRow["layer_b"]["match_mode"] = "none";

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
                    ? "未捕获最终执行的 GeoSQL"
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
                    system_logs: collected.runLogs
                };
                caseRows.push(row);

                if (resultMatch) {
                    snapLog(
                        matchMode === "scalar"
                            ? `  ✓ Layer B 通过（标量数值一致）`
                            : `  ✓ Layer B 通过（多行语义一致）`,
                        "ok"
                    );
                } else if (!sqlFinal) {
                    snapLog(`  ✗ 未捕获最终 SQL`, "error");
                } else if (!execFinal.ok) {
                    snapLog(
                        `  ✗ Layer A 最终执行失败 (${row.layer_a.error_bucket_final})`,
                        "error"
                    );
                } else {
                    snapLog(
                        matchMode === "scalar"
                            ? `  ✗ Layer B 标量数值不一致`
                            : `  ✗ Layer B 多行结果不一致`,
                        "warn"
                    );
                }
                snapLog(
                    `  Layer A: SA ${saFirst ? "✓" : "✗"}/${
                        saFinal ? "✓" : "✗"
                    } · EPR ${execFirst.ok ? "✓" : "✗"}/${
                        execFinal.ok ? "✓" : "✗"
                    }${repairGain ? " · repair+" : ""}`,
                    "info"
                );
            }

            snapLog("阶段 3/3：汇总 Layer A / Layer B 指标", "info");
            const report = buildReport({
                slug,
                magdaDatasetId: effectiveDatasetId,
                datasetTitle: dataset.title,
                caseFile: caseFileForSlug(slug),
                appName,
                cases: caseRows,
                harnessLog: harnessLogSnapshot
            });
            setLastReport(report);

            const s = report.summary;
            snapLog(
                `完成 — Layer B 结果准确率 ${(
                    s.layer_b.result_accuracy * 100
                ).toFixed(1)}% (${s.layer_b.result_match_count}/${s.n})`,
                "ok"
            );
            snapLog(
                `Layer A — SA(first/final) ${(
                    s.layer_a.syntax_accuracy_first * 100
                ).toFixed(1)}% / ${(
                    s.layer_a.syntax_accuracy_final * 100
                ).toFixed(1)}% · EPR ${(s.layer_a.epr_first * 100).toFixed(
                    1
                )}% / ${(s.layer_a.epr_final * 100).toFixed(
                    1
                )}% · repair gain ${s.layer_a.repair_gain_count}`,
                "ok"
            );
        } catch (e) {
            appendLog(`评测中止: ${e}`, "error");
            setRunError(String(e));
        } finally {
            setRunning(false);
        }
    }, [
        appName,
        history,
        dataset,
        datasetReady,
        cases,
        slug,
        effectiveDatasetId,
        appendLog
    ]);

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

    return (
        <div className="container" style={{ padding: "24px 16px 48px" }}>
            <h2>Magda GeoSQL 评测（全链路）</h2>
            <p style={{ maxWidth: 920 }}>
                对齐终稿 <strong>§4.3 两层评测</strong>：
                <strong>Layer A</strong>{" "}
                语法可读性（SA）与执行通过率（EPR，首次/最终）；
                <strong>Layer B</strong> 与 <code>gold_sql</code>{" "}
                的结果指纹比对。走 <code>AgentChain</code> →{" "}
                <code>spatial_sql</code> → <code>queryGeoDataset</code>{" "}
                生产路径。
            </p>

            {manifestError ? (
                <Message type="error" showIcon>
                    {manifestError}
                </Message>
            ) : null}

            {!config.enableChatbot || !config.enablePglitePostgis ? (
                <Message type="warning" showIcon>
                    当前环境未开启 enableChatbot 或 enablePglitePostgis。
                </Message>
            ) : null}

            <Panel bordered style={{ marginTop: 16 }}>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 16 }}>
                    <div style={{ minWidth: 260 }}>
                        <div style={{ marginBottom: 8 }}>评测数据集</div>
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
                            placeholder="与 /dataset/&lt;id&gt; 相同"
                        />
                        {effectiveDatasetId ? (
                            <div style={{ marginTop: 8 }}>
                                <Link
                                    to={`/dataset/${effectiveDatasetId}`}
                                    target="_blank"
                                    rel="noreferrer"
                                >
                                    打开数据集页
                                </Link>
                            </div>
                        ) : null}
                    </div>
                </div>

                {datasetIsFetching ? (
                    <Loader content="加载 registry 数据集…" />
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
                        已加载：{dataset?.title}
                    </Message>
                ) : effectiveDatasetId && !datasetIsFetching ? (
                    <Message type="info" style={{ marginTop: 12 }} showIcon>
                        等待 registry 数据集…
                    </Message>
                ) : null}

                {casesError ? (
                    <Message type="error" style={{ marginTop: 12 }} showIcon>
                        {casesError}
                    </Message>
                ) : cases ? (
                    <Message type="info" style={{ marginTop: 12 }} showIcon>
                        已载入 {cases.length} 条用例（{slug}）。
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
                        loading={running}
                        disabled={
                            running ||
                            !datasetReady ||
                            !cases?.length ||
                            !config.enableChatbot ||
                            !config.enablePglitePostgis
                        }
                        onClick={() => void runEval()}
                    >
                        运行评测
                    </Button>
                    <Button disabled={running} onClick={clearLogs}>
                        清空日志
                    </Button>
                    <Button
                        disabled={!lastReport}
                        onClick={() =>
                            lastReport && downloadJsonReport(lastReport)
                        }
                    >
                        下载 JSON 报告
                    </Button>
                    <Button
                        disabled={!lastReport}
                        onClick={() =>
                            lastReport && downloadCsvSummary(lastReport)
                        }
                    >
                        下载 CSV 摘要
                    </Button>
                </ButtonToolbar>
            </Panel>

            <Panel
                header="运行日志（harness + System Logs）"
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
                            点击「运行评测」后在此显示阶段进度；每条用例会附带
                            AgentChain System Logs。
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

            {lastReport ? (
                <Panel
                    header={`评测结果 — Layer B ${passCount} / ${totalCount} 通过`}
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
                            {lastReport.summary.layer_a.repair_gain_count} 条
                        </div>
                        <div>
                            <strong>Layer B · 结果准确率</strong>
                            <br />
                            {(
                                lastReport.summary.layer_b.result_accuracy * 100
                            ).toFixed(1)}
                            %
                        </div>
                    </div>

                    <div style={{ overflowX: "auto" }}>
                        <table className="table">
                            <thead>
                                <tr>
                                    <th>用例</th>
                                    <th>Layer B</th>
                                    <th>EPR 首/终</th>
                                    <th>说明</th>
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
                                            {r.error_message ? (
                                                <span style={{ color: "#c00" }}>
                                                    {r.error_message.slice(
                                                        0,
                                                        120
                                                    )}
                                                </span>
                                            ) : r.layer_b.result_match ? (
                                                "指纹一致"
                                            ) : (
                                                <details>
                                                    <summary>模型 SQL</summary>
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
