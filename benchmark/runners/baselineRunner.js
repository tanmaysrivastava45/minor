import "dotenv/config";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import OpenAI from "openai";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Full-Context Baseline Runner
 *
 * The "no memory layer" upper bound. Stuffs ALL 150 messages into the context
 * window and asks the LLM to answer questions directly.
 *
 * This tests: if the model had perfect memory (all messages visible), how well
 * would it answer? Memory systems should approach but may not exceed this.
 */

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

async function loadDataset() {
  const convPath = path.join(__dirname, "..", "dataset", "conversation.json");
  const qPath = path.join(__dirname, "..", "dataset", "questions.json");

  const conversation = JSON.parse(fs.readFileSync(convPath, "utf-8"));
  const questions = JSON.parse(fs.readFileSync(qPath, "utf-8"));

  // Format full conversation with session markers
  let fullContext = "";
  for (const session of conversation.sessions) {
    fullContext += `\n=== ${session.title} (${session.date}) ===\n`;
    for (const msg of session.messages) {
      fullContext += `${msg.role}: ${msg.content}\n`;
    }
  }

  return { fullContext, questions: questions.questions };
}

export async function runBaselineBenchmark() {
  console.log("\n" + "=".repeat(60));
  console.log("  📋 Full-Context Baseline Runner");
  console.log("=".repeat(60));

  const { fullContext, questions } = await loadDataset();

  console.log(`\n📝 Full context: ${fullContext.length} characters`);
  console.log(`❓ Answering ${questions.length} questions...`);

  const results = [];

  for (const q of questions) {
    console.log(`  [${q.id}] ${q.question.substring(0, 60)}...`);
    const start = Date.now();

    try {
      const response = await client.chat.completions.create({
        model: process.env.LLM_MODEL || "gpt-4.1-mini",
        messages: [
          {
            role: "system",
            content: `You are an AI assistant. Below is the complete conversation history with a user across multiple sessions.
Use this conversation to answer questions accurately.
If the information is not in the conversation, say "I don't have that information."
Be concise but comprehensive.

=== FULL CONVERSATION HISTORY ===
${fullContext}
=== END CONVERSATION ===`,
          },
          { role: "user", content: q.question },
        ],
        temperature: 0.1,
        max_tokens: 512,
      });

      const prediction = response.choices[0].message.content;
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

  // Save results
  const outputPath = path.join(__dirname, "..", "results", "baseline_raw.json");
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(results, null, 2));
  console.log(`\n💾 Results saved to ${outputPath}`);

  return { system: "Full-Context Baseline", results, loadTimeMs: 0 };
}

// Run if executed directly
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runBaselineBenchmark()
    .then((r) => {
      console.log(`\n✅ Baseline benchmark complete: ${r.results.length} questions answered`);
      process.exit(0);
    })
    .catch((e) => {
      console.error("Benchmark failed:", e);
      process.exit(1);
    });
}
