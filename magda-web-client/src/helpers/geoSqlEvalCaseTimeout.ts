/** Per-case wall-clock limit for eval harness (LLM + stream phase). */

export const EVAL_CASE_TIMEOUT_MS_WEBLLM = 5 * 60 * 1000;
export const EVAL_CASE_TIMEOUT_MS_OPENAI = 5 * 60 * 1000;

export type EvalCaseTimeoutProvider = "webllm" | "openai";

export function resolveEvalCaseTimeoutMs(
    provider: EvalCaseTimeoutProvider
): number {
    const env =
        typeof process !== "undefined"
            ? (process.env as Record<string, string | undefined>)
            : {};
    const raw = env.REACT_APP_GEOSQL_EVAL_CASE_TIMEOUT_MS?.trim();
    if (raw) {
        const n = Number(raw);
        if (Number.isFinite(n) && n > 0) {
            return n;
        }
    }
    return provider === "openai"
        ? EVAL_CASE_TIMEOUT_MS_OPENAI
        : EVAL_CASE_TIMEOUT_MS_WEBLLM;
}

export function formatEvalCaseTimeoutLabel(timeoutMs: number): string {
    const sec = Math.round(timeoutMs / 1000);
    return sec >= 60 ? `${Math.round(sec / 60)} min` : `${sec}s`;
}

export async function withEvalCaseTimeout<T>(
    caseId: string,
    timeoutMs: number,
    fn: () => Promise<T>
): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            fn(),
            new Promise<never>((_, reject) => {
                timer = setTimeout(() => {
                    reject(
                        new Error(
                            `Eval case ${caseId} timed out after ${formatEvalCaseTimeoutLabel(
                                timeoutMs
                            )}; marked failed and continuing.`
                        )
                    );
                }, timeoutMs);
            })
        ]);
    } finally {
        if (timer !== undefined) {
            clearTimeout(timer);
        }
    }
}
