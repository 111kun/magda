import type {
    ChatCompletion,
    ChatCompletionRequest,
    ChatCompletionUserMessageParam
} from "@mlc-ai/web-llm/lib/openai_api_protocols";
import type { MagdaChatEngine } from "./magdaLlmEngine";
import { webLlmChatCompletion } from "./webLlmSerial";
import type { WebLLMTool, WebLLMToolCallResult } from "./ChatWebLLM";

export async function llmInvokeTool<T = unknown>(
    engine: MagdaChatEngine,
    userMessage: ChatCompletionUserMessageParam | string,
    tools: WebLLMTool[],
    thisObj: unknown = undefined
): Promise<WebLLMToolCallResult<T> | undefined> {
    const makeFallbackResult = (
        text: string
    ): WebLLMToolCallResult<T> | undefined => {
        const value = text?.trim();
        if (!value) {
            return undefined;
        }
        return {
            name: "__fallback_text__",
            value: value as T
        };
    };
    const extractOutputMessageFromError = (rawErr: unknown): string | null => {
        const text = String(rawErr || "");
        const marker = "Got outputMessage:";
        const markerIdx = text.indexOf(marker);
        if (markerIdx === -1) {
            return null;
        }
        const after = text.slice(markerIdx + marker.length).trim();
        const endMarker = "\nGot error:";
        const endIdx = after.indexOf(endMarker);
        return (endIdx === -1 ? after : after.slice(0, endIdx)).trim();
    };
    const availableToolNames = tools.map((item) => item.name).join(", ");
    const toolCallSystemInstruction =
        "You are a tool-using assistant for the Magda platform. " +
        "When tools are provided, prefer calling a relevant tool whenever the user asks for dataset/distribution data, metadata, SQL analysis, or spatial analysis. " +
        "For pure greeting/chitchat/help text that does not require data access, plain-text reply is allowed. " +
        "Use spatial SQL tool only for spatial analysis intent (distance, nearby, intersection, within, buffer, geometry filters). " +
        "For queryGeoSpatialWithSQLQuery, you MUST provide required arguments: distributionIndex (integer) and sqlQuery (valid PostGIS SQL against table features). " +
        "For queryGeoSpatialWithSQLQuery.sqlQuery, provide executable SQL only and start directly with SELECT or WITH; never include apologies, prose, markdown code fences, labels, comments, or text before/after the SQL. " +
        "Optional arguments: placeName and countrycodes. " +
        "For current dataset/distribution metadata questions (e.g. fields, columns, dataset description, sample data), prefer queryDataset when available; otherwise use defaultAgent. " +
        "For greeting/help/system usage, use defaultAgent when available. " +
        "Do not output SQL explanations in message content when calling tools. " +
        "Do not invent table names or fields; the query table is features after importing the selected spatial distribution. " +
        "If required arguments cannot be inferred, ask a concise clarification question via tool result text. " +
        "When calling a tool, the tool arguments must be strict valid JSON object only (double quotes, no comments, no trailing commas). " +
        'Never print pseudo tool-call payloads in message content (for example JSON like {"name":...,"arguments":...}, XML tags, or markdown code blocks). ' +
        "Use exact tool names only. Available tool names: " +
        availableToolNames;
    const toolDefs = tools.map((item) => {
        const { func, parameters, requiredParameters, ...def } = item;
        const functionDef: Record<string, unknown> = { ...def };
        if (parameters?.length) {
            const properties: Record<string, unknown> = {};
            parameters.forEach((p) => {
                const { name, ...parameterTypeDef } = p;
                properties[name] = parameterTypeDef;
            });
            functionDef.parameters = {
                type: "object",
                properties,
                ...(requiredParameters?.length
                    ? { required: requiredParameters }
                    : {})
            };
        }
        return {
            type: "function" as const,
            function: functionDef
        };
    });
    const request: Omit<ChatCompletionRequest, "stream"> = {
        messages: [
            {
                role: "system" as const,
                content: toolCallSystemInstruction
            },
            ...(typeof userMessage === "string"
                ? [{ role: "user" as const, content: userMessage }]
                : [userMessage])
        ],
        tool_choice: "auto" as const,
        tools: (toolDefs as unknown) as ChatCompletionRequest["tools"]
    };
    let reply: ChatCompletion | undefined;
    try {
        reply = await webLlmChatCompletion(engine, request);
    } catch (e) {
        const msg = String(e || "");
        if (
            msg.includes("ToolCallOutputParseError") ||
            msg.includes("not valid JSON")
        ) {
            const outputMessage = extractOutputMessageFromError(e);
            console.warn(
                "invokeTool fallback: model returned non-tool text in tool-call mode.",
                e
            );
            return makeFallbackResult(outputMessage || "");
        }
        throw e;
    }
    const finish_reason = reply?.choices?.[0]?.finish_reason;
    switch (finish_reason) {
        case "length":
            throw new Error(
                "The LLM failed to process your request because it exceeds the context window limit."
            );
        case "abort":
            throw new Error(
                "The LLM could not process your request as it was aborted."
            );
        case "stop":
            throw new Error(
                "The LLM could not process your request as it was stopped."
            );
    }
    if (!reply?.choices?.[0]?.message?.tool_calls?.length) {
        const plainText = reply?.choices?.[0]?.message?.content;
        if (typeof plainText === "string" && plainText.trim()) {
            return makeFallbackResult(plainText);
        }
        return undefined;
    }
    const toolCall = reply.choices[0].message.tool_calls[0].function;
    const funcName = toolCall.name;
    let funcArgsObj: Record<string, unknown> = {};
    if (toolCall?.arguments?.length) {
        try {
            funcArgsObj = JSON.parse(toolCall.arguments);
        } catch (e) {
            console.warn(
                "invokeTool fallback: tool arguments are not valid JSON.",
                toolCall.arguments
            );
            const plainText = reply?.choices?.[0]?.message?.content;
            if (typeof plainText === "string" && plainText.trim()) {
                return makeFallbackResult(plainText);
            }
            return undefined;
        }
    }
    const toolCalled = tools.find((tool) => tool.name === funcName);
    if (!toolCalled) {
        throw new Error(
            `Invalid LLM response: Cannot locate tool with name: ${funcName}`
        );
    }
    const funcArgs = (toolCalled?.parameters?.length
        ? toolCalled.parameters
        : []
    ).map((item) => funcArgsObj?.[item.name]);
    const result = await toolCalled.func.call(thisObj, ...funcArgs);
    return {
        name: toolCalled.name,
        value: result as T
    };
}
