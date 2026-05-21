import type {
    ChatCompletion,
    ChatCompletionChunk,
    ChatCompletionRequest
} from "@mlc-ai/web-llm/lib/openai_api_protocols";

/** Duck-typed engine surface used by WebLLM and eval OpenAI backends. */
export type MagdaChatEngine = {
    resetChat(): Promise<void>;
    chat: {
        completions: {
            create(
                request: ChatCompletionRequest
            ): Promise<ChatCompletion | AsyncIterable<ChatCompletionChunk>>;
        };
    };
};
