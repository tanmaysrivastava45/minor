import { connectMongoDB, disconnectMongoDB } from "./db/mongoose.js";
import { initGraphStore } from "./memory/graphStore.js";
import { getVectorStore } from "./db/qdrant.js";
import {
  processMessage,
  forceConsolidation,
  batchLoadMessages,
  queryMemory,
  clearBuffers,
} from "./controllers/chat.controller.js";
import { cleanupExpiredMemories } from "./memory/factualStore.js";
import { cleanupExpiredEpisodicMemories } from "./memory/episodicStore.js";
import config from "./config/index.js";

/**
 * CortexMemory - Entry Point
 * 
 * A neuroscience-inspired AI memory layer that mimics human brain
 * memory retention patterns for superior long-term conversation memory.
 */

/**
 * Initialize all database connections
 */
export async function initCortexMemory() {
  console.log("\n🧠 ============================================");
  console.log("   CortexMemory - Initializing...");
  console.log("   ============================================\n");

  // Connect to MongoDB
  await connectMongoDB();

  // Initialize Neo4j schema
  try {
    await initGraphStore();
  } catch (error) {
    console.warn("⚠️  Neo4j initialization failed (some features may be limited):", error.message);
  }

  // Initialize Qdrant
  try {
    await getVectorStore();
  } catch (error) {
    console.warn("⚠️  Qdrant initialization failed (some features may be limited):", error.message);
  }

  console.log("\n🧠 CortexMemory initialized successfully!\n");
  console.log(`   Model: ${config.openai.llmModel}`);
  console.log(`   Embeddings: ${config.openai.embeddingModel}`);
  console.log(`   Batch Size: ${config.memory.batchSize}`);
  console.log(`   Expiry (immutable): ${config.temporalDecay.expiry.immutable} days`);
  console.log(`   Expiry (mutable): ${config.temporalDecay.expiry.mutable} days`);
  console.log(`   Miracle Window: ${config.temporalDecay.miracleWindowDays} days\n`);
}

/**
 * Shutdown all connections
 */
export async function shutdownCortexMemory() {
  console.log("\n🧠 CortexMemory shutting down...");
  clearBuffers();
  await disconnectMongoDB();
  // Neo4j driver will close when process exits
  console.log("🧠 CortexMemory shutdown complete.\n");
}

/**
 * Run memory cleanup (should be run periodically)
 * Marks expired memories past their miracle window
 */
export async function runCleanup() {
  console.log("\n🧹 Running memory cleanup...");
  const factualCleaned = await cleanupExpiredMemories();
  const episodicCleaned = await cleanupExpiredEpisodicMemories();
  console.log(`   Cleaned: ${factualCleaned} factual, ${episodicCleaned} episodic memories`);
  return { factualCleaned, episodicCleaned };
}

// Export the public API
export {
  processMessage,
  forceConsolidation,
  batchLoadMessages,
  queryMemory,
  clearBuffers,
};

export default {
  initCortexMemory,
  shutdownCortexMemory,
  runCleanup,
  processMessage,
  forceConsolidation,
  batchLoadMessages,
  queryMemory,
  clearBuffers,
};
