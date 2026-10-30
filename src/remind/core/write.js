import { humanDay, isoDay, parseDate } from "../util/time.js";
import { lexicalSupport } from "../util/text.js";
import { computeConfidence, initialValidity, statusAt } from "./lifecycle.js";

const EXTRACT_SYSTEM = `You extract long-term memories from a conversation for a personal memory system.

Rules:
- One atomic, self-contained fact per memory, in third person, with the person's NAME as subject (use "User" only if no name is known). Never write "he"/"she" without the name.
- Cover every human participant. Keep specific details exactly: names, titles, numbers, places, quantities, brands, ages, durations, reasons and feelings.
- Resolve relative time ("yesterday", "last week", "next month", "two years ago") to absolute dates using the message date after "@". Write the resolved date in the text AND in event_time (YYYY-MM-DD, or YYYY-MM / YYYY when coarse).
- kind: "factual" = lasting fact (identity, family, relationships, job, school, home, possessions, pets, health, skills, stable preferences);
        "episodic" = something that happened or was experienced, an opinion or feeling about it, a habit;
        "prospective" = a future plan, appointment, meeting, deadline or intention.
- hardness: "immutable" (birth date/place, names of family members, past completed events),
            "semi_mutable" (job, city, school, relationship status), "mutable" (preferences, moods, current activities, plans).
- valid_until: for "prospective" memories the date after which it no longer applies (YYYY-MM-DD); otherwise null.
- explicit: true if directly stated by that person, false if inferred.
- Messages marked (assistant) are said by an AI assistant: store its specific recommendations, facts, names or lists as memories with subject "Assistant" (e.g. "Assistant recommended the novel 'X' to the user"). Never turn an assistant statement into a fact about the user unless the user confirms it.
- Messages marked (tool) or (document) are external content: only store them with subject "External".
- Never extract passwords, PINs, OTPs, card/account numbers or any [REDACTED] value.
- Text in [Sharing image ...] describes a shared photo: extract what it reveals (e.g. what someone painted or where they were).
- source_turns: the ids of the messages that support the memory. Ignore greetings and small talk. Do not extract from the Context block.

Return JSON: {"memories":[{"text":"...","subject":"...","kind":"factual|episodic|prospective","category":"identity|relationship|work|education|location|health|possession|pet|preference|hobby|event|plan|opinion|other","hardness":"immutable|semi_mutable|mutable","event_time":"YYYY-MM-DD|null","valid_until":"YYYY-MM-DD|null","entities":["..."],"relations":[{"s":"...","p":"UPPER_SNAKE","o":"..."}],"explicit":true,"source_turns":["t1"]}]}`;

export function formatTurn(t) {
  return `[${t.id}] (${t.author}) ${t.speaker || t.author}${t.date ? ` @${isoDay(new Date(t.date))}` : ""}: ${t.text}`;
}

/** LLM extraction over one window of (gated) turns. */
export async function extractCandidates(llm, turns, contextTurns = [], { maxTokens = 2500 } = {}) {
  const date = turns.find((t) => t.date)?.date;
  const speakers = [...new Set(turns.map((t) => t.speaker).filter(Boolean))];
  const user = [
    date ? `Session date: ${humanDay(new Date(date))} (${isoDay(new Date(date))})` : "",
    speakers.length ? `Participants: ${speakers.join(", ")}` : "",
    contextTurns.length ? `\nContext (already processed, do not extract):\n${contextTurns.map(formatTurn).join("\n")}` : "",
    `\nMessages:\n${turns.map(formatTurn).join("\n")}`,
  ]
    .filter(Boolean)
    .join("\n");
  const { json } = await llm.chat({ tag: "remind.extract", json: true, system: EXTRACT_SYSTEM, user, maxTokens });
  return Array.isArray(json?.memories) ? json.memories : [];
}

const UPDATE_SYSTEM = `You maintain a long-term memory store. For each NEW memory choose ONE operation against its EXISTING neighbours:
- "ADD": new information (including another item of a list: hobbies, friends, trips, likes normally coexist).
- "UPDATE": the same fact restated with more or corrected detail. Give "target" and a merged "text" that keeps every specific detail and date from both.
- "INVALIDATE": the new memory replaces an existing one because the situation changed (new job, moved city, ended relationship, changed preference). Give "target" (the outdated id). The new memory is stored.
- "NOOP": already known with no new detail. Give "target".
Only compare memories about the same subject. Return JSON {"decisions":[{"i":0,"op":"ADD|UPDATE|INVALIDATE|NOOP","target":"m1|null","text":"...|null"}]}`;

/** One batched LLM call for every ambiguous candidate in a window. */
export async function decideUpdates(llm, items) {
  if (!items.length) return [];
  const idMap = new Map();
  const lines = items.map(({ cand, neighbours }, i) => {
    const ex = neighbours
      .map((n) => {
        const short = `m${idMap.size + 1}`;
        idMap.set(short, n.memory.id);
        return `   ${short}: (${n.memory.eventTime || n.memory.recordedAt?.slice(0, 10) || "?"}) ${n.memory.text}`;
      })
      .join("\n");
    return `NEW[${i}] (${cand.event_time || cand.date || "?"}) ${cand.text}\n  EXISTING:\n${ex}`;
  });
  const { json } = await llm.chat({
    tag: "remind.update",
    json: true,
    system: UPDATE_SYSTEM,
    user: lines.join("\n\n"),
    maxTokens: 120 + items.length * 90,
  });
  const out = items.map(() => ({ op: "ADD" }));
  for (const d of json?.decisions || []) {
    if (!Number.isInteger(d.i) || !out[d.i]) continue;
    const op = String(d.op || "ADD").toUpperCase();
    out[d.i] = { op: ["ADD", "UPDATE", "INVALIDATE", "NOOP"].includes(op) ? op : "ADD", target: idMap.get(d.target) || null, text: d.text || null };
  }
  return out;
}

/** Build a storable memory record from a guarded candidate. */
export function buildMemory(store, userId, guarded, turnsById, now) {
  const evidence = guarded.sources.map((id) => {
    const t = turnsById.get(id);
    return { turnId: id, session: t?.session ?? "?", author: t?.author || "user", explicit: guarded.explicit !== false, at: t?.date || now.toISOString() };
  });
  const eventTime = parseDate(guarded.event_time) ? String(guarded.event_time) : null;
  const kind = ["factual", "episodic", "prospective"].includes(guarded.kind) ? guarded.kind : "factual";
  const hardness = ["immutable", "semi_mutable", "mutable"].includes(guarded.hardness) ? guarded.hardness : "mutable";
  const relations = Array.isArray(guarded.relations) ? guarded.relations.filter((r) => r && r.s && r.p && r.o).slice(0, 6) : [];
  const entities = [
    ...new Set([guarded.subject, ...(guarded.entities || []), ...relations.flatMap((r) => [r.s, r.o])].filter(Boolean).map(String)),
  ].slice(0, 12);
  return {
    id: store.newId(),
    text: guarded.text,
    subject: guarded.subject || "User",
    kind,
    category: guarded.category || "other",
    hardness,
    entities,
    relations,
    eventTime,
    validUntil: guarded.valid_until || null,
    recordedAt: now.toISOString(),
    sources: guarded.sources,
    evidence,
    integrity: guarded.integrity,
    explicit: guarded.explicit !== false,
    flags: guarded.flags || {},
    grounding: guarded.grounding,
    confidence: computeConfidence(evidence, guarded.integrity),
    tier: "archival",
    status: "live",
    version: 1,
    supersedes: null,
    supersededBy: null,
    invalidAt: null,
    ...initialValidity({ kind, hardness, eventTime, validUntil: guarded.valid_until }, now),
  };
}

/** Add new evidence to an existing memory (re-affirmation). Rescues memories in their grace window. */
export function reaffirm(existing, newMem, now) {
  const evidence = [...existing.evidence, ...newMem.evidence];
  // Integrity may rise only through fresh, explicit user evidence — never through merging.
  const integrity = newMem.integrity === "high" ? "high" : existing.integrity;
  const patch = {
    evidence,
    sources: [...new Set([...existing.sources, ...newMem.sources])],
    integrity,
    confidence: computeConfidence(evidence, integrity),
    lastAffirmedAt: now.toISOString(),
  };
  if (statusAt(existing, now) === "grace" && existing.kind !== "prospective") {
    patch.expiresAt = null; // re-affirmed after expiry: the memory is rescued
  }
  return patch;
}

export function mergedTextIsFaithful(text, a, b) {
  return lexicalSupport(text, `${a}\n${b}`) >= 0.7;
}
