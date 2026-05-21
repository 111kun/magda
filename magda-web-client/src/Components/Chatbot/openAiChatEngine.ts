import type {
    ChatCompletion,
    ChatCompletionRequest
} from "@mlc-ai/web-llm/lib/openai_api_protocols";
import type { MagdaChatEngine } from "./magdaLlmEngine";

export type OpenAiEngineConfig = {
    model: string;
    apiKey?: string;
    /** e.g. https://api.openai.com/v1 or a local proxy */
    baseUrl: string;
};

export function createOpenAiChatEngine(
    config: OpenAiEngineConfig
): MagdaChatEngine {
    const base = config.baseUrl.replace(/\/$/, "");

    const headers = (): Record<string, string> => {
        const h: Record<string, string> = {
            "Content-Type": "application/json"
        };
        if (config.apiKey?.trim()) {
            h.Authorization = `Bearer ${config.apiKey.trim()}`;
        }
        return h;
    };

    return {
        async resetChat(): Promise<void> {
            // OpenAI is stateless; no session to clear.
        },
        chat: {
            completions: {
                async create(
                    request: ChatCompletionRequest
                ): Promise<ChatCompletion> {
                    if (request.stream) {
                        throw new Error(
                            "OpenAI eval engine does not support stream=true (use WebLLM for streaming)."
                        );
                    }
                    const res = await fetch(`${base}/chat/completions`, {
                        method: "POST",
                        headers: headers(),
                        body: JSON.stringify({
                            ...request,
                            model: config.model,
                            stream: false
                        })
                    });
                    const text = await res.text();
                    if (!res.ok) {
                        throw new Error(
                            `OpenAI API ${res.status}: ${text.slice(0, 800)}`
                        );
                    }
                    return JSON.parse(text) as ChatCompletion;
                }
            }
        }
    };
}
