/**
 * Parse timing and OpenAI/WebLLM token usage from GeoSQL eval system logs.
 */

export type EvalLlmUsageSlice = {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    call_count: number;
};

export type EvalLlmUsageBreakdown = EvalLlmUsageSlice & {
    by_source: Record<string, EvalLlmUsageSlice>;
};

export type EvalCaseTiming = {
    wall_ms: number;
    started_at: string;
    finished_at: string;
};

export type EvalRunTiming = {
    started_at: string;
    finished_at: string;
    wall_ms: number;
    warmup_wall_ms?: number;
    cases_wall_ms_sum?: number;
};

const USAGE_LINE_RE = /(?:Planner LLM usage|Intro LLM usage|\[GeoTaskInterpreter\] LLM usage|\[SpatialIntentRouter\] LLM usage|\[BaselineDirect\] LLM usage):\s*prompt=(\d+)\s+completion=(\d+)\s+total=(\d+)/i;

function emptySlice(): EvalLlmUsageSlice {
    return {
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0,
        call_count: 0
    };
}

function sourceFromLogLine(line: string): string {
    if (/Planner LLM usage/i.test(line)) return "planner";
    if (/Intro LLM usage/i.test(line)) return "intro";
    if (/GeoTaskInterpreter/i.test(line)) return "task_spec";
    if (/SpatialIntentRouter/i.test(line)) return "spatial_router";
    if (/BaselineDirect/i.test(line)) return "baseline_direct";
    return "other";
}

function addSlice(
    target: EvalLlmUsageSlice,
    prompt: number,
    completion: number,
    total: number
): void {
    target.prompt_tokens += prompt;
    target.completion_tokens += completion;
    target.total_tokens += total;
    target.call_count += 1;
}

/** Sum token usage lines emitted by planner / task-spec / intro / spatial router. */
export function parseLlmUsageFromSystemLogs(
    logs: string[] | undefined
): EvalLlmUsageBreakdown {
    const result: EvalLlmUsageBreakdown = {
        ...emptySlice(),
        by_source: {}
    };
    if (!logs?.length) return result;

    for (const line of logs) {
        const m = line.match(USAGE_LINE_RE);
        if (!m) continue;
        const prompt = Number(m[1]) || 0;
        const completion = Number(m[2]) || 0;
        const total = Number(m[3]) || 0;
        const src = sourceFromLogLine(line);
        addSlice(result, prompt, completion, total);
        if (!result.by_source[src]) {
            result.by_source[src] = emptySlice();
        }
        addSlice(result.by_source[src], prompt, completion, total);
    }
    return result;
}

export function aggregateLlmUsage(
    slices: EvalLlmUsageBreakdown[]
): EvalLlmUsageBreakdown {
    const result: EvalLlmUsageBreakdown = {
        ...emptySlice(),
        by_source: {}
    };
    for (const s of slices) {
        result.prompt_tokens += s.prompt_tokens;
        result.completion_tokens += s.completion_tokens;
        result.total_tokens += s.total_tokens;
        result.call_count += s.call_count;
        for (const [src, part] of Object.entries(s.by_source || {})) {
            if (!result.by_source[src]) {
                result.by_source[src] = emptySlice();
            }
            const bucket = result.by_source[src];
            bucket.prompt_tokens += part.prompt_tokens;
            bucket.completion_tokens += part.completion_tokens;
            bucket.total_tokens += part.total_tokens;
            bucket.call_count += part.call_count;
        }
    }
    return result;
}

export function aggregateCaseTimingMs(
    cases: Array<{ timing?: { wall_ms?: number } }>
): { total_ms: number; mean_ms: number; n: number } {
    const vals = cases
        .map((c) => c.timing?.wall_ms)
        .filter((v): v is number => typeof v === "number" && v >= 0);
    const total_ms = vals.reduce((a, b) => a + b, 0);
    return {
        total_ms,
        mean_ms: vals.length ? total_ms / vals.length : 0,
        n: vals.length
    };
}

export function formatDurationMs(ms: number): string {
    if (ms < 1000) return `${Math.round(ms)} ms`;
    if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
    const m = Math.floor(ms / 60_000);
    const s = ((ms % 60_000) / 1000).toFixed(0);
    return `${m}m ${s}s`;
}
