import { Location } from "history";
import { v4 as uuidv4 } from "uuid";
import {
    ChatPromptTemplate,
    SystemMessagePromptTemplate,
    HumanMessagePromptTemplate
} from "@langchain/core/prompts";
import { StringOutputParser } from "@langchain/core/output_parsers";
import { ChainInput, getLocationType } from "../commons";
import {
    EVENT_TYPE_PARTIAL_MSG,
    EVENT_TYPE_PARTIAL_MSG_FINISH,
    createChatEventMessage
} from "../Messaging";
import ChatWebLLM, { WebLLMTool } from "../ChatWebLLM";

const systemPromptTpl = SystemMessagePromptTemplate.fromTemplate(
    `You are a friendly AI agent named "{appName}". \n` +
        `You should greet the user and offer system usage information based on the user message and the available functions below: \n ` +
        `{toolList}\n` +
        `Current dataset context (if available):\n` +
        `{datasetContext}`
);

function createDatasetContext(context: ChainInput): string {
    const profile = context.keyContextData?.datasetProfile;
    if (!profile) {
        return "N/A";
    }
    const tabularSummary =
        profile.tabular?.items?.length > 0
            ? profile.tabular.items
                  .map((item) => {
                      const cols = item.columns?.slice(0, 6).join(", ");
                      return `[tabular:${item.distributionIndex}] ${
                          item.title
                      } columns=${cols || "N/A"}`;
                  })
                  .join("\n")
            : "N/A";
    const spatialSummary =
        profile.spatial?.items?.length > 0
            ? profile.spatial.items
                  .map((item) => {
                      const keys = item.propertyKeys?.slice(0, 8).join(", ");
                      const geom = item.geometryTypes?.slice(0, 4).join(", ");
                      return `[spatial:${item.distributionIndex}] ${
                          item.title
                      } keys=${keys || "N/A"} geom=${geom || "N/A"}`;
                  })
                  .join("\n")
            : "N/A";
    return `tabular:\n${tabularSummary}\nspatial:\n${spatialSummary}`;
}

function createToolList(location: Location): string {
    const type = getLocationType(location);
    switch (type) {
        case "DATASET_PAGE":
            return (
                "- Search dataset tool: search and return relevant datasets based on the user inquiry.\n" +
                "- Tabular data analysis tool: When one of tabular data file of the current dataset is relevant to the user inquiry. " +
                "This tool will be used to answer the user inquiry with tabular data analysis result."
            );
        case "DISTRIBUTION_PAGE":
            return (
                "- Search dataset tool: search and return relevant datasets based on the user inquiry.\n" +
                "- Tabular data analysis tool: When one of tabular data file of the current dataset distribution is relevant to the user inquiry. " +
                "This tool will be used to answer the user inquiry with tabular data analysis result."
            );
        default:
            return "- Search dataset tool: search and return relevant datasets based on the user inquiry.";
    }
}

const defaultAgent: WebLLMTool = {
    name: "defaultAgent",
    func: async function () {
        const context = (this as unknown) as ChainInput;
        const { model: chatLlm, queue, location } = context;
        if (!(chatLlm instanceof ChatWebLLM)) {
            throw new Error(
                "defaultAgent requires the WebLLM backend (streaming). Use WebLLM on the eval page or a tool-specific path."
            );
        }
        const prompt = ChatPromptTemplate.fromMessages([
            systemPromptTpl,
            HumanMessagePromptTemplate.fromTemplate("{question}")
        ]);
        const defaultAgentChain = prompt
            .pipe(chatLlm)
            .pipe(new StringOutputParser());

        const stream = await defaultAgentChain.stream({
            ...context,
            toolList: createToolList(location),
            datasetContext: createDatasetContext(context)
        });
        const msgId = uuidv4();
        let partialMsgSent = false;
        for await (const chunk of stream) {
            queue.push(
                createChatEventMessage(EVENT_TYPE_PARTIAL_MSG, {
                    id: msgId,
                    msg: chunk
                })
            );
            partialMsgSent = true;
        }
        if (partialMsgSent) {
            queue.push(
                createChatEventMessage(EVENT_TYPE_PARTIAL_MSG_FINISH, {
                    id: msgId
                })
            );
        }
    },
    description:
        "this tool can be used to serve general user conversations or greetings. \n" +
        'e.g. You should use this toole, when the user say "hello" or "how are you?" \n' +
        "Or when the user asks for help / system usage information. \n" +
        'e.g. when the user asks "how to use the system" or "what\'re the functionalities / features of the system?".'
};

export default defaultAgent;
