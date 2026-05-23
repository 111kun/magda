import { v4 as uuidv4 } from "uuid";
import { ChainInput, KeyContextData } from "./commons";
import { InitProgressCallback, InitProgressReport } from "@mlc-ai/web-llm";
import { BaseMessage, AIMessage } from "@langchain/core/messages";
import { Runnable, RunnableLambda } from "@langchain/core/runnables";
import ChatEvalOpenAi, { ChatEvalOpenAiInputs } from "./ChatEvalOpenAi";
import ChatWebLLM, { mergeWebLLMChatOptions, WebLLMInputs } from "./ChatWebLLM";
import type { MagdaLlmModel } from "./magdaLlmModel";
import { webLlmResetChat, webLlmUnloadEngine } from "./webLlmSerial";
import AsyncQueue from "@ai-zen/async-queue";
import {
    CommonInputType,
    ChatEventMessage,
    createChatEventMessage,
    EVENT_TYPE_PARTIAL_MSG,
    EVENT_TYPE_PARTIAL_MSG_FINISH,
    createChatEventMessageErrorMsg,
    createChatEventRunLogMsg
} from "./Messaging";
import { History, Location } from "history";
import { ParsedDataset, ParsedDistribution } from "helpers/record";
import createTools from "./tools";
import {
    buildDatasetProfileBase,
    enrichSpatialProfile,
    enrichTabularProfile,
    makeDatasetProfileVersionKey
} from "./datasetProfiling";
import { decideChatRoute, SpatialIntentResult } from "./chatRouteRouter";

export type AgentChainCreateOptions = {
    attachToWindowDebug?: boolean;
    webLlmCreateOptions?: Partial<WebLLMInputs>;
    /** Eval harness: use OpenAI Chat Completions instead of browser WebLLM. */
    llmProvider?: "webllm" | "openai";
    openAi?: Partial<ChatEvalOpenAiInputs>;
};

class AgentChain {
    static agentChain: AgentChain | null = null;
    static llmLoadProgressCallbacks: InitProgressCallback[] = [];
    static create(
        appName: string,
        navLocation: Location,
        navHistory: History,
        dataset: ParsedDataset | undefined,
        distribution: ParsedDistribution | undefined,
        loadProgressCallback?: InitProgressCallback,
        errorHandler?: (e) => void
    ) {
        if (AgentChain.agentChain) {
            if (loadProgressCallback) {
                AgentChain.llmLoadProgressCallbacks.push(loadProgressCallback);
            }
            return AgentChain.agentChain;
        } else {
            if (loadProgressCallback) {
                AgentChain.llmLoadProgressCallbacks.push(loadProgressCallback);
            }
            AgentChain.agentChain = new AgentChain(
                appName,
                navLocation,
                navHistory,
                dataset,
                distribution,
                (report) => {
                    AgentChain.llmLoadProgressCallbacks.forEach((cb) =>
                        cb(report)
                    );
                }
            );
            AgentChain.agentChain.initialize(errorHandler);
            return AgentChain.agentChain;
        }
    }
    /** GeoSQL eval: dedicated AgentChain instance (optional OpenAI backend). */
    static async createForEval(
        appName: string,
        navLocation: Location,
        navHistory: History,
        dataset: ParsedDataset | undefined,
        distribution: ParsedDistribution | undefined,
        loadProgressCallback?: InitProgressCallback,
        errorHandler?: (e) => void,
        options?: AgentChainCreateOptions
    ): Promise<AgentChain> {
        const prev = AgentChain.agentChain;
        if (prev?.model instanceof ChatWebLLM) {
            try {
                const eng = await prev.model.getEngine();
                await webLlmUnloadEngine(eng);
            } catch {
                /* prior engine not loaded */
            }
        }
        AgentChain.agentChain = null;
        if (loadProgressCallback) {
            AgentChain.llmLoadProgressCallbacks.push(loadProgressCallback);
        }
        AgentChain.agentChain = new AgentChain(
            appName,
            navLocation,
            navHistory,
            dataset,
            distribution,
            (report) => {
                AgentChain.llmLoadProgressCallbacks.forEach((cb) => cb(report));
            },
            { attachToWindowDebug: false, ...options }
        );
        void AgentChain.agentChain.initialize(errorHandler);
        return AgentChain.agentChain;
    }

    static removeLLMLoadProgressCallback(callback: InitProgressCallback) {
        const index = AgentChain.llmLoadProgressCallbacks.indexOf(callback);
        if (index !== -1) {
            AgentChain.llmLoadProgressCallbacks.splice(index, 1);
        }
    }

    public model: MagdaLlmModel;
    public loadProgress?: InitProgressReport;
    private loadProgressCallback?: InitProgressCallback;
    public chatHistory: BaseMessage[] = [];
    public navHistory: History;
    public navLocation: Location;
    public appName: string;
    public dataset: ParsedDataset | undefined;
    public distribution: ParsedDistribution | undefined;
    public keyContextData: KeyContextData = {
        queryResult: undefined,
        datasetProfile: undefined,
        datasetProfileUpdatedAt: undefined,
        datasetProfileVersionKey: undefined
    };
    public debug: boolean = false;
    public directModelAccess: boolean = false;
    public chain: Runnable<CommonInputType, string | null | undefined | void>;
    /** Latest ChainInput built by `stream()` — for eval harness to read captured SQL. */
    public lastEvalChainInput?: ChainInput;

    /** Merged into every `ChatWebLLM.createDefaultModel` (constructor + model switch). */
    private webLlmCreateOptions: Partial<WebLLMInputs> = {};

    constructor(
        appName: string,
        navLocation: Location,
        navHistory: History,
        dataset: ParsedDataset | undefined,
        distribution: ParsedDistribution | undefined,
        loadProgressCallback?: InitProgressCallback,
        options?: AgentChainCreateOptions
    ) {
        this.loadProgressCallback = loadProgressCallback;
        this.webLlmCreateOptions = options?.webLlmCreateOptions || {};
        if (options?.llmProvider === "openai") {
            this.model = ChatEvalOpenAi.createDefaultModel({
                loadProgressCallback: this.onProgress.bind(this),
                ...options.openAi
            });
        } else {
            this.model = ChatWebLLM.createDefaultModel({
                loadProgressCallback: this.onProgress.bind(this),
                ...this.webLlmCreateOptions
            });
        }
        this.appName = appName;
        this.navHistory = navHistory;
        this.navLocation = navLocation;
        this.dataset = dataset;
        this.distribution = distribution;
        this.chain = this.createChain();
        if (options?.attachToWindowDebug !== false) {
            (window as any).chatBotAgentChain = this;
        }
    }

    clearDatasetProfileCache(): void {
        this.keyContextData.datasetProfile = undefined;
        this.keyContextData.datasetProfileVersionKey = undefined;
        this.keyContextData.datasetProfileUpdatedAt = undefined;
    }

    async updateModelConfig(
        modelConfig: Partial<WebLLMInputs>,
        errorHandler: (e) => void
    ) {
        if (!(this.model instanceof ChatWebLLM)) {
            errorHandler(
                new Error("updateModelConfig applies to WebLLM only.")
            );
            return;
        }
        const webLlm = this.model;
        const modelSwitchRequested =
            typeof modelConfig.model === "string" &&
            modelConfig.model !== webLlm.model;
        const needsNewEngineInstance =
            modelConfig.config !== undefined ||
            modelConfig.keepAliveMs !== undefined;

        // Changing only chat runtime (e.g. context_window_size) should reload the
        // existing engine — not unload + new ChatWebLLM, which drops extension
        // caches and makes weights look like they are downloading again.
        if (!modelSwitchRequested && !needsNewEngineInstance) {
            try {
                const targetModelId = webLlm.model;
                const mergedChatOptions = mergeWebLLMChatOptions(
                    webLlm.chatOptions,
                    modelConfig.chatOptions
                );
                webLlm.chatOptions = mergedChatOptions;
                if (modelConfig.temperature !== undefined) {
                    webLlm.temperature = modelConfig.temperature;
                }
                if (modelConfig.loadProgressCallback !== undefined) {
                    webLlm.loadProgressCallback =
                        modelConfig.loadProgressCallback;
                }
                this.onProgress({
                    progress: 0,
                    timeElapsed: 0,
                    text: "Updating context window (reusing loaded weights)..."
                });
                await webLlm.getEngine();
                await webLlm.reload(targetModelId, mergedChatOptions);
                this.onProgress({
                    progress: 1,
                    timeElapsed: 0,
                    text: "Ready"
                });
            } catch (e) {
                errorHandler(e);
            }
            return;
        }

        this.onProgress({
            progress: 0,
            timeElapsed: 0,
            text: "Unloading model in order to apply new model config..."
        });
        webLlm.getEngine().then((engine) => engine.unload());
        this.model = ChatWebLLM.createDefaultModel({
            ...this.webLlmCreateOptions,
            ...modelConfig,
            loadProgressCallback: this.onProgress.bind(this)
        });
        await this.initialize(errorHandler);
    }

    async initialize(errorHandler?: (e) => void) {
        try {
            await this.model.initialize();
        } catch (e) {
            if (errorHandler) {
                errorHandler(e);
            } else {
                throw e;
            }
        }
    }

    enableDirectModelAccess(modelConfig: Partial<WebLLMInputs> = {}) {
        this.model = ChatWebLLM.createDefaultModel({
            ...modelConfig,
            loadProgressCallback: this.onProgress.bind(this)
        });
        this.directModelAccess = true;
    }

    setAppName(appName: string) {
        this.appName = appName;
    }

    setNavLocation(location: Location) {
        this.navLocation = location;
    }

    setNavHistory(history: History) {
        this.navHistory = history;
    }

    setDataset(dataset: ParsedDataset | undefined) {
        this.dataset = dataset;
    }

    setDistribution(distribution: ParsedDistribution | undefined) {
        this.distribution = distribution;
    }

    setLoadProgressCallback(loadProgressCallback?: InitProgressCallback) {
        this.loadProgressCallback = loadProgressCallback;
    }

    onProgress(progressReport: InitProgressReport) {
        this.loadProgress = progressReport;
        if (this.loadProgressCallback) {
            this.loadProgressCallback(progressReport);
        }
    }

    async stream(
        question: string,
        streamOpts?: {
            geoEvalCaptureExecutedSql?: boolean;
            geoEvalDisableDeterministicRenderer?: boolean;
            warmupOnly?: boolean;
        }
    ): Promise<AsyncIterable<ChatEventMessage>> {
        const queue = new AsyncQueue<ChatEventMessage>();
        const input: ChainInput = {
            question,
            queue,
            appName: this.appName,
            location: this.navLocation,
            history: this.navHistory,
            model: this.model,
            dataset: this.dataset,
            distribution: this.distribution,
            keyContextData: this.keyContextData,
            geoEvalCaptureExecutedSql: streamOpts?.geoEvalCaptureExecutedSql,
            geoEvalDisableDeterministicRenderer:
                streamOpts?.geoEvalDisableDeterministicRenderer,
            warmupOnly: streamOpts?.warmupOnly
        };
        if (streamOpts?.geoEvalCaptureExecutedSql) {
            (input as any).__geoEvalSkipImport = true;
        }
        if (streamOpts?.geoEvalDisableDeterministicRenderer) {
            (input as any).__geoEvalDisableDeterministicRenderer = true;
        }
        this.lastEvalChainInput = input;

        void (async () => {
            const finishQueue = () => {
                try {
                    queue.done();
                } catch (doneErr) {
                    if (typeof console !== "undefined" && console.error) {
                        console.error(
                            "AgentChain.stream: queue.done failed",
                            doneErr
                        );
                    }
                }
            };
            try {
                const msgId = uuidv4();
                let buffer = "";
                let partialMsgSent = false;

                const stream = await (this.directModelAccess &&
                this.model instanceof ChatWebLLM
                    ? this.model.stream(input.question)
                    : this.chain.stream(input));

                for await (const chunk of stream) {
                    if (chunk === null || typeof chunk === "undefined") {
                        continue;
                    }
                    partialMsgSent = true;
                    const chunkText =
                        typeof chunk === "string" ? chunk : chunk.content;
                    queue.push(
                        createChatEventMessage(EVENT_TYPE_PARTIAL_MSG, {
                            id: msgId,
                            msg: chunkText
                        })
                    );
                    buffer += chunkText;
                }
                if (partialMsgSent) {
                    queue.push(
                        createChatEventMessage(EVENT_TYPE_PARTIAL_MSG_FINISH, {
                            id: msgId
                        })
                    );
                }
                if (this.debug) {
                    this.chatHistory.push(new AIMessage({ content: buffer }));
                }
                if (this.directModelAccess) {
                    console.log(buffer);
                }
            } catch (e) {
                try {
                    queue.push(createChatEventMessageErrorMsg(e as Error));
                } catch (pushErr) {
                    if (typeof console !== "undefined" && console.error) {
                        console.error(
                            "AgentChain.stream: failed to push error event",
                            pushErr
                        );
                    }
                }
            } finally {
                try {
                    console.log(
                        "[AgentChain.stream] finally: calling resetChat…"
                    );
                    const eng = await this.model.getEngine();
                    await webLlmResetChat(eng);
                    console.log(
                        "[AgentChain.stream] finally: resetChat completed."
                    );
                } catch (rcErr) {
                    console.warn(
                        "[AgentChain.stream] finally: resetChat failed:",
                        rcErr
                    );
                }
                finishQueue();
            }
        })();

        return queue;
    }

    createChain() {
        return RunnableLambda.from(async (input: ChainInput) => {
            const { queue } = input;
            try {
                const locationType = (input?.location?.pathname || "").includes(
                    "/dataset/"
                )
                    ? "DATASET_PAGE"
                    : (input?.location?.pathname || "").includes(
                          "/distribution/"
                      )
                    ? "DISTRIBUTION_PAGE"
                    : "OTHERS";

                if (locationType !== "OTHERS") {
                    const nextVersionKey = makeDatasetProfileVersionKey(input);
                    const hasValidProfile =
                        input.keyContextData.datasetProfile &&
                        input.keyContextData.datasetProfileVersionKey ===
                            nextVersionKey;
                    if (!hasValidProfile) {
                        const baseProfile = buildDatasetProfileBase(input);
                        input.keyContextData.datasetProfile = baseProfile;
                        input.keyContextData.datasetProfileVersionKey = nextVersionKey;
                        input.keyContextData.datasetProfileUpdatedAt = Date.now();
                    }
                    const profile = input.keyContextData.datasetProfile;
                    if (profile && profile.tabular.status === "not_loaded") {
                        await enrichTabularProfile(input, profile);
                        input.keyContextData.datasetProfileUpdatedAt = Date.now();
                    }
                    if (profile && profile.spatial.status === "not_loaded") {
                        await enrichSpatialProfile(input, profile);
                        input.keyContextData.datasetProfileUpdatedAt = Date.now();
                    }
                }

                if (input.warmupOnly) {
                    queue.push(
                        createChatEventRunLogMsg(
                            "Warmup complete (profile enrichment only; LLM skipped).",
                            "System Logs"
                        )
                    );
                    return;
                }

                const routeDecision = await decideChatRoute(input);
                queue.push(
                    createChatEventRunLogMsg(
                        `Router action: ${routeDecision.action}. ${routeDecision.reason}`,
                        "System Logs"
                    )
                );
                const spatialIntentResult: SpatialIntentResult = routeDecision.spatialIntent || {
                    route: "unknown",
                    confidence: 0,
                    reason: "Spatial router was not run.",
                    source: "fallback",
                    reference: { type: "none" }
                };
                (input as ChainInput & {
                    __geoIntent?: SpatialIntentResult;
                }).__geoIntent = spatialIntentResult;
                if (this.debug) {
                    console.log("route decision:", routeDecision);
                }

                const tools = await createTools(input);
                if (this.debug) {
                    console.log("available tools: ", tools);
                }

                const geoTool = tools.find(
                    (tool) => tool?.name === "queryGeoDataset"
                );
                const queryDatasetTool = tools.find(
                    (tool) => tool?.name === "queryDataset"
                );
                const defaultAgentTool = tools.find(
                    (tool) => tool?.name === "defaultAgent"
                );

                if (locationType !== "OTHERS") {
                    if (
                        routeDecision.action === "default_agent" &&
                        defaultAgentTool
                    ) {
                        const defaultValue = await defaultAgentTool.func.call(
                            input
                        );
                        if (
                            typeof defaultValue !== "undefined" &&
                            defaultValue !== null
                        ) {
                            return `${defaultValue}`;
                        }
                        return;
                    }

                    if (routeDecision.action === "spatial_sql" && geoTool) {
                        const geoValue = await geoTool.func.call(input);
                        if (
                            typeof geoValue !== "undefined" &&
                            geoValue !== null
                        ) {
                            return `${geoValue}`;
                        }
                        return;
                    }

                    if (
                        routeDecision.action === "tabular_sql" &&
                        queryDatasetTool
                    ) {
                        const sqlValue = await queryDatasetTool.func.call(
                            input
                        );
                        if (
                            typeof sqlValue !== "undefined" &&
                            sqlValue !== null
                        ) {
                            return `${sqlValue}`;
                        }
                        return;
                    }

                    if (
                        routeDecision.action === "llm_auto" &&
                        defaultAgentTool
                    ) {
                        const defaultValue = await defaultAgentTool.func.call(
                            input
                        );
                        if (
                            typeof defaultValue !== "undefined" &&
                            defaultValue !== null
                        ) {
                            return `${defaultValue}`;
                        }
                        return;
                    }
                }

                if (
                    locationType === "OTHERS" &&
                    routeDecision.action === "search_datasets"
                ) {
                    const searchTool = tools.find(
                        (tool) => tool?.name === "searchDatasets"
                    );
                    if (searchTool) {
                        const searchValue = await searchTool.func.call(
                            input,
                            input.question
                        );
                        if (
                            typeof searchValue !== "undefined" &&
                            searchValue !== null
                        ) {
                            return `${searchValue}`;
                        }
                    }
                }
                const result = await this.model.invokeTool(
                    input.question,
                    tools,
                    input
                );
                const value = result?.value;
                if (typeof value === "undefined" || value === null) {
                    return;
                }
                return `${value}`;
            } catch (e) {
                queue.push(createChatEventMessageErrorMsg(e as Error));
                return;
            }
        });
    }
}

export default AgentChain;
