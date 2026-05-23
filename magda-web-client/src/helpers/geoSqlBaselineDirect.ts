/**
 * Baseline eval: dataset profile + question → single LLM call → SQL (no AgentChain / task-spec).
 */
import type { MagdaChatEngine } from "Components/Chatbot/magdaLlmEngine";
import {
    webLlmChatCompletion,
    webLlmResetChat
} from "Components/Chatbot/webLlmSerial";
import type { EvalLlmUsageBreakdown } from "./geoSqlEvalMetrics";
import { EVAL_CASE_TIMEOUT_MS_WEBLLM } from "./geoSqlEvalCaseTimeout";

export type BaselineDirectSqlResult = {
    sql?: string;
    rawReply?: string;
    rejectReason?: string;
    systemLogs: string[];
    llm_usage?: EvalLlmUsageBreakdown;
};

/** Pull executable SQL from planner-style JSON, fenced SQL, or bare SELECT/WITH. */
export function extractSqlFromLlmReply(
    raw: string
): {
    sql?: string;
    rejectReason?: string;
} {
    const text = (raw || "").trim();
    if (!text) {
        return { rejectReason: "Empty LLM reply" };
    }

    const fence = text.match(/```(?:sql)?\s*([\s\S]*?)```/i);
    if (fence?.[1]?.trim()) {
        const sql = fence[1].trim();
        if (/^(select|with)\b/i.test(sql)) {
            return { sql };
        }
    }

    const jsonSlice = text.match(/\{[\s\S]*\}/)?.[0];
    if (jsonSlice) {
        try {
            const parsed = JSON.parse(jsonSlice) as Record<string, unknown>;
            const candidate =
                (typeof parsed.sqlQuery === "string" && parsed.sqlQuery) ||
                (typeof parsed.sql === "string" && parsed.sql) ||
                "";
            if (candidate.trim() && /^(select|with)\b/i.test(candidate)) {
                return { sql: candidate.trim() };
            }
            if (parsed.type === "not_applicable") {
                return {
                    rejectReason:
                        typeof parsed.reason === "string"
                            ? parsed.reason
                            : "not_applicable"
                };
            }
        } catch {
            // fall through
        }
    }

    const selectMatch = text.match(/\b((?:WITH|SELECT)[\s\S]*)/i);
    if (selectMatch?.[1]) {
        const sql = selectMatch[1].replace(/```[\s\S]*$/g, "").trim();
        if (/^(select|with)\b/i.test(sql)) {
            return { sql };
        }
    }

    return { rejectReason: "Could not parse SQL from LLM reply" };
}

export async function generateBaselineDirectSql(
    engine: MagdaChatEngine,
    params: {
        question: string;
        metadataBrief: string;
        fileDescItems: string[];
    }
): Promise<BaselineDirectSqlResult> {
    const systemLogs: string[] = [];
    const push = (msg: string) => systemLogs.push(msg);

    const schemaBlock = params.fileDescItems.length
        ? params.fileDescItems.join("\n---\n")
        : "N/A";

    const system = [
        "You are a PostGIS SQL generator for Magda eval baseline.",
        "Return ONLY one JSON object (no markdown):",
        '{"sqlQuery":"<single SELECT or WITH...SELECT>"}',
        "Rules:",
        "- Table name MUST be `features` (id, geom SRID 4326, properties JSONB).",
        "- All business attributes via properties->>'key' only.",
        "- One statement only; no DDL/DML; no prose outside JSON.",
        "- Use PostGIS (ST_*, ::geography) when the question needs geometry."
    ].join("\n");

    const user = [
        `User question:\n${params.question}`,
        "",
        `Dataset metadata:\n${params.metadataBrief || "N/A"}`,
        "",
        `Dataset schema (YAML per spatial file):\n${schemaBlock}`
    ].join("\n");

    push(
        "Baseline direct: single LLM call (profile + question → sqlQuery JSON)."
    );

    let reply: Awaited<ReturnType<typeof webLlmChatCompletion>> | null = null;
    const llmTimeoutMs = EVAL_CASE_TIMEOUT_MS_WEBLLM;
    try {
        await webLlmResetChat(engine);
        reply = await Promise.race([
            webLlmChatCompletion(engine, {
                messages: [
                    { role: "system", content: system },
                    { role: "user", content: user }
                ]
            }),
            new Promise<never>((_, reject) =>
                setTimeout(
                    () =>
                        reject(
                            new Error(
                                `Baseline direct LLM timed out after ${
                                    llmTimeoutMs / 1000
                                }s.`
                            )
                        ),
                    llmTimeoutMs
                )
            )
        ]);
    } catch (e) {
        push(`Baseline direct LLM call failed: ${String(e)}`);
        return { rejectReason: String(e), systemLogs };
    }

    const usage = reply?.usage;
    let llm_usage: EvalLlmUsageBreakdown | undefined;
    if (usage) {
        push(
            `[BaselineDirect] LLM usage: prompt=${usage.prompt_tokens} completion=${usage.completion_tokens} total=${usage.total_tokens} tokens.`
        );
        llm_usage = {
            prompt_tokens: usage.prompt_tokens,
            completion_tokens: usage.completion_tokens,
            total_tokens: usage.total_tokens,
            call_count: 1,
            by_source: {
                baseline_direct: {
                    prompt_tokens: usage.prompt_tokens,
                    completion_tokens: usage.completion_tokens,
                    total_tokens: usage.total_tokens,
                    call_count: 1
                }
            }
        };
    }

    const raw = reply?.choices?.[0]?.message?.content?.trim() || "";
    if (raw) {
        push(
            `Baseline direct raw reply (${raw.length} chars): ${raw.slice(
                0,
                400
            )}${raw.length > 400 ? "…" : ""}`
        );
    }

    const extracted = extractSqlFromLlmReply(raw);
    if (extracted.sql) {
        push(
            `Baseline direct parsed SQL:\n\`\`\`sql\n${extracted.sql}\n\`\`\``
        );
        return { sql: extracted.sql, rawReply: raw, systemLogs, llm_usage };
    }

    push(
        `Baseline direct: no SQL (${extracted.rejectReason || "parse failed"}).`
    );
    return {
        rawReply: raw,
        rejectReason: extracted.rejectReason,
        systemLogs,
        llm_usage
    };
}
