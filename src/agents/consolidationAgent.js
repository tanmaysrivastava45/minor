import { v4 as uuidv4 } from "uuid";
import { classifyMemoryBatch } from "./tools/classifyMemory.tool.js";
import { extractFactualMemories } from "./tools/extractFactual.tool.js";
import { extractEpisodicMemories } from "./tools/extractEpisodic.tool.js";
import { extractRelations } from "./tools/extractRelations.tool.js";
import { storeFactualMemory } from "../memory/factualStore.js";
import { storeEpisodicMemory } from "../memory/episodicStore.js";
import {
  ensureUserNode,
  addRelations,
  updateRelationsFromEpisodic,
} from "../memory/graphStore.js";

/**
 * Consolidation Agent
 * 
 * Processes a batch of 30 messages through the full memory consolidation pipeline:
 * 1. Classify which messages contain long-term memory material
 * 2. Extract factual memories
 * 3. Extract episodic memories
 * 4. Extract graph relations from episodes
 * 5. Store everything with conflict resolution
 * 6. Update knowledge graph
 * 
 * This mimics the brain's hippocampal "sleep replay" consolidation process.
 */

/**
 * Run the full consolidation pipeline on a batch of messages
 * 
 * @param {string} userId
 * @param {object[]} messages - Array of { role, content, timestamp }
 * @param {number} batchNumber - Which batch this is (1, 2, 3, ...)
 * @returns {object} Consolidation report
 */
export async function consolidateBatch(userId, messages, batchNumber = 1) {
  const batchId = `batch_${userId}_${batchNumber}_${uuidv4().slice(0, 8)}`;
  const report = {
    batchId,
    userId,
    batchNumber,
    totalMessages: messages.length,
    classifications: [],
    factualMemories: { extracted: 0, stored: 0, conflicts: [] },
    episodicMemories: { extracted: 0, stored: 0 },
    graphRelations: { extracted: 0, stored: 0 },
    errors: [],
  };

  console.log(`\n🧠 [Consolidation] Starting batch ${batchNumber} for user ${userId} (${messages.length} messages)`);

  try {
    // Step 0: Ensure user node exists in graph
    await ensureUserNode(userId);

    // Step 1: Classify messages
    console.log("  📋 Classifying messages...");
    const indexedMessages = messages.map((m, i) => ({
      ...m,
      index: i,
    }));

    const classifications = await classifyMemoryBatch(indexedMessages);
    report.classifications = classifications;

    // Separate classified messages by type
    const factualMessages = [];
    const episodicMessages = [];

    for (const cls of classifications) {
      if (!cls || cls.type === "none") continue;

      const relevantMsgs = (cls.indices || [])
        .map((i) => indexedMessages[i])
        .filter(Boolean);

      if (cls.type === "factual" || cls.type === "both") {
        factualMessages.push(...relevantMsgs);
      }
      if (cls.type === "episodic" || cls.type === "both") {
        episodicMessages.push(...relevantMsgs);
      }
    }

    console.log(`  ✅ ${factualMessages.length} factual candidates, ${episodicMessages.length} episodic candidates`);

    // Step 2: Extract factual memories
    if (factualMessages.length > 0) {
      console.log("  🔍 Extracting factual memories...");
      const facts = await extractFactualMemories(factualMessages);
      report.factualMemories.extracted = facts.length;

      for (const fact of facts) {
        try {
          const result = await storeFactualMemory({
            userId,
            fact: fact.fact,
            category: fact.category,
            hardness: fact.hardness || "mutable",
            confidence: fact.confidence || 0.7,
            source: fact.source || "explicit",
            entities: fact.entities || [],
            batchId,
            originalMessage: factualMessages.map((m) => m.content).join(" | "),
          });

          if (result.stored) {
            report.factualMemories.stored++;
          }
          if (
            result.action === "CONFLICT_KEPT_EXISTING" ||
            result.action === "SUPERSEDED"
          ) {
            report.factualMemories.conflicts.push({
              fact: fact.fact,
              action: result.action,
              reason: result.reason,
            });
          }
        } catch (error) {
          report.errors.push({
            stage: "factual_storage",
            fact: fact.fact,
            error: error.message,
          });
        }
      }
      console.log(`  ✅ ${report.factualMemories.stored}/${facts.length} factual memories stored`);
    }

    // Step 3: Extract episodic memories
    if (episodicMessages.length > 0) {
      console.log("  🎬 Extracting episodic memories...");
      const episodes = await extractEpisodicMemories(episodicMessages);
      report.episodicMemories.extracted = episodes.length;

      for (const episode of episodes) {
        try {
          await storeEpisodicMemory({
            userId,
            content: episode.content,
            emotionalValence: episode.emotionalValence || "neutral",
            temporalContext: episode.temporalContext,
            entities: episode.entities || [],
            confidence: episode.confidence || 0.7,
            batchId,
            originalMessages: episodicMessages.map((m) => m.content),
          });
          report.episodicMemories.stored++;
        } catch (error) {
          report.errors.push({
            stage: "episodic_storage",
            episode: episode.content,
            error: error.message,
          });
        }
      }
      console.log(`  ✅ ${report.episodicMemories.stored}/${episodes.length} episodic memories stored`);

      // Step 4: Extract and store graph relations from episodes
      console.log("  🔗 Extracting graph relations...");
      const relations = await extractRelations(episodes, userId);
      report.graphRelations.extracted = relations.length;

      if (relations.length > 0) {
        try {
          await updateRelationsFromEpisodic(userId, relations);
          report.graphRelations.stored = relations.length;
          console.log(`  ✅ ${relations.length} graph relations updated`);
        } catch (error) {
          report.errors.push({
            stage: "graph_update",
            error: error.message,
          });
        }
      }
    }

    console.log(`\n🧠 [Consolidation] Batch ${batchNumber} complete!`);
    console.log(`  📊 Facts: ${report.factualMemories.stored}, Episodes: ${report.episodicMemories.stored}, Relations: ${report.graphRelations.stored}`);
    if (report.factualMemories.conflicts.length > 0) {
      console.log(`  ⚠️  ${report.factualMemories.conflicts.length} conflicts resolved`);
    }
    if (report.errors.length > 0) {
      console.log(`  ❌ ${report.errors.length} errors`);
    }

    return report;
  } catch (error) {
    console.error(`❌ [Consolidation] Batch ${batchNumber} failed:`, error.message);
    report.errors.push({ stage: "pipeline", error: error.message });
    return report;
  }
}

export default { consolidateBatch };
