import FactualMemory from "../models/factualMemory.model.js";
import {
  calculateExpiry,
  getDecayStatus,
  onMemoryAccess,
  resolveConflict,
  getCleanupFilter,
} from "./temporalDecay.js";
import config from "../config/index.js";

/**
 * Factual Memory Store
 * Handles CRUD operations for factual memories in MongoDB
 * with conflict detection, deduplication, and temporal decay management.
 */

// ============================================================================
// STORE / UPSERT
// ============================================================================

/**
 * Store a new factual memory, handling conflicts with existing memories
 * 
 * @param {object} params
 * @param {string} params.userId
 * @param {string} params.fact
 * @param {string} params.category
 * @param {string} params.hardness
 * @param {number} params.confidence
 * @param {string} params.source
 * @param {string[]} params.entities
 * @param {string} params.batchId
 * @param {string} params.originalMessage
 * @returns {object} { stored: boolean, memory: object, action: string, reason: string }
 */
export async function storeFactualMemory({
  userId,
  fact,
  category,
  hardness = "mutable",
  confidence = 0.7,
  source = "explicit",
  entities = [],
  batchId = null,
  originalMessage = null,
}) {
  // Step 1: Search for potential conflicts — existing facts in the same category with similar entities
  const existingMemories = await FactualMemory.find({
    userId,
    category,
    isExpired: false,
    isSuperseded: false,
    "metadata.entities": { $in: entities.length > 0 ? entities : ["__none__"] },
  }).sort({ confidence: -1 });

  // Step 2: Check for exact duplicates
  const exactDuplicate = existingMemories.find(
    (m) => m.fact.toLowerCase().trim() === fact.toLowerCase().trim()
  );
  if (exactDuplicate) {
    // Strengthen existing memory instead of duplicating
    const updates = onMemoryAccess(exactDuplicate);
    await FactualMemory.findByIdAndUpdate(exactDuplicate._id, {
      $set: updates,
      $inc: { accessCount: 1 },
    });
    return {
      stored: false,
      memory: exactDuplicate,
      action: "DEDUPLICATED",
      reason: "Exact duplicate found — existing memory strengthened.",
    };
  }

  // Step 3: Check for semantic conflicts (facts about the same entity/attribute)
  const newMemory = { fact, category, hardness, confidence, source, createdAt: new Date(), accessCount: 0 };
  
  for (const existing of existingMemories) {
    // Simple heuristic: if same category and overlapping entities, likely a conflict
    const overlap = entities.some(
      (e) => existing.metadata?.entities?.includes(e)
    );
    if (overlap && existing.category === category) {
      const { decision, reason } = resolveConflict(newMemory, existing);

      if (decision === "KEEP_EXISTING") {
        return {
          stored: false,
          memory: existing,
          action: "CONFLICT_KEPT_EXISTING",
          reason,
        };
      }

      if (decision === "SUPERSEDE") {
        // Mark old memory as superseded
        const { expiryAt, miracleWindowEnd } = calculateExpiry(hardness, "factual", confidence);
        const newDoc = await FactualMemory.create({
          userId,
          fact,
          category,
          hardness,
          confidence,
          source,
          expiryAt,
          miracleWindowEnd,
          metadata: {
            extractedFrom: batchId,
            entities,
            supersedes: existing._id,
            originalMessage,
            version: (existing.metadata?.version || 1) + 1,
          },
        });

        // Mark old as superseded
        await FactualMemory.findByIdAndUpdate(existing._id, {
          $set: {
            isSuperseded: true,
            "metadata.supersededBy": newDoc._id,
          },
        });

        return {
          stored: true,
          memory: newDoc,
          action: "SUPERSEDED",
          reason,
        };
      }

      // KEEP_BOTH — fall through to normal creation
    }
  }

  // Step 4: No conflict — create new memory
  const { expiryAt, miracleWindowEnd } = calculateExpiry(hardness, "factual", confidence);
  const memory = await FactualMemory.create({
    userId,
    fact,
    category,
    hardness,
    confidence,
    source,
    expiryAt,
    miracleWindowEnd,
    metadata: {
      extractedFrom: batchId,
      entities,
      originalMessage,
      version: 1,
    },
  });

  return {
    stored: true,
    memory,
    action: "CREATED",
    reason: "New factual memory stored.",
  };
}

// ============================================================================
// RETRIEVE
// ============================================================================

/**
 * Fetch all active factual memories for a user
 * Applies temporal decay checks and updates access timestamps
 * 
 * @param {string} userId
 * @param {object} options
 * @param {string} options.category - Filter by category
 * @param {string[]} options.entities - Filter by entities
 * @param {boolean} options.includeExpired - Include expired (in miracle window)
 * @returns {object[]} Array of factual memories
 */
export async function fetchFactualMemories(userId, options = {}) {
  const filter = {
    userId,
    isSuperseded: false,
  };

  if (!options.includeExpired) {
    // Include active + miracle window memories (not fully dead)
    filter.$or = [
      { isExpired: false, expiryAt: { $gte: new Date() } },
      { isExpired: false, miracleWindowEnd: { $gte: new Date() } },
    ];
  } else {
    filter.isExpired = false;
  }

  if (options.category) {
    filter.category = options.category;
  }

  if (options.entities && options.entities.length > 0) {
    filter["metadata.entities"] = { $in: options.entities };
  }

  const memories = await FactualMemory.find(filter)
    .sort({ confidence: -1, lastAccessedAt: -1 })
    .limit(config.retrieval.maxFactualResults)
    .lean();

  // Update access timestamps and apply temporal decay for each retrieved memory
  const updatedMemories = [];
  for (const memory of memories) {
    const status = getDecayStatus(memory);

    if (status === "expired" || status === "dead") {
      continue; // Skip fully expired memories
    }

    if (status === "miracle_window") {
      // Rescue the memory!
      const updates = onMemoryAccess(memory);
      await FactualMemory.findByIdAndUpdate(memory._id, { $set: updates });
      updatedMemories.push({ ...memory, ...updates, _rescued: true });
    } else {
      // Active — update access
      const updates = onMemoryAccess(memory);
      await FactualMemory.findByIdAndUpdate(memory._id, { $set: updates });
      updatedMemories.push({ ...memory, ...updates });
    }
  }

  return updatedMemories;
}

/**
 * Search factual memories by text query (simple text matching)
 * For semantic search, use the episodic store + vector DB
 * 
 * @param {string} userId
 * @param {string} query
 * @returns {object[]}
 */
export async function searchFactualMemories(userId, query) {
  const keywords = query
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 2);

  const regexPatterns = keywords.map((k) => new RegExp(k, "i"));

  return FactualMemory.find({
    userId,
    isSuperseded: false,
    isExpired: false,
    $or: [
      { fact: { $in: regexPatterns } },
      { "metadata.entities": { $in: keywords } },
    ],
  })
    .sort({ confidence: -1 })
    .limit(config.retrieval.maxFactualResults)
    .lean();
}

// ============================================================================
// CLEANUP
// ============================================================================

/**
 * Mark memories past their miracle window as expired
 * Run this periodically (e.g., daily) for housekeeping
 * 
 * @returns {number} Count of memories marked expired
 */
export async function cleanupExpiredMemories() {
  const result = await FactualMemory.updateMany(getCleanupFilter(), {
    $set: { isExpired: true },
  });
  return result.modifiedCount;
}

export default {
  storeFactualMemory,
  fetchFactualMemories,
  searchFactualMemories,
  cleanupExpiredMemories,
};
