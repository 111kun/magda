/**
 * GeoSQL evaluation report (Layer A / Layer B per Final Report §4.3).
 */
import { aggregateCaseTimingMs, aggregateLlmUsage } from "./geoSqlEvalMetrics";
import type {
    EvalCaseTiming,
    EvalLlmUsageBreakdown,
    EvalRunTiming
} from "./geoSqlEvalMetrics";
import {
    compareQueryResults,
    rowsToComparableSignature,
    GeoSqlResultMatchMode
} from "./geoSqlEvalRowFingerprint";

export type GeoSqlEvalErrorBucket =
    | "syntax"
    | "schema"
    | "function"
    | "type"
    | "crs"
    | "runtime"
    | "routing"
    | "unknown"
    | "none";

export type EvalCaseRow = {
    case_id: string;
    question: string;
    tags?: string[];
    gold_sql: string;
    model_sql_first?: string;
    model_sql_final?: string;
    sanitizer_fixes?: string[];
    layer_a: {
        syntax_accuracy_first: boolean;
        syntax_accuracy_final: boolean;
        execution_pass_first: boolean;
        execution_pass_final: boolean;
        error_bucket_first: GeoSqlEvalErrorBucket;
        error_bucket_final: GeoSqlEvalErrorBucket;
        repair_gain: boolean;
    };
    layer_b: {
        result_match: boolean;
        match_mode: GeoSqlResultMatchMode;
        /** Semantic comparable signature (column-agnostic); not strict JSON fingerprint. */
        gold_fingerprint: string;
        model_fingerprint: string;
        gold_row_count: number;
        model_row_count: number;
    };
    error_message?: string;
    system_logs?: string[];
    /** Wall-clock for this case (stream + harness scoring). */
    timing?: EvalCaseTiming;
    /** Parsed from system_logs token usage lines. */
    llm_usage?: EvalLlmUsageBreakdown;
};

export type EvalRunSummary = {
    n: number;
    layer_a: {
        syntax_accuracy_first: number;
        syntax_accuracy_final: number;
        epr_first: number;
        epr_final: number;
        repair_gain_count: number;
    };
    layer_b: {
        result_accuracy: number;
        result_match_count: number;
    };
    error_buckets: Record<GeoSqlEvalErrorBucket, number>;
    timing_ms_total?: number;
    timing_ms_mean?: number;
    llm_usage?: EvalLlmUsageBreakdown;
};

export type GeoSqlEvalReport = {
    meta: {
        framework: string;
        generated_at: string;
        dataset_slug: string;
        magda_dataset_id: string;
        dataset_title?: string;
        case_file?: string;
        app_name?: string;
        llm_provider?: "webllm" | "openai";
        openai_model?: string;
        /** agent = deterministic renderer; agent_full_planner = slim planner every case; baseline_direct = no AgentChain */
        eval_pipeline?: "agent" | "agent_full_planner" | "baseline_direct";
        run_timing?: EvalRunTiming;
        llm_usage_total?: EvalLlmUsageBreakdown;
    };
    summary: EvalRunSummary;
    cases: EvalCaseRow[];
    harness_log: Array<{ at: string; level: string; message: string }>;
};

export function isReadableSql(sql: string | undefined): boolean {
    const t = (sql || "").trim();
    if (!t) return false;
    if (!/^(select|with)\b/i.test(t)) return false;
    if (/\b(insert|update|delete|drop|alter|truncate|create)\b/i.test(t)) {
        return false;
    }
    return true;
}

export function classifySqlError(message: string): GeoSqlEvalErrorBucket {
    const m = (message || "").toLowerCase();
    if (!m) return "unknown";
    if (
        /syntax|parse|unexpected token|unterminated|near "|does not exist.*column|invalid input syntax/i.test(
            m
        )
    ) {
        if (/column|relation|jsonb|properties/i.test(m)) return "schema";
        return "syntax";
    }
    if (/function.*does not exist|st_[a-z]+.*does not exist/i.test(m)) {
        return "function";
    }
    if (/type|cannot cast|operator does not exist/i.test(m)) {
        return "type";
    }
    if (/srid|transform|epsg|coordinate/i.test(m)) {
        return "crs";
    }
    if (/unknown key|jsonb key|not in.*property/i.test(m)) {
        return "schema";
    }
    if (/contract|not applicable|spatial_sql|route/i.test(m)) {
        return "routing";
    }
    return "runtime";
}

export function buildSummary(cases: EvalCaseRow[]): EvalRunSummary {
    const n = cases.length || 1;
    const buckets: Record<GeoSqlEvalErrorBucket, number> = {
        syntax: 0,
        schema: 0,
        function: 0,
        type: 0,
        crs: 0,
        runtime: 0,
        routing: 0,
        unknown: 0,
        none: 0
    };
    let saFirst = 0;
    let saFinal = 0;
    let eprFirst = 0;
    let eprFinal = 0;
    let repairGain = 0;
    let resultMatch = 0;

    for (const c of cases) {
        if (c.layer_a.syntax_accuracy_first) saFirst++;
        if (c.layer_a.syntax_accuracy_final) saFinal++;
        if (c.layer_a.execution_pass_first) eprFirst++;
        if (c.layer_a.execution_pass_final) eprFinal++;
        if (c.layer_a.repair_gain) repairGain++;
        if (c.layer_b.result_match) resultMatch++;

        const b = c.layer_a.execution_pass_final
            ? "none"
            : c.layer_a.error_bucket_final !== "none"
            ? c.layer_a.error_bucket_final
            : c.layer_a.error_bucket_first;
        if (b !== "none") buckets[b]++;
    }

    const timingAgg = aggregateCaseTimingMs(cases);
    const llm_usage = aggregateLlmUsage(
        cases.map((c) => c.llm_usage).filter(Boolean) as EvalLlmUsageBreakdown[]
    );

    return {
        n: cases.length,
        layer_a: {
            syntax_accuracy_first: saFirst / n,
            syntax_accuracy_final: saFinal / n,
            epr_first: eprFirst / n,
            epr_final: eprFinal / n,
            repair_gain_count: repairGain
        },
        layer_b: {
            result_accuracy: resultMatch / n,
            result_match_count: resultMatch
        },
        error_buckets: buckets,
        timing_ms_total: timingAgg.total_ms,
        timing_ms_mean: timingAgg.mean_ms,
        llm_usage: llm_usage.call_count ? llm_usage : undefined
    };
}

export function buildReport(params: {
    slug: string;
    magdaDatasetId: string;
    datasetTitle?: string;
    caseFile?: string;
    appName?: string;
    cases: EvalCaseRow[];
    harnessLog: GeoSqlEvalReport["harness_log"];
    llmProvider?: "webllm" | "openai";
    openAiModel?: string;
    runTiming?: EvalRunTiming;
    evalPipeline?: "agent" | "agent_full_planner" | "baseline_direct";
}): GeoSqlEvalReport {
    const summary = buildSummary(params.cases);
    return {
        meta: {
            framework:
                params.evalPipeline === "baseline_direct"
                    ? "GeoSQL-Eval baseline direct (profile + question → LLM SQL; Layer A/B same harness)"
                    : params.evalPipeline === "agent_full_planner"
                    ? "GeoSQL-Eval agent planner-only (AgentChain + task-spec; no deterministic SQL renderer)"
                    : "GeoSQL-Eval two-layer (Layer A: SA/EPR; Layer B: scalar numeric or row-set semantic match) — Final Report §4.3",
            generated_at: new Date().toISOString(),
            dataset_slug: params.slug,
            magda_dataset_id: params.magdaDatasetId,
            dataset_title: params.datasetTitle,
            case_file: params.caseFile,
            app_name: params.appName,
            llm_provider: params.llmProvider,
            openai_model: params.openAiModel,
            eval_pipeline: params.evalPipeline,
            run_timing: params.runTiming,
            llm_usage_total: summary.llm_usage
        },
        summary,
        cases: params.cases,
        harness_log: params.harnessLog
    };
}

export type GeoSqlEvalCombinedReport = {
    meta: {
        framework: string;
        generated_at: string;
        mode: "all_datasets";
        dataset_count: number;
        run_timing?: EvalRunTiming;
        llm_usage_total?: EvalLlmUsageBreakdown;
        total_cases?: number;
    };
    datasets: GeoSqlEvalReport[];
};

export function downloadCombinedJsonReport(reports: GeoSqlEvalReport[]): void {
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const allCases = reports.flatMap((r) => r.cases);
    const caseTiming = aggregateCaseTimingMs(allCases);
    const llm_usage = aggregateLlmUsage(
        reports
            .map((r) => r.meta.llm_usage_total || r.summary.llm_usage)
            .filter(Boolean) as EvalLlmUsageBreakdown[]
    );
    const runStarted = reports
        .map((r) => r.meta.run_timing?.started_at)
        .filter(Boolean)
        .sort()[0];
    const runFinished = reports
        .map((r) => r.meta.run_timing?.finished_at)
        .filter(Boolean)
        .sort()
        .reverse()[0];
    const runWallSum = reports.reduce(
        (a, r) => a + (r.meta.run_timing?.wall_ms || 0),
        0
    );
    const combined: GeoSqlEvalCombinedReport = {
        meta: {
            framework:
                "GeoSQL-Eval two-layer — combined run (Layer A: SA/EPR; Layer B: semantic match)",
            generated_at: new Date().toISOString(),
            mode: "all_datasets",
            dataset_count: reports.length,
            total_cases: allCases.length,
            run_timing:
                runStarted && runFinished
                    ? {
                          started_at: runStarted,
                          finished_at: runFinished,
                          wall_ms: runWallSum,
                          cases_wall_ms_sum: caseTiming.total_ms
                      }
                    : undefined,
            llm_usage_total: llm_usage.call_count ? llm_usage : undefined
        },
        datasets: reports
    };
    const blob = new Blob([JSON.stringify(combined, null, 2)], {
        type: "application/json"
    });
    triggerDownload(blob, `magda-geosql-eval-all-${ts}.json`);
}

export function downloadJsonReport(report: GeoSqlEvalReport): void {
    const slug = report.meta.dataset_slug || "eval";
    const ts = report.meta.generated_at.replace(/[:.]/g, "-");
    const blob = new Blob([JSON.stringify(report, null, 2)], {
        type: "application/json"
    });
    triggerDownload(blob, `magda-geosql-eval-${slug}-${ts}.json`);
}

export function downloadCsvSummary(report: GeoSqlEvalReport): void {
    const s = report.summary;
    const lines = [
        "metric,value",
        `n,${s.n}`,
        `layer_a_syntax_accuracy_first,${s.layer_a.syntax_accuracy_first.toFixed(
            4
        )}`,
        `layer_a_syntax_accuracy_final,${s.layer_a.syntax_accuracy_final.toFixed(
            4
        )}`,
        `layer_a_epr_first,${s.layer_a.epr_first.toFixed(4)}`,
        `layer_a_epr_final,${s.layer_a.epr_final.toFixed(4)}`,
        `layer_a_repair_gain_count,${s.layer_a.repair_gain_count}`,
        `layer_b_result_accuracy,${s.layer_b.result_accuracy.toFixed(4)}`,
        `layer_b_result_match_count,${s.layer_b.result_match_count}`,
        ...(s.timing_ms_total != null
            ? [
                  `timing_ms_total,${Math.round(s.timing_ms_total)}`,
                  `timing_ms_mean,${Math.round(s.timing_ms_mean || 0)}`
              ]
            : []),
        ...(s.llm_usage
            ? [
                  `llm_prompt_tokens,${s.llm_usage.prompt_tokens}`,
                  `llm_completion_tokens,${s.llm_usage.completion_tokens}`,
                  `llm_total_tokens,${s.llm_usage.total_tokens}`,
                  `llm_call_count,${s.llm_usage.call_count}`
              ]
            : []),
        "",
        "case_id,layer_b_result_match,layer_b_match_mode,sa_first,sa_final,epr_first,epr_final,repair_gain,error_bucket_final,timing_ms,llm_total_tokens",
        ...report.cases.map((c) =>
            [
                c.case_id,
                c.layer_b.result_match ? "1" : "0",
                c.layer_b.match_mode,
                c.layer_a.syntax_accuracy_first ? "1" : "0",
                c.layer_a.syntax_accuracy_final ? "1" : "0",
                c.layer_a.execution_pass_first ? "1" : "0",
                c.layer_a.execution_pass_final ? "1" : "0",
                c.layer_a.repair_gain ? "1" : "0",
                c.layer_a.error_bucket_final,
                c.timing?.wall_ms ?? "",
                c.llm_usage?.total_tokens ?? ""
            ].join(",")
        )
    ];
    const slug = report.meta.dataset_slug || "eval";
    const ts = report.meta.generated_at.replace(/[:.]/g, "-");
    const blob = new Blob([lines.join("\n")], {
        type: "text/csv;charset=utf-8"
    });
    triggerDownload(blob, `magda-geosql-eval-${slug}-${ts}-summary.csv`);
}

function triggerDownload(blob: Blob, filename: string): void {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
}

export { compareQueryResults, rowsToComparableSignature };
export type { GeoSqlResultMatchMode };
