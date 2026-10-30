import config from "../config/index.js";

const { temporalDecay: decayConfig, confidence: confConfig } = config;

/**
 * CortexMemory Temporal Decay Engine
 * 
 * Inspired by Ebbinghaus forgetting curve and spaced repetition.
 * Implements:
 *   1. Exponential decay of memory relevance over time
 *   2. Miracle window: grace period after expiry where memories can be rescued
 *   3. Confidence scoring based on source, hardness, recency, and access frequency
 *   4. Intelligent conflict resolution with memory hardness awareness
 */

// ============================================================================
// EXPIRY CALCULATION
// ============================================================================

/**
 * Calculate initial expiry date for a memory based on its type and hardness
 * @param {string} hardness - "immutable" | "semi_mutable" | "mutable"
 * @param {string} memoryType - "factual" | "episodic"
 * @param {number} confidence - 0.0 to 1.0
 * @returns {{ expiryAt: Date, miracleWindowEnd: Date }}
 */
export function calculateExpiry(hardness, memoryType, confidence = 0.7) {
  let baseDays;

  if (memoryType === "episodic") {
    baseDays = decayConfig.expiry.episodic;
  } else {
    baseDays = decayConfig.expiry[hardness] || decayConfig.expiry.mutable;
  }

  // Scale expiry by confidence: higher confidence = longer retention
  // Use a floor of 0.5 to prevent extremely short expiries
  const confidenceScale = Math.max(0.5, confidence);
  const adjustedDays = Math.round(baseDays * confidenceScale);

  const now = new Date();
  const expiryAt = new Date(now.getTime() + adjustedDays * 24 * 60 * 60 * 1000);
  const miracleWindowEnd = new Date(
    expiryAt.getTime() + decayConfig.miracleWindowDays * 24 * 60 * 60 * 1000
  );

  return { expiryAt, miracleWindowEnd };
}

// ============================================================================
// DECAY STATUS CHECK
// ============================================================================

/**
 * Determine the current decay status of a memory
 * @param {object} memory - Memory document with expiryAt, miracleWindowEnd, isExpired
 * @returns {"active" | "miracle_window" | "expired" | "dead"}
 */
export function getDecayStatus(memory) {
  const now = new Date();
  const expiry = new Date(memory.expiryAt);
  const miracleEnd = new Date(memory.miracleWindowEnd);

  if (memory.isExpired) return "dead";
  if (now < expiry) return "active";
  if (now >= expiry && now < miracleEnd) return "miracle_window";
  return "expired";
}

// ============================================================================
// MIRACLE WINDOW RESCUE
// ============================================================================

/**
 * Rescue a memory that is accessed during its miracle window.
 * Extends expiry and boosts confidence.
 * 
 * @param {object} memory - The memory document
 * @returns {{ expiryAt: Date, miracleWindowEnd: Date, confidence: number, accessCount: number }}
 */
export function rescueMemory(memory) {
  const accessCount = (memory.accessCount || 0) + 1;

  // Extension scales with access count but has a maximum
  const extensionDays = Math.min(
    decayConfig.rescueExtensionDays * Math.log2(accessCount + 1),
    decayConfig.maxRescueExtensionDays
  );

  const now = new Date();
  const newExpiry = new Date(now.getTime() + extensionDays * 24 * 60 * 60 * 1000);
  const newMiracleEnd = new Date(
    newExpiry.getTime() + decayConfig.miracleWindowDays * 24 * 60 * 60 * 1000
  );

  // Confidence boost, capped at max
  const newConfidence = Math.min(
    (memory.confidence || 0.5) + decayConfig.confidenceRescueBoost,
    decayConfig.maxConfidence
  );

  return {
    expiryAt: newExpiry,
    miracleWindowEnd: newMiracleEnd,
    confidence: newConfidence,
    accessCount,
    lastAccessedAt: now,
  };
}

// ============================================================================
// ACCESS UPDATE (for active memories)
// ============================================================================

/**
 * Update memory metadata when it is accessed (strengthens the memory)
 * Mimics spaced repetition: each access pushes expiry further out
 * 
 * @param {object} memory - The memory document
 * @returns {object} Updated fields
 */
export function onMemoryAccess(memory) {
  const status = getDecayStatus(memory);
  const accessCount = (memory.accessCount || 0) + 1;
  const now = new Date();

  if (status === "miracle_window") {
    // Rescue the memory
    return rescueMemory(memory);
  }

  if (status === "active") {
    // Extend expiry slightly based on access (spaced repetition effect)
    const currentExpiry = new Date(memory.expiryAt);
    const accessBoostDays = Math.min(
      3 * Math.log2(accessCount + 1), // Diminishing returns
      30 // Max boost per access
    );
    const newExpiry = new Date(
      currentExpiry.getTime() + accessBoostDays * 24 * 60 * 60 * 1000
    );
    const newMiracleEnd = new Date(
      newExpiry.getTime() + decayConfig.miracleWindowDays * 24 * 60 * 60 * 1000
    );

    return {
      expiryAt: newExpiry,
      miracleWindowEnd: newMiracleEnd,
      accessCount,
      lastAccessedAt: now,
    };
  }

  // Dead or expired — no update
  return { accessCount, lastAccessedAt: now };
}

// ============================================================================
// CONFIDENCE CALCULATION
// ============================================================================

/**
 * Calculate confidence score for a memory based on multiple factors
 * 
 * @param {object} params
 * @param {number} params.baseConfidence - Initial confidence from extraction (0.0-1.0)
 * @param {string} params.source - "explicit" | "inferred" | "corrected"
 * @param {string} params.hardness - "immutable" | "semi_mutable" | "mutable"
 * @param {number} params.accessCount - How many times this memory has been accessed
 * @param {Date} params.lastAccessedAt - When this memory was last accessed
 * @param {Date} params.createdAt - When this memory was created
 * @returns {number} Calculated confidence 0.0-1.0
 */
export function calculateConfidence({
  baseConfidence = 0.7,
  source = "explicit",
  hardness = "mutable",
  accessCount = 0,
  lastAccessedAt = new Date(),
  createdAt = new Date(),
}) {
  // Source factor
  const sourceFactor = confConfig.sourceFactor[source] || 0.7;

  // Hardness factor (immutable facts inherently have higher confidence)
  const hardnessFactor = confConfig.hardnessFactor[hardness] || 0.65;

  // Recency factor: decays over time since last access
  // Uses a sigmoid-like decay: recent access = ~1.0, old access approaches 0.3
  const daysSinceAccess = Math.max(
    0,
    (Date.now() - new Date(lastAccessedAt).getTime()) / (24 * 60 * 60 * 1000)
  );
  const recencyFactor = 0.3 + 0.7 * Math.exp(-daysSinceAccess / 90);

  // Repetition factor: more accesses = stronger memory
  // Logarithmic growth, caps out around 1.0
  const repetitionFactor = Math.min(1.0, 0.5 + 0.5 * Math.log2(accessCount + 1) / 5);

  // Combined confidence
  let confidence =
    baseConfidence * sourceFactor * hardnessFactor * recencyFactor * repetitionFactor;

  // Clamp
  confidence = Math.max(decayConfig.minConfidence, Math.min(decayConfig.maxConfidence, confidence));

  return Math.round(confidence * 1000) / 1000; // 3 decimal places
}

// ============================================================================
// CONFLICT RESOLUTION
// ============================================================================

/**
 * Resolve a conflict between a new memory and an existing memory.
 * 
 * Returns one of:
 *   - "SUPERSEDE" — new memory replaces old
 *   - "KEEP_EXISTING" — old memory kept, new discarded
 *   - "KEEP_BOTH" — ambiguous, keep both (flag for review)
 * 
 * @param {object} newMemory - The incoming memory
 * @param {object} existingMemory - The already-stored memory
 * @returns {{ decision: string, reason: string }}
 */
export function resolveConflict(newMemory, existingMemory) {
  // Step 1: Hardness Gate — Immutable facts are nearly impossible to override
  if (existingMemory.hardness === "immutable") {
    if (
      newMemory.confidence < confConfig.immutableOverrideThreshold ||
      newMemory.source !== "explicit"
    ) {
      return {
        decision: "KEEP_EXISTING",
        reason: `Existing immutable fact retained. New confidence (${newMemory.confidence}) below threshold (${confConfig.immutableOverrideThreshold}) or source not explicit.`,
      };
    }
    // Very rare: explicit correction with very high confidence overrides immutable
    return {
      decision: "SUPERSEDE",
      reason: `Immutable fact overridden by explicit correction with confidence ${newMemory.confidence}.`,
    };
  }

  // Step 2: Recency for Mutable Facts — latest preference wins
  if (existingMemory.hardness === "mutable") {
    const newDate = new Date(newMemory.createdAt || Date.now());
    const existDate = new Date(existingMemory.createdAt);
    if (newDate > existDate) {
      return {
        decision: "SUPERSEDE",
        reason: `Mutable fact updated: newer memory (${newDate.toISOString()}) supersedes older (${existDate.toISOString()}).`,
      };
    }
  }

  // Step 3: Confidence gap
  const confDiff = (newMemory.confidence || 0.5) - (existingMemory.confidence || 0.5);
  if (confDiff > confConfig.confidenceDifferenceThreshold) {
    return {
      decision: "SUPERSEDE",
      reason: `New memory has significantly higher confidence (+${confDiff.toFixed(2)}).`,
    };
  }
  if (confDiff < -confConfig.confidenceDifferenceThreshold) {
    return {
      decision: "KEEP_EXISTING",
      reason: `Existing memory has significantly higher confidence (+${(-confDiff).toFixed(2)}).`,
    };
  }

  // Step 4: Access frequency dominance
  const existAccess = existingMemory.accessCount || 0;
  const newAccess = newMemory.accessCount || 0;
  if (existAccess > newAccess * confConfig.accessCountDominanceMultiplier) {
    return {
      decision: "KEEP_EXISTING",
      reason: `Existing memory is well-established (${existAccess} accesses vs ${newAccess}).`,
    };
  }

  // Step 5: Source quality
  const sourceRank = { explicit: 3, corrected: 2, inferred: 1 };
  const newSourceRank = sourceRank[newMemory.source] || 1;
  const existSourceRank = sourceRank[existingMemory.source] || 1;
  if (newSourceRank > existSourceRank) {
    return {
      decision: "SUPERSEDE",
      reason: `New memory has higher source quality (${newMemory.source} vs ${existingMemory.source}).`,
    };
  }
  if (existSourceRank > newSourceRank) {
    return {
      decision: "KEEP_EXISTING",
      reason: `Existing memory has higher source quality (${existingMemory.source} vs ${newMemory.source}).`,
    };
  }

  // Step 6: Semi-mutable with recency tiebreaker
  if (existingMemory.hardness === "semi_mutable") {
    const newDate = new Date(newMemory.createdAt || Date.now());
    const existDate = new Date(existingMemory.createdAt);
    if (newDate > existDate) {
      return {
        decision: "SUPERSEDE",
        reason: `Semi-mutable fact updated with more recent information.`,
      };
    }
  }

  // Step 7: Ambiguous — keep both and flag
  return {
    decision: "KEEP_BOTH",
    reason: `Ambiguous conflict: similar confidence, source, and access patterns. Both memories retained.`,
  };
}

// ============================================================================
// CLEANUP: Find memories past miracle window
// ============================================================================

/**
 * Get the filter query for memories that should be cleaned up
 * (past miracle window end and not already marked expired)
 * 
 * @returns {object} MongoDB filter query
 */
export function getCleanupFilter() {
  return {
    isExpired: false,
    miracleWindowEnd: { $lt: new Date() },
  };
}

/**
 * Get memories that are in their miracle window right now
 * (could be rescued if accessed)
 * 
 * @param {string} userId
 * @returns {object} MongoDB filter query
 */
export function getMiracleWindowFilter(userId) {
  const now = new Date();
  return {
    userId,
    isExpired: false,
    expiryAt: { $lt: now },
    miracleWindowEnd: { $gte: now },
  };
}

export default {
  calculateExpiry,
  getDecayStatus,
  rescueMemory,
  onMemoryAccess,
  calculateConfidence,
  resolveConflict,
  getCleanupFilter,
  getMiracleWindowFilter,
};
