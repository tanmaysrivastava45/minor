#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureFile, loadLocomo, LOCOMO_URL } from "./lib/datasets.js";
import { PRICES } from "../src/remind/llm/pricing.js";
import { P1_ANSWER_PROMPT, P1_JUDGE_PROMPT } from "./lib/prompts.js";
import { estimateTokens } from "../src/remind/util/text.js";

/**
 * Back-of-envelope LoCoMo cost BEFORE spending anything (no API calls):
 *   node bench/estimate.js --convs 0,1 --model gpt-4o-mini --k 10
 * Estimates are rough (±40%). Calibrate by running one conversation and reading summary.json.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : d;
};

const model = opt("model", "gpt-4o-mini");
const k = Number(opt("k", 10));
const price = PRICES[model];
if (!price) throw new Error(`No price for ${model}; known: ${Object.keys(PRICES).join(", ")}`);
const file = await ensureFile(path.join(HERE, "data", "locomo10.json"), LOCOMO_URL);
const all = loadLocomo(file);
const ids = opt("convs") ? opt("convs").split(",").map(Number) : all.map((c) => c.id);
const convs = all.filter((c) => ids.includes(c.id));

let turns = 0;
let chars = 0;
let sessions = 0;
let questions = 0;
let fullContextIn = 0;
for (const c of convs) {
  let convChars = 0;
  sessions += c.sessions.length;
  const q = c.qa.filter((x) => x.category !== 5).length;
  questions += q;
  for (const s of c.sessions) for (const t of s.turns) {
    turns++;
    convChars += t.text.length + 12;
  }
  chars += convChars;
  fullContextIn += q * (convChars / 4 + 600);
}
const usd = (inp, out) => (inp * price.input + out * price.output) / 1e6;

// REMind: 16-turn windows (+4 context turns) -> extraction ~1.1k prompt + text; update calls on ~40% of windows; sleep ~1 call/session
const windows = Math.ceil(turns / 16) + sessions;
const remindIn = windows * (1100 + estimateTokens("x".repeat(chars / windows)) * 1.25) + windows * 0.4 * 900 + sessions * 1200;
const remindOut = windows * 450 + windows * 0.4 * 150 + sessions * 200;
// Answer (P1 prompt + 2 speakers × k memories × ~28 tokens) and judge
const ansIn = questions * (estimateTokens(P1_ANSWER_PROMPT) + 2 * k * 28 + 20);
const ansOut = questions * 160;
const judgeIn = questions * (estimateTokens(P1_JUDGE_PROMPT) + 60);
const judgeOut = questions * 40;
const embedUSD = ((chars / 4) * 0.6 * (PRICES["text-embedding-3-small"].input || 0)) / 1e6;

console.log(`LoCoMo convs [${ids.join(",")}]: ${sessions} sessions, ${turns} turns, ~${Math.round(chars / 4 / 1000)}k tokens of dialogue, ${questions} scored questions`);
console.log(`Prices for ${model}: $${price.input}/M in, $${price.output}/M out\n`);
console.log(`  REMind ingestion      ~$${usd(remindIn, remindOut).toFixed(3)}  (+ embeddings ~$${embedUSD.toFixed(3)})`);
console.log(`  Answering (P1)        ~$${usd(ansIn, ansOut).toFixed(3)}`);
console.log(`  Judging  (P1)         ~$${usd(judgeIn, judgeOut).toFixed(3)}   (add the same again for --protocol both)`);
console.log(`  Mem0 OSS ingestion    ~${turns} add() calls (2 speakers × turns/2); measure on 1 conversation, then extrapolate`);
console.log(`  Full-context answer   ~$${usd(fullContextIn, ansOut).toFixed(2)}  (why we cite the published full-context number instead)`);
console.log(`\n  TOTAL REMind run      ~$${(usd(remindIn, remindOut) + embedUSD + usd(ansIn, ansOut) + usd(judgeIn, judgeOut)).toFixed(2)}`);
