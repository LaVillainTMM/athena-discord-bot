import { getFirestore } from "../firebase.js";

import { summarizeChannel } from "../memory/conversationSummarizer.js";
import { buildPersonalityModel } from "../analysis/personalityProfiler.js";
import { predictUserBehavior } from "../analysis/behaviorPredictor.js";
import { mapRelationships } from "../analysis/relationshipMapper.js";

import { evaluateGoals } from "../strategy/athenaStrategyEngine.js";
import { createGoal } from "../strategy/athenaGoalManager.js";

const db = firestore;

let cognitiveLoopActive = false;

/*
Athena Cognitive Core
---------------------

This system runs Athena's autonomous reasoning loop.

It performs:

• memory summarization
• personality updates
• behavior prediction
• relationship mapping
• goal evaluation
*/

export async function runCognitiveCycle() {

    console.log("[Athena Cognitive Core] Starting cycle...");

    try {

        await runMemoryAnalysis();
        await runPersonalityAnalysis();
        await runBehaviorPredictions();
        await runRelationshipMapping();
        await evaluateGoals();

        console.log("[Athena Cognitive Core] Cycle complete.");

    } catch (error) {

        console.error("[Athena Cognitive Core] Error:", error);

    }

}

/*
Memory Analysis
Summarizes active channels
*/

async function runMemoryAnalysis() {

    const snapshot = await db.collection("messages")
        .limit(50)
        .get();

    const channels = new Set();

    snapshot.forEach(doc => {

        const data = doc.data();

        if (data.channelId) {

            channels.add(data.channelId);

        }

    });

    for (const channelId of channels) {

        await summarizeChannel(channelId);

    }

}

/*
Personality Modeling
Updates personality profiles
*/

async function runPersonalityAnalysis() {

    const snapshot = await db.collection("messages")
        .limit(100)
        .get();

    const users = new Set();

    snapshot.forEach(doc => {

        const data = doc.data();

        if (data.userId) {

            users.add(data.userId);

        }

    });

    for (const userId of users) {

        await buildPersonalityModel(userId);

    }

}

/*
Behavior Prediction
*/

async function runBehaviorPredictions() {

    const snapshot = await db.collection("athena_user_profiles")
        .limit(50)
        .get();

    for (const doc of snapshot.docs) {

        const userId = doc.id;

        const prediction = await predictUserBehavior(userId);

        if (prediction) {

            console.log(
                "[Athena Prediction]",
                userId,
                "→",
                prediction
            );

        }

    }

}

/*
Relationship Mapping
*/

async function runRelationshipMapping() {

    const relationships = await mapRelationships();

    console.log(
        "[Athena Relationship Map]",
        Object.keys(relationships).length,
        "users analyzed"
    );

}

/*
Goal Monitoring
If many errors appear in conversation summaries,
Athena creates a new improvement goal.
*/

export async function analyzeSystemHealth() {

    const snapshot = await db.collection("athena_memory")
        .orderBy("createdAt", "desc")
        .limit(10)
        .get();

    let errorMentions = 0;

    snapshot.forEach(doc => {

        const summary = doc.data().summary || "";

        if (
            summary.includes("error") ||
            summary.includes("bug") ||
            summary.includes("issue")
        ) {

            errorMentions++;

        }

    });

    if (errorMentions >= 3) {

        await createGoal(
            "Improve debugging assistance and technical explanations"
        );

        console.log("[Athena Goal Created] Debugging improvement");

    }

}

/*
Start Autonomous Cognitive Loop
*/

export function startAthenaCognitiveCore(intervalMinutes = 10) {

    if (cognitiveLoopActive) {

        console.log("[Athena Cognitive Core] Already running.");

        return;

    }

    cognitiveLoopActive = true;

    console.log("[Athena Cognitive Core] Activated.");

    runCognitiveCycle();

    setInterval(async () => {

        await runCognitiveCycle();

        await analyzeSystemHealth();

    }, intervalMinutes * 60 * 1000);

}
