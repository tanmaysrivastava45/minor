import { P1_ANSWER_PROMPT, P1_JUDGE_PROMPT, P2_JUDGE_PROMPT, P2_JUDGE_SYSTEM, LME_ANSWER_PROMPT, lmeJudgePrompt } from "./prompts.js";
import { parseJSONLoose } from "../../src/remind/util/text.js";
import { isoDay } from "../../src/remind/util/time.js";

/** Python's string.Template substitution as used by the Mem0 harness ({{name}} in the prompt source). */
function fillTemplate(tpl, vars) {
  return tpl.replace(/\{\{(\w+)\}\}/g, (_, k) => (k in vars ? String(vars[k]) : `{{${k}}}`));
}

/** P1: Mem0-paper answer generation (system-only message, temperature 0). */
export async function answerLocomoP1(llm, { question, speakerA, speakerB, memoriesA, memoriesB }) {
  const prompt = fillTemplate(P1_ANSWER_PROMPT, {
    speaker_1_user_id: speakerA,
    speaker_2_user_id: speakerB,
    speaker_1_memories: JSON.stringify(memoriesA, null, 4),
    speaker_2_memories: JSON.stringify(memoriesB, null, 4),
    question,
  });
  // Gemini's compat endpoint needs at least one user turn; OpenAI gets the exact Mem0 setup.
  const messages = llm.provider === "gemini" ? [{ role: "user", content: prompt }] : [{ role: "system", content: prompt }];
  const { text } = await llm.chat({ tag: "bench.answer", messages, maxTokens: 400 });
  return text.trim();
}

export async function answerLongMemEval(llm, { question, date, memories }) {
  const prompt = LME_ANSWER_PROMPT.replace("{date}", isoDay(date) || "unknown")
    .replace("{memories}", memories.map((m) => `- ${m}`).join("\n") || "(no memories)")
    .replace("{question}", question);
  const { text } = await llm.chat({ tag: "bench.answer", user: prompt, maxTokens: 300 });
  return text.trim();
}

export async function judgeP1(llm, { question, gold, generated }) {
  const prompt = P1_JUDGE_PROMPT.replace("{question}", question).replace("{gold_answer}", gold).replace("{generated_answer}", generated);
  const { text } = await llm.chat({ tag: "bench.judge.p1", messages: [{ role: "user", content: prompt }], json: true, maxTokens: 120 });
  const label = String(parseJSONLoose(text)?.label || "").toUpperCase();
  return label === "CORRECT" ? 1 : 0;
}

export async function judgeP2(llm, { question, gold, generated }) {
  const prompt = P2_JUDGE_PROMPT.replace("{question}", question).replace("{answer}", gold).replace("{response}", generated);
  const { text } = await llm.chat({ tag: "bench.judge.p2", system: P2_JUDGE_SYSTEM, user: prompt, json: true, maxTokens: 150 });
  const label = String(parseJSONLoose(text)?.label || "").toUpperCase();
  return label === "CORRECT" ? 1 : 0;
}

export async function judgeLME(llm, { type, question, gold, generated, abstention }) {
  const prompt = lmeJudgePrompt(type, question, gold, generated, abstention);
  const { text } = await llm.chat({ tag: "bench.judge.lme", messages: [{ role: "user", content: prompt }], maxTokens: 10 });
  return text.toLowerCase().includes("yes") ? 1 : 0; // identical to evaluate_qa.py
}

/** Mem0 harness: category 3 gold answers keep only the part before ";". */
export function preprocessGold(category, answer) {
  return category === 3 && answer.includes(";") ? answer.split(";")[0].trim() : answer;
}

// ---------------------------------------------------------------- lexical metrics (LoCoMo-style)

function normalize(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\b(a|an|the|and)\b/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

export function tokenF1(pred, gold) {
  const p = normalize(pred);
  const g = normalize(gold);
  if (!p.length || !g.length) return p.length === g.length ? 1 : 0;
  const counts = new Map();
  for (const t of g) counts.set(t, (counts.get(t) || 0) + 1);
  let common = 0;
  for (const t of p) {
    const c = counts.get(t) || 0;
    if (c > 0) {
      common++;
      counts.set(t, c - 1);
    }
  }
  if (!common) return 0;
  const prec = common / p.length;
  const rec = common / g.length;
  return (2 * prec * rec) / (prec + rec);
}

export function bleu1(pred, gold) {
  const p = normalize(pred);
  const g = normalize(gold);
  if (!p.length || !g.length) return 0;
  const counts = new Map();
  for (const t of g) counts.set(t, (counts.get(t) || 0) + 1);
  let match = 0;
  for (const t of p) {
    const c = counts.get(t) || 0;
    if (c > 0) {
      match++;
      counts.set(t, c - 1);
    }
  }
  const bp = p.length >= g.length ? 1 : Math.exp(1 - g.length / p.length);
  return bp * (match / p.length);
}
