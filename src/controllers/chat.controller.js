import OpenAI from "openai";
import config from "../config/index.js";
import MessageBuffer from "../models/messageBuffer.model.js";
import { consolidateBatch } from "../agents/consolidationAgent.js";
import { retrieveMemoryContext } from "../agents/retrievalAgent.js";

const client = new OpenAI({ apiKey: config.openai.apiKey });

/**
 * CortexMemory Chat Controller
 * 
 * Main controller that handles:
 * 1. Message buffering (accumulate 30 messages)
 * 2. Automatic consolidation when buffer is full
 * 3. Memory-enriched response generation
 * 4. Session management
 */

// In-memory buffers per user (for performance)
const userBuffers = new Map();

/**
 * Get or create a user's message buffer
 */
function getUserBuffer(userId, sessionId) {
  const key = `${userId}_${sessionId}`;
  if (!userBuffers.has(key)) {
    userBuffers.set(key, {
      messages: [],
      batchCount: 0,
      sessionId,
    });
  }
  return userBuffers.get(key);
}

/**
 * Process a user message through the CortexMemory system
 * 
 * @param {string} userId - The user's ID
 * @param {string} userMessage - The user's message
 * @param {string} sessionId - Session identifier
 * @param {object} options - Optional configuration
 * @param {boolean} options.skipConsolidation - Skip batch consolidation (for benchmarking)
 * @param {boolean} options.skipResponse - Skip generating a response (for benchmarking)
 * @returns {object} { response, memoryContext, consolidationReport }
 */
export async function processMessage(
  userId,
  userMessage,
  sessionId = "default",
  options = {}
) {
  const buffer = getUserBuffer(userId, sessionId);
  const result = {
    response: "",
    memoryContext: null,
    consolidationReport: null,
  };

  // Step 1: Retrieve memory context for this message
  const memoryContext = await retrieveMemoryContext(userId, userMessage);
  result.memoryContext = memoryContext;

  // Step 2: Generate response with memory context
  let assistantResponse = "";
  if (!options.skipResponse) {
    assistantResponse = await generateResponse(
      userMessage,
      memoryContext,
      buffer.messages.slice(-10) // Include recent conversation history
    );
    result.response = assistantResponse;
  }

  // Step 3: Add messages to buffer
  buffer.messages.push(
    { role: "user", content: userMessage, timestamp: new Date() },
    { role: "assistant", content: assistantResponse || "[no response]", timestamp: new Date() }
  );

  // Step 4: Check if buffer has reached batch size — trigger consolidation
  if (buffer.messages.length >= config.memory.batchSize && !options.skipConsolidation) {
    console.log(`\n⏰ Buffer reached ${config.memory.batchSize} messages — triggering consolidation!`);

    buffer.batchCount++;
    const batchMessages = [...buffer.messages];

    // Clear buffer for next batch
    buffer.messages = [];

    // Run consolidation (async, non-blocking for response)
    try {
      const report = await consolidateBatch(userId, batchMessages, buffer.batchCount);
      result.consolidationReport = report;

      // Persist batch to MongoDB for history
      await MessageBuffer.create({
        userId,
        sessionId,
        messages: batchMessages,
        batchNumber: buffer.batchCount,
        isConsolidated: true,
        consolidatedAt: new Date(),
      });
    } catch (error) {
      console.error("Consolidation failed:", error.message);
      result.consolidationReport = { error: error.message };
    }
  }

  return result;
}

/**
 * Generate a response enriched with memory context
 */
async function generateResponse(userMessage, memoryContext, recentHistory) {
  const systemPrompt = buildSystemPrompt(memoryContext);

  const messages = [
    { role: "system", content: systemPrompt },
    // Include recent conversation for flow
    ...recentHistory.slice(-6).map((m) => ({
      role: m.role,
      content: m.content,
    })),
    { role: "user", content: userMessage },
  ];

  try {
    const response = await client.chat.completions.create({
      model: config.openai.llmModel,
      messages,
      temperature: 0.7,
      max_tokens: 1024,
    });

    return response.choices[0].message.content;
  } catch (error) {
    console.error("Response generation failed:", error.message);
    return "I apologize, I encountered an error generating a response.";
  }
}

/**
 * Build system prompt with memory context
 */
function buildSystemPrompt(memoryContext) {
  let prompt = `You are a helpful AI assistant with persistent memory. You remember information about the user from past conversations.

When responding:
- Use the memory context naturally, don't explicitly say "I remember from my memory that..."
- If you have relevant factual or episodic memories, incorporate them naturally
- Be warm and personal — show that you remember and care
- If asked about something you don't have memory of, say so honestly`;

  if (memoryContext.hasMemory) {
    prompt += `\n\n=== YOUR MEMORY ABOUT THIS USER ===\n${memoryContext.contextSummary}\n=== END MEMORY ===`;
  }

  return prompt;
}

/**
 * Force consolidation of current buffer (useful for testing/benchmarking)
 */
export async function forceConsolidation(userId, sessionId = "default") {
  const buffer = getUserBuffer(userId, sessionId);

  if (buffer.messages.length === 0) {
    return { message: "No messages to consolidate" };
  }

  buffer.batchCount++;
  const batchMessages = [...buffer.messages];
  buffer.messages = [];

  const report = await consolidateBatch(userId, batchMessages, buffer.batchCount);

  await MessageBuffer.create({
    userId,
    sessionId,
    messages: batchMessages,
    batchNumber: buffer.batchCount,
    isConsolidated: true,
    consolidatedAt: new Date(),
  });

  return report;
}

/**
 * Add messages directly to memory (bypass buffer — for batch loading)
 * Used by benchmarks to load conversation history quickly
 * 
 * @param {string} userId
 * @param {object[]} messages - Array of { role, content }
 * @param {number} batchSize - Override batch size
 */
export async function batchLoadMessages(userId, messages, batchSize = null) {
  const bs = batchSize || config.memory.batchSize;
  const reports = [];

  for (let i = 0; i < messages.length; i += bs) {
    const batch = messages.slice(i, i + bs);
    const batchNum = Math.floor(i / bs) + 1;
    console.log(`\n📦 Batch loading: batch ${batchNum} (messages ${i + 1}-${i + batch.length})`);

    const report = await consolidateBatch(userId, batch, batchNum);
    reports.push(report);
  }

  return reports;
}

/**
 * Query memory only (no response generation) — for benchmark evaluation
 * 
 * @param {string} userId
 * @param {string} question
 * @returns {object} Memory context
 */
export async function queryMemory(userId, question) {
  return retrieveMemoryContext(userId, question);
}

/**
 * Clear all buffers (for testing)
 */
export function clearBuffers() {
  userBuffers.clear();
}

export default {
  processMessage,
  forceConsolidation,
  batchLoadMessages,
  queryMemory,
  clearBuffers,
};
