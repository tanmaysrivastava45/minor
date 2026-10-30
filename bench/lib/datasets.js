import fs from "node:fs";
import path from "node:path";
import { parseDate } from "../../src/remind/util/time.js";

export const LOCOMO_URL = "https://raw.githubusercontent.com/snap-research/locomo/main/data/locomo10.json";
export const LME_URLS = {
  oracle: "https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/main/longmemeval_oracle.json",
  s: "https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/main/longmemeval_s_cleaned.json",
};

/** Category ids as used by Mem0's evaluation code (memory-benchmarks/benchmarks/locomo/prompts.py). */
export const LOCOMO_CATEGORIES = { 1: "multi-hop", 2: "temporal", 3: "open-domain", 4: "single-hop", 5: "adversarial" };

export async function ensureFile(file, url) {
  if (fs.existsSync(file)) return file;
  console.log(`Downloading ${url} -> ${file}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed: HTTP ${res.status} for ${url}`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  return file;
}

/** Same turn text the Mem0 harness ingests, including shared-image captions. */
function turnText(turn) {
  const { text = "", blip_caption: blip = "", query = "" } = turn;
  let tag = "";
  if (query && blip) tag = `[Sharing image - query: ${query}. The image shows: ${blip}]`;
  else if (query) tag = `[Sharing image - query for: ${query}]`;
  else if (blip) tag = `[Sharing image that shows: ${blip}]`;
  return tag ? (text ? `${text} ${tag}` : tag) : text;
}

/**
 * @returns {{id: number, speakerA: string, speakerB: string, sessions: {key: string, date: Date, turns: {speaker: string, diaId: string, text: string}[]}[], qa: object[]}[]}
 */
export function loadLocomo(file) {
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  return data.map((sample, id) => {
    const c = sample.conversation;
    const sessions = Object.keys(c)
      .filter((k) => /^session_\d+$/.test(k) && Array.isArray(c[k]))
      .map((k) => ({
        key: k,
        date: parseDate(c[`${k}_date_time`]),
        turns: c[k].map((t) => ({ speaker: t.speaker, diaId: t.dia_id, text: turnText(t) })).filter((t) => t.text),
      }))
      .sort((a, b) => (a.date && b.date ? a.date - b.date : Number(a.key.split("_")[1]) - Number(b.key.split("_")[1])));
    const qa = sample.qa.map((q, qi) => ({
      id: `${id}-${qi}`,
      question: q.question,
      answer: q.answer != null ? String(q.answer) : String(q.adversarial_answer ?? ""),
      category: q.category,
      categoryName: LOCOMO_CATEGORIES[q.category],
      evidence: q.evidence || [],
    }));
    return { id, speakerA: c.speaker_a, speakerB: c.speaker_b, sessions, qa };
  });
}

/**
 * LongMemEval loader with a deterministic, type-stratified subsample so a small budget still
 * covers all six question types plus abstention proportionally.
 */
export function loadLongMemEval(file, { limit = null, seed = 7 } = {}) {
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  const items = data.map((d) => ({
    id: d.question_id,
    type: d.question_type,
    abstention: String(d.question_id).includes("_abs"),
    question: d.question,
    answer: String(d.answer),
    questionDate: parseDate(d.question_date),
    sessions: d.haystack_sessions.map((turns, i) => ({
      key: String(d.haystack_session_ids?.[i] ?? i),
      date: parseDate(d.haystack_dates?.[i]),
      turns: turns.map((t) => ({ role: t.role, text: t.content })),
    })),
  }));
  if (!limit || limit >= items.length) return items;
  const groups = new Map();
  for (const it of items) {
    const g = `${it.type}${it.abstention ? "_abs" : ""}`;
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(it);
  }
  let s = seed;
  const rand = () => ((s = (s * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  // Largest-remainder allocation: quotas sum exactly to `limit` and stay proportional to group size.
  const entries = [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
  const quotas = entries.map(([g, list]) => {
    const exact = (list.length / items.length) * limit;
    return { g, list, n: Math.floor(exact), rem: exact - Math.floor(exact) };
  });
  let left = limit - quotas.reduce((s, q) => s + q.n, 0);
  for (const q of [...quotas].sort((a, b) => b.rem - a.rem)) {
    if (left <= 0) break;
    q.n++;
    left--;
  }
  const out = [];
  for (const { list, n } of quotas) {
    const shuffled = [...list];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    out.push(...shuffled.slice(0, n));
  }
  return out;
}
