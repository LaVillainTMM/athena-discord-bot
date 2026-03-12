
import { summarizeChannel } from "../memory/conversationSummarizer.js";
import { createGoal } from "../strategy/athenaGoalManager.js";

export async function runAthenaReflection(channelId) {

    const summary = await summarizeChannel(channelId);

    if (summary.includes("bug") || summary.includes("error")) {

        await createGoal(
            "Improve debugging assistance in this server"
        );

    }

}
