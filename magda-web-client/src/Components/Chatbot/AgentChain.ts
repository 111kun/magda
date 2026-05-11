import { v4 as uuidv4 } from "uuid";
import { ChainInput, KeyContextData } from "./commons";
import { InitProgressCallback, InitProgressReport } from "@mlc-ai/web-llm";
import { BaseMessage, AIMessage } from "@langchain/core/messages";
import { Runnable, RunnableLambda } from "@langchain/core/runnables";
import ChatWebLLM, { WebLLMInputs } from "./ChatWebLLM";
import AsyncQueue from "@ai-zen/async-queue";
import {
    CommonInputType,
    ChatEventMessage,
    createChatEventMessage,
    EVENT_TYPE_PARTIAL_MSG,
    EVENT_TYPE_PARTIAL_MSG_FINISH,
    EVENT_TYPE_ERROR,
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
import {
    classifySpatialIntent,
    SpatialIntentResult
} from "./spatialIntentRouter";

function hasGreetingIntent(question: string): boolean {
    const text = (question || "").trim().toLowerCase();
    if (!text) {
        return false;
    }
    return /^(hi|hello|hey|你好|您好|嗨|哈喽|早上好|下午好|晚上好)\b/.test(
        text
    );
}

function hasDatasetDescriptionIntent(question: string): boolean {
    const text = (question || "").toLowerCase();
    if (!text.trim()) {
        return false;
    }
    return (
        /(当前数据集|这个数据集|数据集说明|字段|列名|样例|示例数据|统计|schema|column|columns|field|fields)/.test(
            text
        ) ||
        /\b(dataset|metadata|describe|description|sample rows)\b/.test(text)
    );
}

function hasSpatialMetadataIntent(question: string): boolean {
    const text = (question || "").toLowerCase();
    if (!text.trim()) {
        return false;
    }
    return (
        /(几何|空间范围|坐标系|投影|bbox|边界|覆盖范围|srid)/.test(text) ||
        /\b(geometry|geometries|extent|bbox|srid|coverage)\b/.test(text)
    );
}

function hasAnalysisIntent(
    question: string,
    confirmedSpatialIntent = false
): boolean {
    const text = (question || "").toLowerCase().trim();
    if (!text) {
        return false;
    }
    return (
        confirmedSpatialIntent ||
        /(分析|查询|统计|筛选|过滤|聚合|分组|计数|排序|top|按.*统计|计算|对比|sql)/.test(
            text
        ) ||
        /\b(analy[sz]e|analysis|query|filter|where|group by|count|sum|avg|min|max|top\s*\d+|compare|sql)\b/.test(
            text
        )
    );
}

function formatSpatialReferenceForLog(result: SpatialIntentResult): string {
    const ref = result.reference;
    if (!ref || ref.type === "none") {
        return "reference=none";
    }
    if (ref.type === "internal") {
        return `reference=internal ${ref.key}=${ref.value}`;
    }
    return `reference=external ${ref.place}`;
}

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
    static removeLLMLoadProgressCallback(callback: InitProgressCallback) {
        const index = AgentChain.llmLoadProgressCallbacks.indexOf(callback);
        if (index !== -1) {
            AgentChain.llmLoadProgressCallbacks.splice(index, 1);
        }
    }

    public model: ChatWebLLM;
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

    constructor(
        appName: string,
        navLocation: Location,
        navHistory: History,
        dataset: ParsedDataset | undefined,
        distribution: ParsedDistribution | undefined,
        loadProgressCallback?: InitProgressCallback
    ) {
        this.loadProgressCallback = loadProgressCallback;
        this.model = ChatWebLLM.createDefaultModel({
            loadProgressCallback: this.onProgress.bind(this)
        });
        this.appName = appName;
        this.navHistory = navHistory;
        this.navLocation = navLocation;
        this.dataset = dataset;
        this.distribution = distribution;
        this.chain = this.createChain();
        // for debug purpose;
        (window as any).chatBotAgentChain = this;
    }

    async updateModelConfig(
        modelConfig: Partial<WebLLMInputs>,
        errorHandler: (e) => void
    ) {
        this.onProgress({
            progress: 0,
            timeElapsed: 0,
            text: "Unloading model in order to apply new model config..."
        });
        this.model.getEngine().then((engine) => engine.unload());
        this.model = ChatWebLLM.createDefaultModel({
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

    async stream(question: string): Promise<AsyncIterable<ChatEventMessage>> {
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
            keyContextData: this.keyContextData
        };

        new Promise(async (resolve, reject) => {
            const msgId = uuidv4();
            let buffer = "";
            let partialMsgSent = false;

            const stream = await (this.directModelAccess
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
            queue.done();
            if (this.debug) {
                this.chatHistory.push(new AIMessage({ content: buffer }));
            }
            if (this.directModelAccess) {
                console.log(buffer);
            }
            resolve(buffer);
        }).catch((e) => {
            createChatEventMessage(EVENT_TYPE_ERROR, {
                error: e
            });
        });
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

                let spatialIntentResult: SpatialIntentResult = {
                    route: "unknown",
                    confidence: 0,
                    reason: "Spatial router was not run.",
                    source: "fallback",
                    reference: { type: "none" }
                };
                if (
                    locationType !== "OTHERS" &&
                    !hasGreetingIntent(input.question)
                ) {
                    spatialIntentResult = await classifySpatialIntent(input);
                    (input as ChainInput & {
                        __geoIntent?: SpatialIntentResult;
                    }).__geoIntent = spatialIntentResult;
                    queue.push(
                        createChatEventRunLogMsg(
                            `Spatial router: ${spatialIntentResult.route} (${
                                spatialIntentResult.source
                            }, confidence=${spatialIntentResult.confidence.toFixed(
                                2
                            )}, ${formatSpatialReferenceForLog(
                                spatialIntentResult
                            )}). ${spatialIntentResult.reason}`,
                            "System Logs"
                        )
                    );
                    if (this.debug) {
                        console.log(
                            "spatial intent route:",
                            spatialIntentResult
                        );
                    }
                }
                const confirmedSpatialIntent =
                    spatialIntentResult.route === "spatial";

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
                        (hasGreetingIntent(input.question) ||
                            (spatialIntentResult.route === "non_spatial" &&
                                !hasAnalysisIntent(input.question, false))) &&
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

                    if (confirmedSpatialIntent && geoTool) {
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
                        spatialIntentResult.route !== "unknown" &&
                        hasAnalysisIntent(
                            input.question,
                            confirmedSpatialIntent
                        ) &&
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
                        spatialIntentResult.route !== "unknown" &&
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
                    !hasGreetingIntent(input.question)
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
