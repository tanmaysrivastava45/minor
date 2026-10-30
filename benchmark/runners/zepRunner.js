import "dotenv/config";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import OpenAI from "openai";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Zep Benchmark Runner
 *
 * Uses the @getzep/zep-cloud SDK to:
 * 1. Create a session and feed 150 messages through memory.add()
 * 2. For each question, use memory.get() to retrieve context
 * 3. Generate answers using retrieved memories
 * 4. Record results for evaluation
 */

const openaiClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

async function loadDataset() {
  const convPath = path.join(__dirname, "..", "dataset", "conversation.json");
  const qPath = path.join(__dirname, "..", "dataset", "questions.json");

  const conversation = JSON.parse(fs.readFileSync(convPath, "utf-8"));
  const questions = JSON.parse(fs.readFileSync(qPath, "utf-8"));

  const allMessages = [];
  for (const session of conversation.sessions) {
    for (const msg of session.messages) {
      allMessages.push({
        role: msg.role === "user" ? "Arjun" : "AI Assistant",
        roleType: msg.role === "user" ? "user" : "assistant",
        content: msg.content,
      });
    }
  }

  return { allMessages, questions: questions.questions };
}

/**
 * Initialize Zep client
 */
async function initZep() {
  const apiKey = process.env.ZEP_API_KEY;

  if (!apiKey) {
    console.log("  ⚠️  ZEP_API_KEY not set. Skipping Zep benchmark.");
    return null;
  }

  try {
    const { ZepClient } = await import("@getzep/zep-cloud");
    const client = new ZepClient({ apiKey });
    console.log("  ✅ Zep client initialized");
    return client;
  } catch (err) {
    // Try alternate import patterns
    try {
      const zepModule = await import("@getzep/zep-cloud");
      if (zepModule.Zep) {
        const client = new zepModule.Zep({ apiKey });
        console.log("  ✅ Zep client initialized (alt import)");
        return client;
      }
      if (zepModule.default?.ZepClient) {
        const client = new zepModule.default.ZepClient({ apiKey });
        return client;
      }
    } catch (innerErr) {
      // pass
    }
    console.warn(`  ❌ Failed to initialize Zep: ${err.message}`);
    return null;
  }
}

/**
 * Add messages to Zep's memory
 */
async function addToZep(zepClient, sessionId, messages) {
  const batchSize = 10;

  for (let i = 0; i < messages.length; i += batchSize) {
    const batch = messages.slice(i, i + batchSize).map((m) => ({
      role: m.role,
      roleType: m.roleType,
      content: m.content,
    }));

    try {
      await zepClient.memory.add(sessionId, { messages: batch });
    } catch (error) {
      // Retry once
      try {
        await new Promise((r) => setTimeout(r, 1000));
        await zepClient.memory.add(sessionId, { messages: batch });
      } catch (retryErr) {
        console.warn(`    Batch ${i}-${i + batchSize} failed: ${retryErr.message}`);
      }
    }

    if (i % 30 === 0) {
      console.log(`    Added ${Math.min(i + batchSize, messages.length)}/${messages.length} messages...`);
    }
  }
}

/**
 * Answer using Zep's memory context
 */
async function answerWithZep(question, memoryContext) {
  let contextText = "";

  if (memoryContext) {
    if (memoryContext.context) {
      contextText += memoryContext.context;
    }
    if (memoryContext.facts && memoryContext.facts.length > 0) {
      contextText +=
        "\nFacts:\n" + memoryContext.facts.map((f) => `- ${typeof f === "string" ? f : JSON.stringify(f)}`).join("\n");
    }
    if (memoryContext.messages && memoryContext.messages.length > 0) {
      contextText +=
        "\nRelevant messages:\n" +
        memoryContext.messages.map((m) => `${m.role}: ${m.content}`).join("\n");
    }
  }

  const systemPrompt = `You are an AI assistant with persistent memory about a user.
Use ONLY the memory context provided to answer the question.
If the memory doesn't contain the answer, say "I don't have that information."
Be concise but comprehensive.

=== MEMORY CONTEXT (from Zep) ===
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

export async function runZepBenchmark() {
  console.log("\n" + "=".repeat(60));
  console.log("  🟢 Zep Benchmark Runner");
  console.log("=".repeat(60));

  const { allMessages, questions } = await loadDataset();
  const sessionId = `benchmark_session_${Date.now()}`;

  // Step 1: Initialize Zep
  console.log("\n📦 Initializing Zep...");
  const zepClient = await initZep();

  if (!zepClient) {
    return {
      system: "Zep",
      results: [],
      error: "Zep not available",
      skipped: true,
    };
  }

  // Step 2: Feed messages to Zep
  console.log(`\n📥 Loading ${allMessages.length} messages into Zep...`);
  const loadStart = Date.now();
  await addToZep(zepClient, sessionId, allMessages);
  const loadTime = Date.now() - loadStart;
  console.log(`✅ Messages loaded in ${(loadTime / 1000).toFixed(1)}s`);

  // Wait for Zep to process the knowledge graph
  console.log("  Waiting 10s for Zep to build knowledge graph...");
  await new Promise((r) => setTimeout(r, 10000));

  // Step 3: Answer each question
  console.log(`\n❓ Answering ${questions.length} questions...`);
  const results = [];

  for (const q of questions) {
    console.log(`  [${q.id}] ${q.question.substring(0, 60)}...`);
    const start = Date.now();

    try {
      // Retrieve memory context from Zep
      const memoryContext = await zepClient.memory.get(sessionId);

      // Generate answer
      const prediction = await answerWithZep(q.question, memoryContext);

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
  const outputPath = path.join(__dirname, "..", "results", "zep_raw.json");
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(results, null, 2));
  console.log(`\n💾 Results saved to ${outputPath}`);

  return { system: "Zep", results, loadTimeMs: loadTime };
}

// Run if executed directly
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runZepBenchmark()
    .then((r) => {
      if (r.skipped) {
        console.log("\n⚠️  Zep benchmark was skipped.");
      } else {
        console.log(`\n✅ Zep benchmark complete: ${r.results.length} questions answered`);
      }
      process.exit(0);
    })
    .catch((e) => {
      console.error("Benchmark failed:", e);
      process.exit(1);
    });
}
