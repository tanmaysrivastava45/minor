import { fetchAllMemories } from "./tools/fetchMemory.tool.js";

/**
 * Retrieval Agent
 * 
 * Handles intelligent memory retrieval by:
 * 1. Fetching factual memories from MongoDB
 * 2. Searching episodic memories in Qdrant (vector similarity)
 * 3. Querying graph relations from Neo4j
 * 4. Building a coherent context summary
 * 
 * Used by the chat controller to enrich responses with user context.
 */

/**
 * Retrieve relevant memory context for a query
 * 
 * @param {string} userId
 * @param {string} query - The user's current message
 * @returns {object} { contextSummary, factual, episodic, graphRelations }
 */
export async function retrieveMemoryContext(userId, query) {
  console.log(`\n🔎 [Retrieval] Fetching memories for user ${userId}`);
  console.log(`  Query: "${query.substring(0, 100)}${query.length > 100 ? "..." : ""}"`);

  try {
    const memories = await fetchAllMemories(userId, query);

    console.log(`  📊 Found: ${memories.factual.length} factual, ${memories.episodic.length} episodic, ${memories.graphRelations.relations.length} graph relations`);

    return {
      contextSummary: memories.contextSummary,
      factual: memories.factual,
      episodic: memories.episodic,
      graphRelations: memories.graphRelations,
      hasMemory:
        memories.factual.length > 0 ||
        memories.episodic.length > 0 ||
        memories.graphRelations.relations.length > 0,
    };
  } catch (error) {
    console.error("❌ [Retrieval] Failed:", error.message);
    return {
      contextSummary: "",
      factual: [],
      episodic: [],
      graphRelations: { graphMap: "", relations: [] },
      hasMemory: false,
    };
  }
}

export default { retrieveMemoryContext };
