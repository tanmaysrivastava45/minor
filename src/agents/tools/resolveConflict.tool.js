import OpenAI from "openai";
import config from "../../config/index.js";
import { resolveConflict as resolveConflictLogic } from "../../memory/temporalDecay.js";

const client = new OpenAI({ apiKey: config.openai.apiKey });

/**
 * Resolve Conflict Tool
 * 
 * When a new memory conflicts with an existing memory, this tool uses
 * both algorithmic logic and LLM reasoning to determine the resolution.
 * 
 * The multi-factor algorithm considers:
 * 1. Memory hardness (immutable vs mutable)
 * 2. Confidence scores
 * 3. Recency
 * 4. Access frequency
 * 5. Source quality
 * 6. LLM semantic understanding (for ambiguous cases)
 */

/**
 * Resolve a conflict between new and existing memories
 * 
 * @param {object} newMemory - The incoming memory
 * @param {object} existingMemory - The existing stored memory
 * @returns {object} { decision, reason, llmAnalysis }
 */
export async function resolveMemoryConflict(newMemory, existingMemory) {
  // Step 1: Apply algorithmic conflict resolution
  const algorithmicResult = resolveConflictLogic(newMemory, existingMemory);

  // If the algorithm gives a clear answer, use it
  if (algorithmicResult.decision !== "KEEP_BOTH") {
    return {
      ...algorithmicResult,
      method: "algorithmic",
    };
  }

  // Step 2: For ambiguous cases, use LLM reasoning
  try {
    const response = await client.chat.completions.create({
      model: config.openai.llmModel,
      messages: [
        {
          role: "system",
          content: `You are an expert in resolving memory conflicts. Two pieces of information about a user contradict each other. Analyze both and decide which one is more likely to be correct.

Consider:
- Is this the kind of fact that changes over time (mutable) or stays the same (immutable)?
- Which source is more reliable?
- What is the temporal context — did the user update their preference?
- Could this be a correction of an earlier mistake?

Respond in JSON:
{
  "decision": "SUPERSEDE" or "KEEP_EXISTING" or "KEEP_BOTH",
  "reason": "explanation",
  "analysis": "detailed analysis of why"
}`,
        },
        {
          role: "user",
          content: `Resolve this conflict:
          
EXISTING MEMORY:
- Fact: ${existingMemory.fact}
- Category: ${existingMemory.category}
- Hardness: ${existingMemory.hardness}
- Confidence: ${existingMemory.confidence}
- Source: ${existingMemory.source}
- Created: ${existingMemory.createdAt}
- Access Count: ${existingMemory.accessCount || 0}

NEW MEMORY:
- Fact: ${newMemory.fact}
- Category: ${newMemory.category}
- Hardness: ${newMemory.hardness}
- Confidence: ${newMemory.confidence}
- Source: ${newMemory.source}
- Created: ${newMemory.createdAt || "now"}`,
        },
      ],
      response_format: { type: "json_object" },
      temperature: 0.1,
    });

    const llmResult = JSON.parse(response.choices[0].message.content);
    return {
      decision: llmResult.decision || "KEEP_BOTH",
      reason: llmResult.reason || algorithmicResult.reason,
      method: "llm_augmented",
      llmAnalysis: llmResult.analysis,
    };
  } catch (error) {
    // Fall back to algorithmic result
    return {
      ...algorithmicResult,
      method: "algorithmic_fallback",
    };
  }
}

export default { resolveMemoryConflict };
