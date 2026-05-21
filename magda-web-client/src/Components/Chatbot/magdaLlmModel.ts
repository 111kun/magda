import type { ChatCompletionUserMessageParam } from "@mlc-ai/web-llm/lib/openai_api_protocols";
import type { InitProgressCallback } from "@mlc-ai/web-llm";
import type { MagdaChatEngine } from "./magdaLlmEngine";
import type { WebLLMTool, WebLLMToolCallResult } from "./ChatWebLLM";

/** Shared surface for ChatWebLLM and eval-only OpenAI backend. */
export interface MagdaLlmModel {
    model: string;
    loadProgressCallback?: InitProgressCallback;
    initialize(): Promise<MagdaChatEngine>;
    getEngine(): Promise<MagdaChatEngine>;
    invokeTool<T = unknown>(
        userMessage: ChatCompletionUserMessageParam | string,
        tools: WebLLMTool[],
        thisObj?: unknown
    ): Promise<WebLLMToolCallResult<T> | undefined>;
}
