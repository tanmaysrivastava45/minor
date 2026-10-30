import { createRemind } from "../../src/remind/index.js";
import { renderItem } from "../../src/remind/core/retrieve.js";
import { BM25, cosine } from "../../src/remind/util/text.js";
import { isoDay } from "../../src/remind/util/time.js";
import { startUsageProxy } from "./usageProxy.js";

/**
 * Every system implements:
 *   ingest(conv)                       conv = { id, sessions: [{ key, date, turns: [{ role, speaker, text }] }] }
 *   search(conv, query, { speaker, k, now }) -> string[]   (one "date: memory" line each)
 *   dump(conv) -> string[]             every stored memory text (for leakage/residue audits)
 *   forget(conv, sessionKey)           best available deletion for that system
 * All model traffic is metered into the shared CostMeter.
 */

const roleOf = (t) => (t.role === "assistant" ? "assistant" : t.role === "tool" ? "tool" : t.role === "document" ? "document" : "user");

// ============================================================================ REMind (ours)

export class RemindSystem {
  constructor({ llm, meter, options = {}, sleepEvery = "session", name = "REMind" }) {
    this.name = name;
    this.remind = createRemind({ llm, meter, options });
    this.sleepEvery = sleepEvery; // "session" | "end" | "none"
  }

  ns(conv) {
    return `conv_${conv.id}`;
  }

  async ingest(conv) {
    const ns = this.ns(conv);
    for (const s of conv.sessions) {
      const msgs = s.turns.map((t) => ({ role: roleOf(t), speaker: t.speaker, content: t.text }));
      await this.remind.addToMemory(ns, msgs, { session: s.key, date: s.date });
      if (this.sleepEvery === "session") await this.remind.sleep(ns, { now: s.date });
    }
    const last = conv.sessions[conv.sessions.length - 1]?.date;
    if (this.sleepEvery === "end") await this.remind.sleep(ns, { now: last });
    else await this.remind.flush(ns);
  }

  async search(conv, query, { speaker = null, k = 20, now } = {}) {
    const res = await this.remind.retrieve(this.ns(conv), query, { now, k, subject: speaker });
    const seen = new Set();
    return [...res.core, ...res.items].filter((it) => !seen.has(it.id) && seen.add(it.id)).map(renderItem);
  }

  dump(conv) {
    return this.remind.store.memories(this.ns(conv), (m) => m.status !== "quarantined").map((m) => m.text);
  }

  async forget(conv, sessionKey) {
    return this.remind.forget(this.ns(conv), { session: sessionKey });
  }

  stats(conv) {
    return this.remind.stats(this.ns(conv));
  }
}

// ============================================================================ Mem0 OSS (official package)

export class Mem0System {
  /**
   * Uses the real `mem0ai` OSS SDK (npm mem0ai@3.x, `import { Memory } from "mem0ai/oss"`), routed
   * through a metering proxy. LoCoMo ingestion follows the Mem0 paper harness: one memory store per
   * speaker, both perspectives, batches of 2 messages, session timestamp in metadata.
   */
  constructor({ meter, provider = "openai", apiKey, chatModel = "gpt-4o-mini", embedModel = "text-embedding-3-small", embeddingDims, upstream }) {
    this.name = "Mem0 (OSS)";
    Object.assign(this, { meter, provider, apiKey, chatModel, embedModel });
    this.upstream = upstream || (provider === "gemini" ? "https://generativelanguage.googleapis.com/v1beta/openai" : "https://api.openai.com/v1");
    this.embeddingDims = embeddingDims || (provider === "gemini" ? 3072 : 1536);
    this.billing = provider === "gemini" && process.env.GEMINI_PAID !== "1" ? "gemini-free" : provider;
    this.memories = new Map();
  }

  async init() {
    if (this.Memory) return;
    try {
      ({ Memory: this.Memory } = await import("mem0ai/oss"));
    } catch (err) {
      throw new Error(`mem0ai is not installed (npm install mem0ai@3): ${err.message}`);
    }
    this.proxy = await startUsageProxy({ upstream: this.upstream, apiKey: this.apiKey, meter: this.meter, billing: this.billing, tagPrefix: "mem0" });
  }

  memoryFor(conv) {
    if (!this.memories.has(conv.id)) {
      this.memories.set(
        conv.id,
        new this.Memory({
          llm: { provider: "openai", config: { apiKey: "proxied", model: this.chatModel, baseURL: this.proxy.url } },
          embedder: { provider: "openai", config: { apiKey: "proxied", model: this.embedModel, baseURL: this.proxy.url, embeddingDims: this.embeddingDims } },
          vectorStore: { provider: "memory", config: { collectionName: `bench_${conv.id}`, dimension: this.embeddingDims } },
          disableHistory: true,
        })
      );
    }
    return this.memories.get(conv.id);
  }

  uid(conv, speaker) {
    return `${speaker || "user"}_${conv.id}`.replace(/\s+/g, "_");
  }

  async add(mem, messages, userId, session) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        // Like the Mem0 paper harness, the session time travels in metadata (the OSS SDK rejects `timestamp`).
        return await mem.add(messages, { userId, metadata: { timestamp: isoDay(session.date), session: session.key } });
      } catch (err) {
        if (attempt === 2) {
          this.failures = (this.failures || 0) + 1; // counted and reported — never silently swallowed
          console.warn(`  mem0.add failed (${userId}): ${err.message}`);
        }
      }
    }
  }

  async ingest(conv) {
    await this.init();
    const mem = this.memoryFor(conv);
    const speakers = conv.speakers || null;
    for (const s of conv.sessions) {
      if (speakers) {
        const [a, b] = speakers;
        const forA = s.turns.map((t) => ({ role: t.speaker === a ? "user" : "assistant", content: `${t.speaker}: ${t.text}` }));
        const forB = s.turns.map((t) => ({ role: t.speaker === b ? "user" : "assistant", content: `${t.speaker}: ${t.text}` }));
        for (let i = 0; i < s.turns.length; i += 2) {
          await this.add(mem, forA.slice(i, i + 2), this.uid(conv, a), s);
          await this.add(mem, forB.slice(i, i + 2), this.uid(conv, b), s);
        }
      } else {
        // Mem0 only knows user/assistant roles; tool/document content keeps an explicit provenance prefix.
        const prefix = { tool: "[Tool output] ", document: "[Document] " };
        const msgs = s.turns.map((t) => ({ role: t.role === "assistant" ? "assistant" : "user", content: `${prefix[t.role] || ""}${t.text}` }));
        for (let i = 0; i < msgs.length; i += 2) await this.add(mem, msgs.slice(i, i + 2), this.uid(conv, null), s);
      }
    }
  }

  async search(conv, query, { speaker = null, k = 10 } = {}) {
    await this.init();
    const res = await this.memoryFor(conv).search(query, { topK: k, filters: { user_id: this.uid(conv, speaker) } });
    return (res?.results || res || []).map((r) => `${r.metadata?.timestamp || String(r.createdAt || "").slice(0, 10)}: ${r.memory}`);
  }

  async all(conv, speaker) {
    const res = await this.memoryFor(conv).getAll({ filters: { user_id: this.uid(conv, speaker) }, topK: 10000 });
    return res?.results || res || [];
  }

  async dump(conv) {
    await this.init();
    const speakers = conv.speakers || [null];
    const out = [];
    for (const sp of speakers) for (const r of await this.all(conv, sp)) out.push(r.memory);
    return out;
  }

  /** Best case for Mem0: we tagged every add with its session, so delete by that metadata. */
  async forget(conv, sessionKey) {
    await this.init();
    const mem = this.memoryFor(conv);
    let n = 0;
    for (const sp of conv.speakers || [null]) {
      for (const r of await this.all(conv, sp)) {
        if (r.metadata?.session === sessionKey) {
          await mem.delete(r.id);
          n++;
        }
      }
    }
    return { memoriesDeleted: n };
  }

  async close() {
    await this.proxy?.close();
  }
}

// ============================================================================ MemGPT-style (reimplementation)

const MEMGPT_SYSTEM = `You are the memory manager of a MemGPT-style agent (Packer et al., 2023).
You have CORE MEMORY blocks (always in context, limited to {limit} characters each) and unlimited ARCHIVAL MEMORY.
Read the new messages and emit memory function calls:
- {"op":"core_memory_append","block":"<block>","text":"..."}  key persistent facts about a person
- {"op":"core_memory_replace","block":"<block>","old":"exact old text","new":"replacement"}  when a core fact changed
- {"op":"archival_memory_insert","text":"..."}  everything else worth remembering; include the date
Return JSON {"actions":[...]}.`;

export class MemGPTStyleSystem {
  /**
   * A faithful-in-spirit reimplementation of MemGPT's memory hierarchy (core blocks + archival
   * + recall storage) driven by function calls, NOT the official Letta server. Label it as such.
   */
  constructor({ llm, coreLimit = 2000, chunkTurns = 10 }) {
    this.name = "MemGPT-style";
    Object.assign(this, { llm, coreLimit, chunkTurns });
    this.state = new Map();
  }

  st(conv) {
    if (!this.state.has(conv.id)) this.state.set(conv.id, { core: {}, archival: [], recall: [], bm25: new BM25() });
    return this.state.get(conv.id);
  }

  async ingest(conv) {
    const s = this.st(conv);
    const blocks = conv.speakers || ["human"];
    for (const b of blocks) s.core[b] ??= "";
    for (const sess of conv.sessions) {
      for (const t of sess.turns) {
        const id = s.recall.length;
        s.recall.push({ session: sess.key, date: sess.date, text: `${t.speaker || t.role}: ${t.text}` });
        s.bm25.add(id, `${t.speaker || t.role} ${t.text}`);
      }
      for (let i = 0; i < sess.turns.length; i += this.chunkTurns) {
        const chunk = sess.turns.slice(i, i + this.chunkTurns);
        const user = [
          `Date: ${isoDay(sess.date)}`,
          "CORE MEMORY:",
          ...Object.entries(s.core).map(([b, v]) => `<${b}>\n${v}\n</${b}>`),
          "\nNEW MESSAGES:",
          ...chunk.map((t, j) => `[t${i + j}] (${roleOf(t)}) ${t.speaker || t.role}: ${t.text}`),
        ].join("\n");
        const { json } = await this.llm.chat({
          tag: "memgpt.ingest",
          json: true,
          system: MEMGPT_SYSTEM.replace("{limit}", String(this.coreLimit)),
          user,
          maxTokens: 1200,
        });
        const inserts = [];
        for (const a of json?.actions || []) {
          if (a.op === "core_memory_append" && s.core[a.block] !== undefined && a.text) {
            s.core[a.block] = `${s.core[a.block]}\n${a.text}`.trim().slice(-this.coreLimit);
          } else if (a.op === "core_memory_replace" && s.core[a.block] !== undefined && a.old) {
            s.core[a.block] = s.core[a.block].replace(a.old, a.new || "");
          } else if (a.op === "archival_memory_insert" && a.text) {
            inserts.push({ session: sess.key, date: sess.date, text: a.text });
          }
        }
        if (inserts.length) {
          const vecs = await this.llm.embed(inserts.map((x) => x.text), { tag: "memgpt.embed" });
          inserts.forEach((x, j) => s.archival.push({ ...x, vec: vecs[j] }));
        }
      }
    }
  }

  async search(conv, query, { speaker = null, k = 10 } = {}) {
    const s = this.st(conv);
    const [q] = await this.llm.embed([query], { tag: "memgpt.embed.query" });
    const arch = s.archival
      .map((a) => ({ a, score: cosine(q, a.vec) }))
      .filter(({ a }) => !speaker || a.text.toLowerCase().includes(speaker.toLowerCase()))
      .sort((x, y) => y.score - x.score)
      .slice(0, k)
      .map(({ a }) => `${isoDay(a.date)}: ${a.text}`);
    const recallHits = [...s.bm25.score(query).entries()]
      .sort((x, y) => y[1] - x[1])
      .map(([id]) => s.recall[id])
      .filter((r) => !speaker || r.text.startsWith(`${speaker}:`))
      .slice(0, Math.ceil(k / 2))
      .map((r) => `${isoDay(r.date)}: ${r.text}`);
    const coreLines = Object.entries(s.core)
      .filter(([b]) => !speaker || b === speaker || b === "human")
      .flatMap(([, v]) => v.split("\n").filter(Boolean).map((l) => `core: ${l}`));
    return [...coreLines, ...arch, ...recallHits];
  }

  dump(conv) {
    const s = this.st(conv);
    return [...Object.values(s.core), ...s.archival.map((a) => a.text), ...s.recall.map((r) => r.text)];
  }

  /** Recall + archival entries carry their session; core blocks cannot be attributed. */
  async forget(conv, sessionKey) {
    const s = this.st(conv);
    const before = s.archival.length + s.recall.length;
    s.archival = s.archival.filter((a) => a.session !== sessionKey);
    s.recall = s.recall.filter((r) => r.session !== sessionKey);
    s.bm25 = new BM25();
    s.recall.forEach((r, i) => s.bm25.add(i, r.text));
    return { memoriesDeleted: before - s.archival.length - s.recall.length };
  }
}

// ============================================================================ simple baselines

export class RagSystem {
  constructor({ llm, k = 20 }) {
    this.name = "RAG (raw turns)";
    Object.assign(this, { llm, k });
    this.index = new Map();
  }

  async ingest(conv) {
    const rows = conv.sessions.flatMap((s) => s.turns.map((t) => ({ session: s.key, speaker: t.speaker || t.role, text: `${isoDay(s.date)}: ${t.speaker || t.role}: ${t.text}` })));
    const vecs = await this.llm.embed(rows.map((r) => r.text), { tag: "rag.embed" });
    this.index.set(conv.id, rows.map((r, i) => ({ ...r, vec: vecs[i] })));
  }

  async search(conv, query, { speaker = null, k = this.k } = {}) {
    const [q] = await this.llm.embed([query], { tag: "rag.embed.query" });
    return (this.index.get(conv.id) || [])
      .filter((r) => !speaker || r.speaker === speaker)
      .map((r) => ({ r, s: cosine(q, r.vec) }))
      .sort((a, b) => b.s - a.s)
      .slice(0, k)
      .map(({ r }) => r.text);
  }

  dump(conv) {
    return (this.index.get(conv.id) || []).map((r) => r.text);
  }

  async forget(conv, sessionKey) {
    const rows = this.index.get(conv.id) || [];
    this.index.set(conv.id, rows.filter((r) => r.session !== sessionKey));
    return { memoriesDeleted: rows.length - this.index.get(conv.id).length };
  }
}

export class FullContextSystem {
  constructor() {
    this.name = "Full context";
    this.convs = new Map();
  }

  async ingest(conv) {
    this.convs.set(conv.id, conv);
  }

  async search(conv, _query, { speaker = null } = {}) {
    return conv.sessions.flatMap((s) =>
      s.turns.filter((t) => !speaker || t.speaker === speaker).map((t) => `${isoDay(s.date)}: ${t.speaker || t.role}: ${t.text}`)
    );
  }

  dump(conv) {
    return conv.sessions.flatMap((s) => s.turns.map((t) => `${t.speaker || t.role}: ${t.text}`));
  }

  async forget(conv, sessionKey) {
    conv.sessions = conv.sessions.filter((s) => s.key !== sessionKey);
    return {};
  }
}

/**
 * @param {string} name   remind | remind-nosleep | remind-noguard | remind-nogate | remind-jev | remind-llmgate | mem0 | memgpt | rag | full
 */
export function createSystem(name, { llm, meter, mem0 = {}, remindOptions = {} }) {
  const variants = {
    remind: { name: "REMind", options: {} },
    "remind-nosleep": { name: "REMind w/o sleep", options: { sleep: { enabled: false } }, sleepEvery: "none" },
    "remind-noguard": { name: "REMind w/o MemGuard", options: { guard: false } },
    "remind-nogate": { name: "REMind w/o L1 gate", options: { classifier: "none" } },
    "remind-jev": { name: "REMind + Jev gate", options: { classifier: "jev" } },
    "remind-llmgate": { name: "REMind + LLM gate", options: { classifier: "llm" } },
    "remind-purge": { name: "REMind + forgetting", options: { sleep: { purgeDormant: true } } },
  };
  if (variants[name]) {
    const v = variants[name];
    return new RemindSystem({ llm, meter, name: v.name, sleepEvery: v.sleepEvery || "session", options: { ...v.options, ...remindOptions, sleep: { ...(v.options.sleep || {}), ...(remindOptions.sleep || {}) } } });
  }
  switch (name) {
    case "mem0":
      return new Mem0System({ meter, ...mem0 });
    case "memgpt":
      return new MemGPTStyleSystem({ llm });
    case "rag":
      return new RagSystem({ llm });
    case "full":
      return new FullContextSystem();
    default:
      throw new Error(`Unknown system "${name}"`);
  }
}
