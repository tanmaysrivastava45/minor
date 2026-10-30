import { guessEntities } from "../util/text.js";
import { isoDay } from "../util/time.js";
import { statusAt, STATUS_WEIGHT } from "./lifecycle.js";

/**
 * Read path (no LLM call, no writes — reads never extend validity; only new evidence does).
 *  1. CORE block: promoted, high-integrity memories always included (MemGPT "working context").
 *  2. Hybrid candidates: cosine + BM25 + entity match, fused and weighted by temporal status.
 *  3. One-hop graph expansion over shared entities of the top hits (multi-hop questions).
 * Superseded memories are kept as *history* (down-weighted, labelled), which is what
 * knowledge-update and temporal questions need.
 */
export async function retrieve(ctx, userId, query, { now, k = 20, coreMax = 25, subject = null, includeHistory = true } = {}) {
  const { store, llm } = ctx;
  const t = now || new Date();
  const [qVec] = await llm.embed([query], { tag: "remind.embed.query" });

  const subjectOk = (m) => !subject || m.subject === subject || m.text.toLowerCase().includes(subject.toLowerCase());
  const usable = (m) => m.status !== "quarantined" && (includeHistory || m.status === "live") && subjectOk(m);

  const vec = store.vectorSearch(userId, qVec, { k: Math.max(60, k * 3), filter: usable });
  const lex = store.lexicalSearch(userId, query);
  const maxLex = Math.max(1e-9, ...lex.values());

  const qEntities = new Set(guessEntities(query));
  const known = store.entityKeys(userId);
  for (const e of known) if (e.length > 3 && query.toLowerCase().includes(e)) qEntities.add(e);

  const scores = new Map();
  const bump = (id, s) => scores.set(id, (scores.get(id) || 0) + s);
  for (const { id, score } of vec) bump(id, 0.6 * Math.max(0, score));
  for (const [id, s] of lex) bump(id, 0.3 * (s / maxLex));
  for (const e of qEntities) for (const id of store.byEntity(userId, e)) bump(id, 0.1);

  const ranked = () =>
    [...scores.entries()]
      .map(([id, s]) => {
        const m = store.getMemory(userId, id);
        if (!m || !usable(m)) return null;
        const status = statusAt(m, t);
        return { m, status, score: s * STATUS_WEIGHT[status] * (0.8 + 0.2 * m.confidence) };
      })
      .filter(Boolean)
      .sort((a, b) => b.score - a.score);

  // One-hop expansion through entities shared with the strongest hits.
  const seeds = ranked().slice(0, 5);
  for (const { m, score } of seeds) {
    for (const e of m.entities || []) {
      if (String(e).toLowerCase() === String(m.subject).toLowerCase()) continue;
      for (const id of store.byEntity(userId, e)) if (id !== m.id && !scores.has(id)) scores.set(id, score * 0.35);
    }
  }

  const items = ranked()
    .slice(0, k)
    .map(({ m, status, score }) => toItem(m, status, score));

  const core = store
    .memories(userId, (m) => m.tier === "core" && m.status === "live" && subjectOk(m))
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, coreMax)
    .map((m) => toItem(m, statusAt(m, t), 1));

  return { core, items };
}

function toItem(m, status, score) {
  return {
    id: m.id,
    text: m.text,
    subject: m.subject,
    date: m.eventTime || m.recordedAt?.slice(0, 10) || null,
    recordedAt: m.recordedAt,
    status,
    invalidAt: m.invalidAt,
    confidence: m.confidence,
    integrity: m.integrity,
    tier: m.tier,
    kind: m.kind,
    score: Math.round(score * 1000) / 1000,
  };
}

/** Render one retrieved item as a single prompt line with its temporal status made explicit. */
export function renderItem(it) {
  const date = it.date ? `${String(it.date).slice(0, 10)}` : "undated";
  const tags = [];
  if (it.status === "superseded") tags.push(`no longer current${it.invalidAt ? ` since ${String(it.invalidAt).slice(0, 10)}` : ""}`);
  if (it.status === "grace" || it.status === "dormant") tags.push(it.kind === "prospective" ? "past plan" : "possibly outdated");
  if (it.status === "stale") tags.push("not re-confirmed recently");
  if (it.integrity === "low") tags.push("unverified: not stated by the user");
  return `${date}: ${it.text}${tags.length ? ` [${tags.join("; ")}]` : ""}`;
}

export function renderContext({ core, items }, { now } = {}) {
  const seen = new Set();
  const lines = [];
  if (core.length) {
    lines.push("## Core memory");
    for (const it of core) {
      seen.add(it.id);
      lines.push(`- ${renderItem(it)}`);
    }
  }
  const rest = items.filter((it) => !seen.has(it.id));
  if (rest.length) {
    lines.push(core.length ? "\n## Relevant memories" : "## Relevant memories");
    for (const it of rest) lines.push(`- ${renderItem(it)}`);
  }
  if (now) lines.unshift(`(Current date: ${isoDay(now)})`);
  return lines.join("\n");
}
