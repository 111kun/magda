/**
 * Serialize WebLLM engine usage to avoid Extension BindingError (VectorInt).
 */
import type { ServiceWorkerMLCEngine } from "@mlc-ai/web-llm/lib/extension_service_worker";
import type {
    ChatCompletion,
    ChatCompletionChunk,
    ChatCompletionRequest
} from "@mlc-ai/web-llm/lib/openai_api_protocols";

let chain: Promise<unknown> = Promise.resolve();

function enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = chain.then(fn, fn);
    chain = run.then(
        () => undefined,
        () => undefined
    );
    return run;
}

export async function webLlmResetChat(
    engine: ServiceWorkerMLCEngine
): Promise<void> {
    await enqueue(async () => {
        await engine.resetChat();
    });
}

export async function webLlmChatCompletion(
    engine: ServiceWorkerMLCEngine,
    request: Omit<ChatCompletionRequest, "stream">
): Promise<ChatCompletion> {
    return enqueue(
        () =>
            engine.chat.completions.create({
                ...request,
                stream: false
            }) as Promise<ChatCompletion>
    );
}

export async function webLlmChatCompletionStream(
    engine: ServiceWorkerMLCEngine,
    request: Omit<ChatCompletionRequest, "stream">
): Promise<AsyncIterable<ChatCompletionChunk>> {
    return enqueue(
        () =>
            engine.chat.completions.create({
                ...request,
                stream: true
            }) as Promise<AsyncIterable<ChatCompletionChunk>>
    );
}
