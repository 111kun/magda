import { ChainInput, getLocationType } from "../commons";
import defaultAgent from "./defaultAgent";
import searchDatasets from "./searchDatasets";
import { createQueryDatasetTool } from "./queryDataset";
import { createQueryGeoDatasetTool } from "./queryGeoDataset";
import { WebLLMTool } from "../ChatWebLLM";
import { createPresentPreviousQueryResultAsChartTool } from "./presentPreviousQueryResultAsChart";

/**
 * Tools exposed on dataset / distribution pages for AgentChain + WebLLM.invokeTool.
 * Keep in sync with AgentChain.ts lookups: queryDataset, queryGeoDataset, defaultAgent,
 * searchDatasets (presentPreviousQueryResultAsChart is LLM-only, no deterministic branch).
 */
async function createDatasetOrDistributionTools(
    input: ChainInput
): Promise<WebLLMTool[]> {
    return [
        await createQueryDatasetTool(input),
        await createQueryGeoDatasetTool(input),
        await createPresentPreviousQueryResultAsChartTool(input),
        searchDatasets,
        defaultAgent
    ].filter((item) => !!item) as WebLLMTool[];
}

async function createTools(input: ChainInput): Promise<WebLLMTool[]> {
    const type = getLocationType(input.location);
    switch (type) {
        case "DATASET_PAGE":
        case "DISTRIBUTION_PAGE":
            return createDatasetOrDistributionTools(input);
        default:
            return [searchDatasets, defaultAgent];
    }
}

export default createTools;
