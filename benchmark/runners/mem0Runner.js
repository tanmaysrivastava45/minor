import "dotenv/config";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import OpenAI from "openai";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Mem0 Benchmark Runner
 *
 * Uses the actual mem0ai SDK (open-source variant) to:
 * 1. Feed 150 messages through mem0's memory.add()
 * 2. For each question, use memory.search() to retrieve context
 * 3. Generate answers using retrieved memories
 * 4. Record results for evaluation
 *
 * Supports both:
 *   - mem0 OSS (local, self-hosted) via `import { Memory } from "mem0ai/oss"`
 *   - mem0 Platform (cloud) via `import { MemoryClient } from "mem0ai"`
 */

const openaiClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

async function loadDataset() {
  const convPath = path.join(__dirname, "..", "dataset", "conversation.json");
  const qPath = path.join(__dirname, "..", "dataset", "questions.json");

  const conversation = JSON.parse(fs.readFileSync(convPath, "utf-8"));
  const questions = JSON.parse(fs.readFileSync(qPath, "utf-8"));

  // Flatten messages into user-assistant pairs
  const allMessages = [];
  for (const session of conversation.sessions) {
    for (const msg of session.messages) {
      allMessages.push({ role: msg.role, content: msg.content });
    }
  }

  return { allMessages, questions: questions.questions };
}

/**
 * Initialize Mem0 — tries Platform (cloud) first, falls back to OSS (local)
 */
async function initMem0() {
  const apiKey = process.env.MEM0_API_KEY;

  if (apiKey) {
    // Platform (cloud) mode
    console.log("  Using Mem0 Platform (cloud) API");
    const { MemoryClient } = await import("mem0ai");
    const client = new MemoryClient({ apiKey });
    return { type: "platform", client };
  }

  // OSS (local) mode
  console.log("  Using Mem0 OSS (local) mode");
  try {
    const { Memory } = await import("mem0ai/oss");
    const memory = new Memory();
    return { type: "oss", client: memory };
  } catch (err) {
    console.warn("  ⚠️  mem0ai/oss import failed, trying default import...");
    try {
      const mem0Module = await import("mem0ai");
      // Try to find Memory or MemoryClient in the exports
      if (mem0Module.Memory) {
        const memory = new mem0Module.Memory();
        return { type: "oss", client: memory };
      }
      if (mem0Module.default?.Memory) {
        const memory = new mem0Module.default.Memory();
        return { type: "oss", client: memory };
      }
      throw new Error("Could not find Memory class in mem0ai package");
    } catch (innerErr) {
      console.error("  ❌ Failed to initialize mem0:", innerErr.message);
      return null;
    }
  }
}

/**
 * Add messages to mem0 in pairs (user + assistant)
 */
async function addToMem0(mem0, userId, messages) {
  const batchSize = 2; // process in user+assistant pairs

  for (let i = 0; i < messages.length; i += batchSize) {
    const pair = messages.slice(i, i + batchSize);

    try {
      if (mem0.type === "platform") {
        await mem0.client.add(pair, { user_id: userId });
      } else {
        await mem0.client.add(pair, { userId });
      }
    } catch (error) {
      // Some pairs might fail — log and continue
      if (i % 20 === 0) {
        console.log(`    Added ${i + batchSize}/${messages.length} messages...`);
      }
    }
  }
}

/**
 * Search mem0 for relevant memories
 */
async function searchMem0(mem0, userId, query) {
  try {
    let results;
    if (mem0.type === "platform") {
      results = await mem0.client.search(query, {
        user_id: userId,
      });
    } else {
      results = await mem0.client.search(query, {
        filters: { userId },
      });
    }
    return results;
  } catch (error) {
    console.warn(`    Search failed: ${error.message}`);
    return [];
  }
}

/**
 * Answer a question using mem0's retrieved memories
 */
async function answerWithMem0(question, memories) {
  // Format mem0 memories into context
  let contextText = "";
  if (Array.isArray(memories) && memories.length > 0) {
    contextText = memories
      .map((m) => {
        // mem0 returns different shapes for OSS vs Platform
        if (typeof m === "string") return `- ${m}`;
        if (m.memory) return `- ${m.memory}`;
        if (m.text) return `- ${m.text}`;
        if (m.content) return `- ${m.content}`;
        if (m.payload) return `- ${JSON.stringify(m.payload)}`;
        return `- ${JSON.stringify(m)}`;
      })
      .join("\n");
  } else if (memories && typeof memories === "object") {
    // Handle non-array responses
    contextText = JSON.stringify(memories);
  }

  const systemPrompt = `You are an AI assistant with persistent memory about a user.
Use ONLY the memory context provided to answer the question.
If the memory doesn't contain the answer, say "I don't have that information."
Be concise but comprehensive.

=== MEMORY CONTEXT (from Mem0) ===
${contextText || "No memories found."}
=== END MEMORY ===`;

  const response = await openaiClient.chat.completions.create({
    model: process.env.LLM_MODEL || "gpt-4.1-mini",
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: question },
    ],
    temperature: 0.1,
    max_tokens: 512,
  });

  return response.choices[0].message.content;
}

export async function runMem0Benchmark() {
  console.log("\n" + "=".repeat(60));
  console.log("  🔵 Mem0 Benchmark Runner");
  console.log("=".repeat(60));

  const { allMessages, questions } = await loadDataset();
  const userId = "benchmark_user_mem0";

  // Step 1: Initialize Mem0
  console.log("\n📦 Initializing Mem0...");
  const mem0 = await initMem0();

  if (!mem0) {
    console.log("❌ Mem0 initialization failed. Skipping benchmark.");
    console.log("   Install mem0ai and configure MEM0_API_KEY in .env");
    return {
      system: "Mem0",
      results: [],
      error: "Mem0 not available",
      skipped: true,
    };
  }

  // Step 2: Feed all messages to mem0
  console.log(`\n📥 Loading ${allMessages.length} messages into Mem0...`);
  const loadStart = Date.now();
  await addToMem0(mem0, userId, allMessages);
  const loadTime = Date.now() - loadStart;
  console.log(`✅ Messages loaded in ${(loadTime / 1000).toFixed(1)}s`);

  // Wait a moment for mem0 to process
  console.log("  Waiting 5s for mem0 to process memories...");
  await new Promise((r) => setTimeout(r, 5000));

  // Step 3: Answer each question
  console.log(`\n❓ Answering ${questions.length} questions...`);
  const results = [];

  for (const q of questions) {
    console.log(`  [${q.id}] ${q.question.substring(0, 60)}...`);
    const start = Date.now();

    try {
      // Search mem0 for relevant memories
      const memories = await searchMem0(mem0, userId, q.question);

      // Generate answer using memories
      const prediction = await answerWithMem0(q.question, memories);

      const latencyMs = Date.now() - start;

      results.push({
        id: q.id,
        question: q.question,
        prediction,
        groundTruth: q.answer,
        category: q.category,
        latencyMs,
        memoriesFound: Array.isArray(memories) ? memories.length : 0,
      });

      console.log(`    ✅ ${latencyMs}ms (${Array.isArray(memories) ? memories.length : 0} memories found)`);
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
  const outputPath = path.join(__dirname, "..", "results", "mem0_raw.json");
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(results, null, 2));
  console.log(`\n💾 Results saved to ${outputPath}`);

  return { system: "Mem0", results, loadTimeMs: loadTime };
}

// Run if executed directly
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runMem0Benchmark()
    .then((r) => {
      if (r.skipped) {
        console.log("\n⚠️  Mem0 benchmark was skipped.");
      } else {
        console.log(`\n✅ Mem0 benchmark complete: ${r.results.length} questions answered`);
      }
      process.exit(0);
    })
    .catch((e) => {
      console.error("Benchmark failed:", e);
      process.exit(1);
    });
}
