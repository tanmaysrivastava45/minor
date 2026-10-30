import { v4 as uuidv4 } from "uuid";
import { Document } from "@langchain/core/documents";
import EpisodicMemory from "../models/episodicMemory.model.js";
import { getVectorStore, getUserRetriever } from "../db/qdrant.js";
import {
  calculateExpiry,
  getDecayStatus,
  onMemoryAccess,
  getCleanupFilter,
} from "./temporalDecay.js";
import config from "../config/index.js";

/**
 * Episodic Memory Store
 * Handles storage and retrieval of episodic memories in Qdrant (vectors)
 * with metadata tracked in MongoDB for temporal decay.
 */

// ============================================================================
// STORE
// ============================================================================

/**
 * Store an episodic memory: vector in Qdrant, metadata in MongoDB
 * 
 * @param {object} params
 * @param {string} params.userId
 * @param {string} params.content - The episodic memory text
 * @param {string} params.emotionalValence - "positive" | "neutral" | "negative"
 * @param {string} params.temporalContext - Date or time description
 * @param {string[]} params.entities - Extracted entities
 * @param {number} params.confidence - 0.0-1.0
 * @param {string} params.batchId
 * @param {string[]} params.originalMessages
 * @returns {object} The stored episodic memory document
 */
export async function storeEpisodicMemory({
  userId,
  content,
  emotionalValence = "neutral",
  temporalContext = null,
  entities = [],
  confidence = 0.7,
  batchId = null,
  originalMessages = [],
}) {
  const pointId = uuidv4();
  const { expiryAt, miracleWindowEnd } = calculateExpiry("mutable", "episodic", confidence);

  // Step 1: Store vector in Qdrant
  const vectorStore = await getVectorStore();
  const doc = new Document({
    pageContent: content,
    metadata: {
      userId: userId.toString(),
      pointId,
      emotionalValence,
      temporalContext: temporalContext || new Date().toISOString(),
      entities: entities.join(","),
      confidence,
      createdAt: new Date().toISOString(),
      batchId: batchId || "",
    },
  });

  await vectorStore.addDocuments([doc]);

  // Step 2: Store metadata in MongoDB
  const episodicDoc = await EpisodicMemory.create({
    userId,
    qdrantPointId: pointId,
    content,
    emotionalValence,
    temporalContext: temporalContext || new Date().toISOString(),
    entities,
    confidence,
    expiryAt,
    miracleWindowEnd,
    batchId,
    metadata: {
      originalMessages,
    },
  });

  return episodicDoc;
}

// ============================================================================
// RETRIEVE
// ============================================================================

/**
 * Search episodic memories using vector similarity
 * Applies temporal decay filtering and updates access timestamps
 * 
 * @param {string} userId
 * @param {string} query - The search query
 * @param {number} topK - Number of results to return
 * @returns {object[]} Array of { vectorResult, metadata }
 */
export async function searchEpisodicMemories(userId, query, topK = null) {
  const k = topK || config.retrieval.vectorTopK;

  // Step 1: Vector search in Qdrant (user-scoped)
  const retriever = await getUserRetriever(userId, k * 2); // Fetch extra to filter decayed
  const vectorResults = await retriever.invoke(query);

  if (!vectorResults || vectorResults.length === 0) {
    return [];
  }

  // Step 2: Enrich with MongoDB metadata and apply temporal decay
  const results = [];
  for (const vr of vectorResults) {
    const pointId = vr.metadata?.pointId;
    if (!pointId) continue;

    const mongoDoc = await EpisodicMemory.findOne({
      qdrantPointId: pointId,
      userId,
    }).lean();

    if (!mongoDoc) {
      // Vector exists but no metadata — include only if it provably belongs to this user
      if (vr.metadata?.userId !== userId.toString()) continue;
      results.push({
        content: vr.pageContent,
        metadata: vr.metadata,
        source: "vector_only",
      });
      continue;
    }

    // Check temporal decay status
    const status = getDecayStatus(mongoDoc);
    if (status === "dead" || status === "expired") {
      continue; // Skip fully expired
    }

    // Update access (and rescue if in miracle window)
    const updates = onMemoryAccess(mongoDoc);
    await EpisodicMemory.findByIdAndUpdate(mongoDoc._id, { $set: updates });

    results.push({
      content: vr.pageContent,
      metadata: {
        ...mongoDoc,
        ...updates,
        _rescued: status === "miracle_window",
      },
      source: "enriched",
    });

    if (results.length >= k) break;
  }

  return results;
}

/**
 * Fetch all active episodic memories for a user (non-vector search)
 * Used for batch operations and graph correlation
 * 
 * @param {string} userId
 * @returns {object[]}
 */
export async function fetchAllEpisodicMemories(userId) {
  return EpisodicMemory.find({
    userId,
    isExpired: false,
    $or: [
      { expiryAt: { $gte: new Date() } },
      { miracleWindowEnd: { $gte: new Date() } },
    ],
  })
    .sort({ createdAt: -1 })
    .lean();
}

// ============================================================================
// CLEANUP
// ============================================================================

/**
 * Mark episodic memories past their miracle window as expired
 * Note: Qdrant vectors are kept (they won't match future filtered queries)
 * 
 * @returns {number} Count of memories marked expired
 */
export async function cleanupExpiredEpisodicMemories() {
  const result = await EpisodicMemory.updateMany(getCleanupFilter(), {
    $set: { isExpired: true },
  });
  return result.modifiedCount;
}

export default {
  storeEpisodicMemory,
  searchEpisodicMemories,
  fetchAllEpisodicMemories,
  cleanupExpiredEpisodicMemories,
};
