#!/usr/bin/env node
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LLMClient, CostMeter, BudgetExceededError } from "../src/remind/llm/client.js";
import { ensureFile, loadLocomo, loadLongMemEval, LOCOMO_URL, LME_URLS } from "./lib/datasets.js";
import { createSystem } from "./lib/systems.js";
import { answerLocomoP1, answerLongMemEval, judgeP1, judgeP2, judgeLME, preprocessGold, tokenF1, bleu1 } from "./lib/evaluate.js";
import { bootstrapCI, fmtCI } from "./lib/stats.js";
import { estimateTokens } from "../src/remind/util/text.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));

const HELP = `
REMind benchmark runner

  node bench/run.js --dataset locomo --system remind [options]

Datasets
  --dataset locomo|longmemeval
  --convs 0,1            LoCoMo conversation indices (default: all 10)
  --categories 1,2,3,4   LoCoMo categories (5 = adversarial is excluded, as in Mem0's protocol)
  --max-questions N      cap questions per conversation (LoCoMo) or total (LongMemEval)
  --lme-file PATH        LongMemEval JSON (default: downloads longmemeval_oracle.json)
  --lme-split oracle|s   which file to download if --lme-file is not given
  --lme-limit N          type-stratified subsample size (default 60)

Systems
  --system remind | remind-nosleep | remind-noguard | remind-nogate | remind-jev | remind-llmgate |
           remind-purge | mem0 | memgpt | rag | full
  --k 10                 memories retrieved per speaker (Mem0 paper harness default: 10)

Models (provider: openai | gemini | mock)
  --ingest-provider openai   --ingest-model gpt-4o-mini   --embed-model text-embedding-3-small
  --answer-provider openai   --answer-model gpt-4o-mini
  --judge-provider  openai   --judge-model  gpt-4o-mini
  --protocol p1|p2|both  P1 = Mem0 paper judge (default), P2 = Mem0 2026 lenient judge
  --rpm N                request cap per minute (use ~10-15 on the Gemini free tier)

Run control
  --budget 1.00          hard USD cap for the whole run (aborts cleanly; resume later)
  --concurrency 4        parallel questions
  --run NAME             output folder name (default: <system>-<models>)
  --dry-run              ingest + search only, no answer/judge calls
`;

function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (!k.startsWith("--")) continue;
    const key = k.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) a[key] = true;
    else {
      a[key] = next;
      i++;
    }
  }
  return a;
}

async function pool(items, n, fn) {
  let i = 0;
  const run = async () => {
    while (i < items.length) {
      const idx = i++;
      await fn(items[idx], idx);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(n, items.length)) }, run));
}

function percentile(xs, p) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))];
}

function groupCost(meter) {
  const out = { memorySystem: 0, answer: 0, judge: 0, total: meter.cost };
  for (const [tag, v] of Object.entries(meter.byTag)) {
    if (tag.startsWith("bench.answer")) out.answer += v.cost;
    else if (tag.startsWith("bench.judge")) out.judge += v.cost;
    else out.memorySystem += v.cost;
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.dataset) {
    console.log(HELP);
    return;
  }
  const dataset = args.dataset;
  const systemName = args.system || "remind";
  const budget = Number(args.budget ?? 1);
  const meter = new CostMeter({ budgetUSD: budget });
  const rpm = Number(args.rpm || 0);
  const mk = (provider, model, embedModel) => new LLMClient({ provider, chatModel: model, embedModel, meter, rpm });

  const ingestProvider = args["ingest-provider"] || "openai";
  const ingestLLM = mk(ingestProvider, args["ingest-model"], args["embed-model"]);
  const answerLLM = mk(args["answer-provider"] || ingestProvider, args["answer-model"]);
  const judgeLLM = mk(args["judge-provider"] || "openai", args["judge-model"] || "gpt-4o-mini");
  const protocol = args.protocol || "p1";
  const k = Number(args.k || 10);
  const system = createSystem(systemName, {
    llm: ingestLLM,
    meter,
    mem0: {
      provider: ingestProvider,
      apiKey: ingestLLM.apiKey,
      chatModel: ingestLLM.chatModel,
      embedModel: ingestLLM.embedModel,
    },
  });

  const runName = args.run || `${systemName}-${ingestLLM.chatModel}-a_${answerLLM.chatModel}-j_${judgeLLM.chatModel}`.replace(/[^\w.-]+/g, "_");
  const outDir = path.join(HERE, "results", dataset, runName);
  fs.mkdirSync(outDir, { recursive: true });
  const resultsFile = path.join(outDir, "results.jsonl");
  const done = new Map();
  if (fs.existsSync(resultsFile)) {
    for (const line of fs.readFileSync(resultsFile, "utf8").split("\n").filter(Boolean)) {
      const r = JSON.parse(line);
      done.set(r.id, r);
    }
  }
  const append = (r) => {
    done.set(r.id, r);
    fs.appendFileSync(resultsFile, `${JSON.stringify(r)}\n`);
  };

  console.log(`\n▶ ${system.name} on ${dataset} — budget $${budget.toFixed(2)} — results: ${path.relative(process.cwd(), outDir)}`);
  const ingestInfo = [];
  const searchLatencies = [];
  let aborted = null;

  try {
    if (dataset === "locomo") {
      const file = await ensureFile(path.join(HERE, "data", "locomo10.json"), LOCOMO_URL);
      const all = loadLocomo(file);
      const ids = args.convs ? String(args.convs).split(",").map(Number) : all.map((c) => c.id);
      const cats = String(args.categories || "1,2,3,4").split(",").map(Number);
      for (const raw of all.filter((c) => ids.includes(c.id))) {
        const conv = {
          id: raw.id,
          speakers: [raw.speakerA, raw.speakerB],
          sessions: raw.sessions.map((s) => ({ key: s.key, date: s.date, turns: s.turns.map((t) => ({ role: "user", speaker: t.speaker, text: t.text })) })),
        };
        let qa = raw.qa.filter((q) => cats.includes(q.category));
        if (args["max-questions"]) qa = qa.slice(0, Number(args["max-questions"]));
        const todo = qa.filter((q) => !done.has(q.id));
        if (!todo.length) {
          console.log(`  conv ${raw.id}: all ${qa.length} questions already scored`);
          continue;
        }
        const before = meter.snapshot();
        const t0 = Date.now();
        console.log(`  conv ${raw.id}: ingesting ${conv.sessions.length} sessions, ${conv.sessions.reduce((n, s) => n + s.turns.length, 0)} turns...`);
        await system.ingest(conv);
        ingestInfo.push({ conv: raw.id, ms: Date.now() - t0, cost: meter.cost - before.cost, calls: meter.calls - before.calls, stats: system.stats?.(conv) });
        console.log(`    ingested in ${((Date.now() - t0) / 1000).toFixed(1)}s, $${(meter.cost - before.cost).toFixed(4)} — answering ${todo.length} questions`);
        const now = conv.sessions[conv.sessions.length - 1].date;
        await pool(todo, Number(args.concurrency || 4), async (q) => {
          const s0 = Date.now();
          const [memoriesA, memoriesB] = await Promise.all([
            system.search(conv, q.question, { speaker: raw.speakerA, k, now }),
            system.search(conv, q.question, { speaker: raw.speakerB, k, now }),
          ]);
          const searchMs = Date.now() - s0;
          searchLatencies.push(searchMs);
          const contextTokens = estimateTokens(JSON.stringify([memoriesA, memoriesB]));
          const r = { id: q.id, conv: raw.id, category: q.category, categoryName: q.categoryName, question: q.question, gold: q.answer, searchMs, contextTokens };
          if (!args["dry-run"]) {
            const generated = await answerLocomoP1(answerLLM, { question: q.question, speakerA: raw.speakerA, speakerB: raw.speakerB, memoriesA, memoriesB });
            const gold = preprocessGold(q.category, q.answer);
            r.generated = generated;
            r.f1 = tokenF1(generated, gold);
            r.b1 = bleu1(generated, gold);
            if (protocol === "p1" || protocol === "both") r.p1 = await judgeP1(judgeLLM, { question: q.question, gold, generated });
            if (protocol === "p2" || protocol === "both") r.p2 = await judgeP2(judgeLLM, { question: q.question, gold, generated });
          }
          append(r);
        });
      }
    } else if (dataset === "longmemeval") {
      const file = args["lme-file"] || (await ensureFile(path.join(HERE, "data", `longmemeval_${args["lme-split"] || "oracle"}.json`), LME_URLS[args["lme-split"] || "oracle"]));
      let items = loadLongMemEval(file, { limit: Number(args["lme-limit"] || 60) });
      if (args["max-questions"]) items = items.slice(0, Number(args["max-questions"]));
      for (const it of items) {
        if (done.has(it.id)) continue;
        const conv = {
          id: `lme_${it.id}`,
          speakers: null,
          sessions: it.sessions.map((s) => ({ key: s.key, date: s.date, turns: s.turns.map((t) => ({ role: t.role, speaker: t.role === "user" ? "User" : "Assistant", text: t.text })) })),
        };
        const before = meter.snapshot();
        const t0 = Date.now();
        await system.ingest(conv);
        ingestInfo.push({ conv: conv.id, ms: Date.now() - t0, cost: meter.cost - before.cost, calls: meter.calls - before.calls });
        const s0 = Date.now();
        const memories = await system.search(conv, it.question, { k: Math.max(k, 20), now: it.questionDate });
        const searchMs = Date.now() - s0;
        searchLatencies.push(searchMs);
        const r = { id: it.id, type: it.type, abstention: it.abstention, question: it.question, gold: it.answer, searchMs, contextTokens: estimateTokens(memories.join("\n")) };
        if (!args["dry-run"]) {
          r.generated = await answerLongMemEval(answerLLM, { question: it.question, date: it.questionDate, memories });
          r.lme = await judgeLME(judgeLLM, { type: it.type, question: it.question, gold: it.answer, generated: r.generated, abstention: it.abstention });
        }
        append(r);
        console.log(`  ${it.id} (${it.type}) ${r.lme === 1 ? "✓" : r.lme === 0 ? "✗" : "-"}  $${meter.cost.toFixed(4)}`);
      }
    } else {
      throw new Error(`Unknown dataset ${dataset}`);
    }
  } catch (err) {
    if (err instanceof BudgetExceededError) {
      aborted = err.message;
      console.warn(`\n⚠ ${err.message} — partial results kept; re-run the same command with a higher --budget to resume (cached calls are free).`);
    } else throw err;
  } finally {
    await system.close?.();
  }

  // ---------------------------------------------------------------- summary
  const rows = [...done.values()];
  const metricKeys = dataset === "locomo" ? ["p1", "p2", "f1", "b1"] : ["lme"];
  const summary = { system: system.name, dataset, runName, models: { ingest: ingestLLM.chatModel, embed: ingestLLM.embedModel, answer: answerLLM.chatModel, judge: judgeLLM.chatModel }, k, n: rows.length, aborted, overall: {}, byCategory: {} };
  for (const mkey of metricKeys) {
    const xs = rows.filter((r) => typeof r[mkey] === "number").map((r) => r[mkey]);
    if (xs.length) summary.overall[mkey] = bootstrapCI(xs);
  }
  const catKey = dataset === "locomo" ? "categoryName" : "type";
  for (const cat of [...new Set(rows.map((r) => r[catKey]))]) {
    summary.byCategory[cat] = {};
    for (const mkey of metricKeys) {
      const xs = rows.filter((r) => r[catKey] === cat && typeof r[mkey] === "number").map((r) => r[mkey]);
      if (xs.length) summary.byCategory[cat][mkey] = bootstrapCI(xs);
    }
  }
  summary.cost = { ...groupCost(meter), thisInvocation: meter.snapshot() };
  summary.efficiency = {
    ingest: ingestInfo,
    avgContextTokens: rows.length ? rows.reduce((n, r) => n + (r.contextTokens || 0), 0) / rows.length : null,
    searchMsP50: percentile(searchLatencies, 0.5),
    searchMsP95: percentile(searchLatencies, 0.95),
    mem0AddFailures: system.failures || 0,
  };
  fs.writeFileSync(path.join(outDir, `summary${aborted ? ".partial" : ""}.json`), JSON.stringify(summary, null, 2));

  console.log(`\n■ ${system.name}: ${rows.length} questions`);
  for (const [mkey, ci] of Object.entries(summary.overall)) console.log(`  ${mkey.toUpperCase().padEnd(4)} ${fmtCI(ci)}`);
  for (const [cat, m] of Object.entries(summary.byCategory)) {
    const main = m.p1 || m.lme || m.p2;
    if (main) console.log(`    ${String(cat).padEnd(26)} ${fmtCI(main)}`);
  }
  const c = summary.cost;
  console.log(`  cost this invocation: $${c.total.toFixed(4)} (memory $${c.memorySystem.toFixed(4)}, answer $${c.answer.toFixed(4)}, judge $${c.judge.toFixed(4)}), ${meter.cachedCalls}/${meter.calls} calls served from cache`);
  if (summary.efficiency.mem0AddFailures) console.log(`  ⚠ mem0.add failures: ${summary.efficiency.mem0AddFailures}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
