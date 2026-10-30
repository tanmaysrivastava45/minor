import crypto from "node:crypto";

const STOPWORDS = new Set(
  `a an the and or but if then so of to in on at by for with from as is are was were be been being
  i me my mine we our ours you your yours he him his she her hers it its they them their theirs
  this that these those there here what which who whom whose when where why how do does did done
  have has had having will would shall should can could may might must not no yes just very really
  about into over under again also too than up down out off all any some such own same other more most
  am im ive id youre thats dont doesnt didnt isnt wasnt cant wont ok okay oh hey hi hello thanks thank`
    .split(/\s+/)
    .filter(Boolean)
);

export function sha256(value) {
  return crypto.createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");
}

export function tokenize(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[’']/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
}

export function contentTokens(text) {
  return tokenize(text).filter((t) => !STOPWORDS.has(t) && t.length > 1);
}

/** Crude light stemmer so "hiking"/"hiked"/"hikes" collide in lexical matching. */
export function stem(token) {
  if (token.length <= 4) return token;
  return token.replace(/(ingly|edly|ing|ed|es|s)$/u, "");
}

export function stemmedContentTokens(text) {
  return contentTokens(text).map(stem);
}

export function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

/** Fraction of `claim` content tokens that appear in `evidence` (lexical support). */
export function lexicalSupport(claim, evidence) {
  const c = new Set(stemmedContentTokens(claim));
  if (c.size === 0) return 1;
  const e = new Set(stemmedContentTokens(evidence));
  let hit = 0;
  for (const t of c) if (e.has(t)) hit++;
  return hit / c.size;
}

/** Rough token estimate (≈4 chars/token for English) used for budgeting only. */
export function estimateTokens(text) {
  return Math.ceil(String(text || "").length / 4);
}

/** Parse JSON from an LLM reply that may wrap it in prose or code fences. */
export function parseJSONLoose(text) {
  if (text == null) return null;
  if (typeof text === "object") return text;
  const s = String(text).trim();
  try {
    return JSON.parse(s);
  } catch {
    // fall through
  }
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) {
    try {
      return JSON.parse(fenced[1]);
    } catch {
      // fall through
    }
  }
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(s.slice(start, end + 1));
    } catch {
      return null;
    }
  }
  return null;
}

/** Okapi BM25 over a small in-memory corpus. Rebuilt lazily when documents change. */
export class BM25 {
  constructor({ k1 = 1.2, b = 0.75 } = {}) {
    this.k1 = k1;
    this.b = b;
    this.docs = new Map(); // id -> { tf: Map, len }
    this.df = new Map();
    this.totalLen = 0;
  }

  add(id, text) {
    if (this.docs.has(id)) this.remove(id);
    const toks = stemmedContentTokens(text);
    const tf = new Map();
    for (const t of toks) tf.set(t, (tf.get(t) || 0) + 1);
    for (const t of tf.keys()) this.df.set(t, (this.df.get(t) || 0) + 1);
    this.docs.set(id, { tf, len: toks.length });
    this.totalLen += toks.length;
  }

  remove(id) {
    const d = this.docs.get(id);
    if (!d) return;
    for (const t of d.tf.keys()) {
      const n = (this.df.get(t) || 1) - 1;
      if (n <= 0) this.df.delete(t);
      else this.df.set(t, n);
    }
    this.totalLen -= d.len;
    this.docs.delete(id);
  }

  /** @returns {Map<string, number>} id -> score */
  score(query, ids = null) {
    const q = [...new Set(stemmedContentTokens(query))];
    const N = this.docs.size || 1;
    const avg = this.totalLen / N || 1;
    const out = new Map();
    const pool = ids || this.docs.keys();
    for (const id of pool) {
      const d = this.docs.get(id);
      if (!d) continue;
      let s = 0;
      for (const t of q) {
        const f = d.tf.get(t);
        if (!f) continue;
        const df = this.df.get(t) || 0;
        const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
        s += (idf * f * (this.k1 + 1)) / (f + this.k1 * (1 - this.b + (this.b * d.len) / avg));
      }
      if (s > 0) out.set(id, s);
    }
    return out;
  }
}

/** Capitalised multi-word spans and quoted strings — cheap entity guesses for queries. */
export function guessEntities(text) {
  const s = String(text || "");
  const out = new Set();
  for (const m of s.matchAll(/"([^"]{2,60})"/g)) out.add(m[1].toLowerCase());
  for (const m of s.matchAll(/\b([A-Z][\p{L}'-]+(?:\s+[A-Z][\p{L}'-]+)*)\b/gu)) {
    const w = m[1];
    if (!STOPWORDS.has(w.toLowerCase())) out.add(w.toLowerCase());
  }
  return [...out];
}
