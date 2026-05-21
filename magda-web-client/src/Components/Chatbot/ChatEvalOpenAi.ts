/**
 * Eval-only OpenAI Chat Completions backend (no browser WebLLM / extension).
 */
import type { InitProgressCallback } from "@mlc-ai/web-llm";
import type { ChatCompletionUserMessageParam } from "@mlc-ai/web-llm/lib/openai_api_protocols";
import { createOpenAiChatEngine } from "./openAiChatEngine";
import type { MagdaChatEngine } from "./magdaLlmEngine";
import type { MagdaLlmModel } from "./magdaLlmModel";
import { llmInvokeTool } from "./llmInvokeTool";
import type { WebLLMTool, WebLLMToolCallResult } from "./ChatWebLLM";

export type ChatEvalOpenAiInputs = {
    model: string;
    apiKey?: string;
    baseUrl?: string;
    loadProgressCallback?: InitProgressCallback;
};

const DEFAULT_OPENAI_MODEL = "gpt-4o-mini";
const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";

export function resolveEvalOpenAiDefaults(): {
    model: string;
    baseUrl: string;
    apiKey?: string;
} {
    const env =
        typeof process !== "undefined"
            ? (process.env as Record<string, string | undefined>)
            : {};
    return {
        model:
            env.REACT_APP_OPENAI_MODEL?.trim() ||
            env.REACT_APP_GEOSQL_EVAL_OPENAI_MODEL?.trim() ||
            DEFAULT_OPENAI_MODEL,
        baseUrl:
            env.REACT_APP_OPENAI_BASE_URL?.trim() ||
            env.REACT_APP_GEOSQL_EVAL_OPENAI_BASE_URL?.trim() ||
            DEFAULT_OPENAI_BASE_URL,
        apiKey:
            env.REACT_APP_OPENAI_API_KEY?.trim() ||
            env.REACT_APP_GEOSQL_EVAL_OPENAI_API_KEY?.trim() ||
            undefined
    };
}

export default class ChatEvalOpenAi implements MagdaLlmModel {
    model: string;
    apiKey?: string;
    baseUrl: string;
    loadProgressCallback?: InitProgressCallback;

    private engine: MagdaChatEngine | null = null;

    static createDefaultModel(
        inputs: Partial<ChatEvalOpenAiInputs> = {}
    ): ChatEvalOpenAi {
        const defaults = resolveEvalOpenAiDefaults();
        return new ChatEvalOpenAi({
            model: inputs.model || defaults.model,
            apiKey: inputs.apiKey ?? defaults.apiKey,
            baseUrl: inputs.baseUrl || defaults.baseUrl,
            loadProgressCallback: inputs.loadProgressCallback
        });
    }

    constructor(inputs: ChatEvalOpenAiInputs) {
        const defaults = resolveEvalOpenAiDefaults();
        this.model = inputs.model || defaults.model;
        this.apiKey = inputs.apiKey ?? defaults.apiKey;
        this.baseUrl = inputs.baseUrl || defaults.baseUrl;
        this.loadProgressCallback = inputs.loadProgressCallback;
    }

    async initialize(): Promise<MagdaChatEngine> {
        this.onProgress({
            progress: 0,
            timeElapsed: 0,
            text: `Connecting to OpenAI (${this.model})…`
        });
        this.engine = createOpenAiChatEngine({
            model: this.model,
            apiKey: this.apiKey,
            baseUrl: this.baseUrl
        });
        this.onProgress({
            progress: 1,
            timeElapsed: 0,
            text: "OpenAI ready"
        });
        return this.engine;
    }

    async getEngine(): Promise<MagdaChatEngine> {
        if (this.engine) {
            return this.engine;
        }
        return await this.initialize();
    }

    private onProgress(report: {
        progress: number;
        timeElapsed: number;
        text: string;
    }) {
        if (this.loadProgressCallback) {
            this.loadProgressCallback(report);
        }
    }

    async invokeTool<T = unknown>(
        userMessage: ChatCompletionUserMessageParam | string,
        tools: WebLLMTool[],
        thisObj: unknown = undefined
    ): Promise<WebLLMToolCallResult<T> | undefined> {
        const engine = await this.getEngine();
        return llmInvokeTool<T>(engine, userMessage, tools, thisObj);
    }
}
