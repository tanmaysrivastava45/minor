import "dotenv/config";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import {
  initCortexMemory,
  shutdownCortexMemory,
  batchLoadMessages,
  queryMemory,
} from "../../src/index.js";
import OpenAI from "openai";
import config from "../../src/config/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const client = new OpenAI({ apiKey: config.openai.apiKey });

/**
 * CortexMemory Benchmark Runner
 *
 * 1. Load 150-message conversation
 * 2. Feed through CortexMemory consolidation pipeline (5 batches of 30)
 * 3. Ask 30 questions using memory retrieval
 * 4. Record answers and latency
 */

async function loadDataset() {
  const convPath = path.join(__dirname, "..", "dataset", "conversation.json");
  const qPath = path.join(__dirname, "..", "dataset", "questions.json");

  const conversation = JSON.parse(fs.readFileSync(convPath, "utf-8"));
  const questions = JSON.parse(fs.readFileSync(qPath, "utf-8"));

  // Flatten all messages from all sessions
  const allMessages = [];
  for (const session of conversation.sessions) {
    for (const msg of session.messages) {
      allMessages.push({
        role: msg.role,
        content: msg.content,
        timestamp: new Date(session.date),
      });
    }
  }

  return { allMessages, questions: questions.questions };
}

async function answerWithMemory(userId, question, memoryContext) {
  const systemPrompt = `You are an AI assistant with persistent memory about a user. 
Use ONLY the memory context provided to answer the question. 
If the memory doesn't contain the answer, say "I don't have that information."
Be concise but comprehensive.

=== MEMORY CONTEXT ===
${memoryContext.contextSummary || "No memory context available."}

Factual memories:
${memoryContext.factual?.map((f) => `- ${f.fact}`).join("\n") || "None"}
=== END MEMORY ===`;

  const response = await client.chat.completions.create({
    model: config.openai.llmModel,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: question },
    ],
    temperature: 0.1,
    max_tokens: 512,
  });

  return response.choices[0].message.content;
}

export async function runCortexMemoryBenchmark() {
  console.log("\n" + "=".repeat(60));
  console.log("  🧠 CortexMemory Benchmark Runner");
  console.log("=".repeat(60));

  const { allMessages, questions } = await loadDataset();
  const userId = "benchmark_user_cortex";

  // Step 1: Initialize CortexMemory
  console.log("\n📦 Initializing CortexMemory...");
  await initCortexMemory();

  // Step 2: Feed all messages through consolidation
  console.log(`\n📥 Loading ${allMessages.length} messages...`);
  const loadStart = Date.now();
  await batchLoadMessages(userId, allMessages);
  const loadTime = Date.now() - loadStart;
  console.log(`✅ Messages loaded in ${(loadTime / 1000).toFixed(1)}s`);

  // Step 3: Answer each question
  console.log(`\n❓ Answering ${questions.length} questions...`);
  const results = [];

  for (const q of questions) {
    console.log(`  [${q.id}] ${q.question.substring(0, 60)}...`);
    const start = Date.now();

    try {
      // Retrieve memory context
      const memoryContext = await queryMemory(userId, q.question);

      // Generate answer using memory
      const prediction = await answerWithMemory(
        userId,
        q.question,
        memoryContext
      );

      const latencyMs = Date.now() - start;

      results.push({
        id: q.id,
        question: q.question,
        prediction,
        groundTruth: q.answer,
        category: q.category,
        latencyMs,
      });

      console.log(`    ✅ ${latencyMs}ms`);
    } catch (error) {
      console.log(`    ❌ Error: ${error.message}`);
      results.push({
        id: q.id,
        question: q.question,
        prediction: `Error: ${error.message}`,
        groundTruth: q.answer,
        category: q.category,
        latencyMs: Date.now() - start,
      });
    }
  }

  // Step 4: Save results
  const outputPath = path.join(__dirname, "..", "results", "cortex_raw.json");
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(results, null, 2));
  console.log(`\n💾 Results saved to ${outputPath}`);

  await shutdownCortexMemory();

  return { system: "CortexMemory", results, loadTimeMs: loadTime };
}

// Run if executed directly
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runCortexMemoryBenchmark()
    .then((r) => {
      console.log(`\n✅ CortexMemory benchmark complete: ${r.results.length} questions answered`);
      process.exit(0);
    })
    .catch((e) => {
      console.error("Benchmark failed:", e);
      process.exit(1);
    });
}
