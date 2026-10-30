import OpenAI from "openai";
import config from "../../config/index.js";
import { fetchFactualMemories } from "../../memory/factualStore.js";
import { searchEpisodicMemories } from "../../memory/episodicStore.js";
import { fetchRelevantRelations, fetchUserGraph } from "../../memory/graphStore.js";

const client = new OpenAI({ apiKey: config.openai.apiKey });

/**
 * Fetch Memory Tool
 * 
 * Retrieves relevant memories from all three stores:
 * 1. Factual memories from MongoDB
 * 2. Episodic memories from Qdrant (vector search)
 * 3. Graph relations from Neo4j
 * 
 * Then uses LLM to filter and rank the most relevant context.
 */

/**
 * Fetch all relevant memories for a given query
 * 
 * @param {string} userId
 * @param {string} query - The user's current message/query
 * @returns {object} { factual, episodic, graphRelations, contextSummary }
 */
export async function fetchAllMemories(userId, query) {
  const results = {
    factual: [],
    episodic: [],
    graphRelations: { graphMap: "", relations: [] },
    contextSummary: "",
  };

  try {
    // Step 1: Fetch all factual memories for the user (session-level)
    const factualMemories = await fetchFactualMemories(userId);
    results.factual = factualMemories;

    // Step 2: Search episodic memories via vector similarity
    const episodicResults = await searchEpisodicMemories(userId, query);
    results.episodic = episodicResults;

    // Step 3: Extract entities from episodic results for targeted graph search
    const entities = [];
    for (const ep of episodicResults) {
      if (ep.metadata?.entities) {
        const epEntities = Array.isArray(ep.metadata.entities)
          ? ep.metadata.entities
          : ep.metadata.entities.split(",");
        entities.push(...epEntities);
      }
    }

    // Step 4: Fetch graph relations (targeted if we have entities, full otherwise)
    if (entities.length > 0) {
      results.graphRelations = await fetchRelevantRelations(userId, [
        ...new Set(entities),
      ]);
    } else {
      results.graphRelations = await fetchUserGraph(userId);
    }

    // Step 5: Build context summary using LLM
    results.contextSummary = await buildContextSummary(
      query,
      results.factual,
      results.episodic,
      results.graphRelations
    );

    return results;
  } catch (error) {
    console.error("Memory fetch failed:", error.stack || error.message);
    return results;
  }
}

/**
 * Build a coherent context summary from all memory sources
 * Uses LLM to filter and rank the most relevant information
 */
async function buildContextSummary(query, factual, episodic, graphRelations) {
  // Format factual memories
  const factualText =
    factual.length > 0
      ? factual.map((f) => `- ${f.fact} (confidence: ${f.confidence}, category: ${f.category})`).join("\n")
      : "No factual memories found.";

  // Format episodic memories
  const episodicText =
    episodic.length > 0
      ? episodic
          .map(
            (e) =>
              `- ${e.content} ${e.metadata?._rescued ? "[RESCUED from decay]" : ""}`
          )
          .join("\n")
      : "No relevant episodic memories found.";

  // Format graph relations
  const graphText = graphRelations.graphMap || "No graph relations found.";

  // If all empty, return early
  if (factual.length === 0 && episodic.length === 0 && !graphRelations.graphMap) {
    return "No memory context available for this user yet.";
  }

  // Bypass LLM summarization and return raw structured context
  // This prevents the LLM from dropping critical facts or hallucinating.
  return `### Factual Memories\n${factualText}\n\n### Episodic Memories\n${episodicText}\n\n### Knowledge Graph\n${graphText}`;
}

export default { fetchAllMemories };
