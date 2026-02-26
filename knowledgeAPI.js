// knowledgeAPI.js

import { storeNewKnowledge } from "./lib/knowledgeUpdater.js";

/**
 * Wrapper for storing new knowledge entries
 */
export const knowledgeAPI = {
  storeNewKnowledge: async ({
    title,
    body,
    sourceUserId = null,
    platform = "discord",
    verified = true,
    explanation = null
  }) => {
    try {
      await storeNewKnowledge({
        title,
        body,
        source: sourceUserId ? `user:${sourceUserId}` : "autonomous",
        verified,
        explanation
      });
      console.log("✅ Knowledge stored:", title);
    } catch (err) {
      console.error("❌ Failed to store knowledge:", err);
    }
  }
};
