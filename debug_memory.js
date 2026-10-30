import "dotenv/config";
import { initCortexMemory, shutdownCortexMemory, batchLoadMessages, queryMemory } from "./src/index.js";
import MessageBuffer from "./src/models/messageBuffer.model.js";
import FactualMemory from "./src/models/factualMemory.model.js";
import mongoose from "mongoose";
import qdrantClient from "./src/db/qdrant.js";
import neo4jDriver from "./src/db/neo4j.js";

async function runDiagnostics() {
  console.log("Starting diagnostics...");
  await initCortexMemory();

  const userId = "debug_user_" + Date.now();
  console.log("Using User ID:", userId);

  const messages = [
    { role: "user", content: "Hi, I am Arjun Mehta and I love playing the guitar." },
    { role: "assistant", content: "Nice to meet you, Arjun! How long have you been playing?" },
    { role: "user", content: "Since I was 15." }
  ];

  console.log("\n--- Injecting messages directly into buffer (simulating stream) ---");
  await batchLoadMessages(userId, messages);

  // Check MongoDB buffer
  const bufferCount = await MessageBuffer.countDocuments({ userId });
  console.log(`Buffer count in Mongo: ${bufferCount}`);

  // Trigger consolidation manually to see what happens
  console.log("\n--- Triggering Consolidation Manually ---");
  const { consolidateBatch } = await import("./src/agents/consolidationAgent.js");

  const bufferedDocs = await MessageBuffer.find({ userId }).sort({ timestamp: 1 });
  const msgs = bufferedDocs.map((d) => ({ role: d.role, content: d.content }));
  console.log("Messages passed to agent:", msgs);

  try {
    const memoryUpdates = await consolidateBatch(userId, msgs);
    console.log("Agent memory updates generated:", JSON.stringify(memoryUpdates, null, 2));

    if (memoryUpdates) {
        const { updateFactualMemory: uf } = await import("./src/memory/factualStore.js");
        const { updateEpisodicMemory: ue } = await import("./src/memory/episodicStore.js");
        const { updateGraphRelations: ug } = await import("./src/memory/graphStore.js");

        if (memoryUpdates.factual && memoryUpdates.factual.length > 0) {
            console.log("Updating Factual...");
            await uf(userId, memoryUpdates.factual);
        }
        if (memoryUpdates.episodic && memoryUpdates.episodic.length > 0) {
            console.log("Updating Episodic...");
            await ue(userId, memoryUpdates.episodic);
        }
        if (memoryUpdates.relations && memoryUpdates.relations.length > 0) {
            console.log("Updating Graph...");
            await ug(userId, memoryUpdates.relations);
        }
    }

  } catch (error) {
    console.error("Consolidation error:", error);
  }

  console.log("\n--- Checking Storage ---");
  const facts = await FactualMemory.find({ userId });
  console.log(`MongoDB Factual Memories: ${facts.length}`);
  console.log(facts);

  try {
    const qCount = await qdrantClient.count(process.env.QDRANT_COLLECTION || "cortex_episodic", {
        filter: { must: [{ key: "userId", match: { value: userId } }] }
    });
    console.log(`Qdrant Episodic Memories:`, qCount);
  } catch (e) { console.error("Qdrant read error:", e.message) }

  try {
    const session = neo4jDriver.session();
    const result = await session.run(`MATCH (u:User {id: $userId})-[r]->(n) RETURN r, n`, { userId });
    console.log(`Neo4j Relations: ${result.records.length}`);
    session.close();
  } catch (e) { console.error("Neo4j read error:", e.message) }

  console.log("\n--- Testing Retrieval Pipeline ---");
  const queryResult = await queryMemory(userId, "What instrument do I play?");
  console.log("queryMemory result:");
  console.log(JSON.stringify(queryResult, null, 2));

  await shutdownCortexMemory();
  console.log("Diagnostics complete.");
}

runDiagnostics().catch(console.error);
