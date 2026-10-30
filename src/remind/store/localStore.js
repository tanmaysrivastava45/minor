import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { BM25, cosine } from "../util/text.js";

/**
 * In-process, file-persisted store. One namespace per user (or per benchmark conversation).
 *
 *   recall   : append-only raw turns (already MemGuard-sanitized) — the ground truth that
 *              sleep verification and provenance-cascading deletion rely on
 *   memories : archival + core memories with provenance, integrity, validity and versions
 *   audit    : every write/sleep decision; quarantine: everything MemGuard rejected
 *
 * Embeddings are held in RAM only; they are re-derived from the LLM client's embedding
 * cache on load, so persisted files stay small.
 */
class Namespace {
  constructor() {
    this.turns = new Map();
    this.memories = new Map();
    this.audit = [];
    this.quarantine = [];
    this.embeddings = new Map();
    this.bm25 = new BM25();
    this.entityIndex = new Map();
    this.meta = { lastSleepAt: null, sessions: [] };
  }
}

export class LocalStore {
  constructor({ file = null } = {}) {
    this.file = file;
    this.spaces = new Map();
  }

  ns(userId) {
    if (!this.spaces.has(userId)) this.spaces.set(userId, new Namespace());
    return this.spaces.get(userId);
  }

  // ---------------------------------------------------------------- recall (raw turns)

  addTurn(userId, turn) {
    const s = this.ns(userId);
    if (!s.meta.sessions.includes(turn.session)) s.meta.sessions.push(turn.session);
    s.turns.set(turn.id, turn);
    return turn;
  }

  getTurns(userId, ids) {
    const s = this.ns(userId);
    return ids.map((id) => s.turns.get(id)).filter(Boolean);
  }

  turnCount(userId) {
    return this.ns(userId).turns.size;
  }

  // ---------------------------------------------------------------- memories

  newId() {
    return randomUUID();
  }

  putMemory(userId, mem, embedding) {
    const s = this.ns(userId);
    const old = s.memories.get(mem.id);
    if (old) this.unindex(s, old);
    s.memories.set(mem.id, mem);
    if (embedding) s.embeddings.set(mem.id, embedding);
    this.index(s, mem);
    return mem;
  }

  getMemory(userId, id) {
    return this.ns(userId).memories.get(id);
  }

  patchMemory(userId, id, patch) {
    const m = this.getMemory(userId, id);
    if (!m) return null;
    return this.putMemory(userId, { ...m, ...patch });
  }

  /** Hard delete (used by forgetting/purge). */
  deleteMemory(userId, id) {
    const s = this.ns(userId);
    const m = s.memories.get(id);
    if (!m) return false;
    this.unindex(s, m);
    s.memories.delete(id);
    s.embeddings.delete(id);
    return true;
  }

  memories(userId, filter = () => true) {
    return [...this.ns(userId).memories.values()].filter(filter);
  }

  embeddingOf(userId, id) {
    return this.ns(userId).embeddings.get(id);
  }

  index(s, m) {
    if (m.status === "quarantined") return;
    s.bm25.add(m.id, `${m.subject} ${m.text} ${(m.entities || []).join(" ")}`);
    for (const e of m.entities || []) {
      const k = String(e).toLowerCase();
      if (!s.entityIndex.has(k)) s.entityIndex.set(k, new Set());
      s.entityIndex.get(k).add(m.id);
    }
  }

  unindex(s, m) {
    s.bm25.remove(m.id);
    for (const e of m.entities || []) s.entityIndex.get(String(e).toLowerCase())?.delete(m.id);
  }

  /** @returns {{id: string, score: number}[]} sorted by cosine similarity */
  vectorSearch(userId, vector, { k = 20, filter = () => true } = {}) {
    const s = this.ns(userId);
    const out = [];
    for (const [id, emb] of s.embeddings) {
      const m = s.memories.get(id);
      if (!m || !filter(m)) continue;
      out.push({ id, score: cosine(vector, emb) });
    }
    return out.sort((a, b) => b.score - a.score).slice(0, k);
  }

  lexicalSearch(userId, query) {
    return this.ns(userId).bm25.score(query);
  }

  byEntity(userId, entity) {
    return [...(this.ns(userId).entityIndex.get(String(entity).toLowerCase()) || [])];
  }

  entityKeys(userId) {
    return [...this.ns(userId).entityIndex.keys()];
  }

  // ---------------------------------------------------------------- audit / quarantine

  log(userId, entry) {
    this.ns(userId).audit.push({ at: new Date().toISOString(), ...entry });
  }

  quarantine(userId, entry) {
    this.ns(userId).quarantine.push({ at: new Date().toISOString(), ...entry });
  }

  // ---------------------------------------------------------------- transactions

  /** Run fn atomically against the memory table: any throw restores the previous state. */
  async transaction(userId, fn) {
    const s = this.ns(userId);
    const snapshot = structuredClone([...s.memories.values()]);
    const embSnapshot = new Map(s.embeddings);
    try {
      return await fn();
    } catch (err) {
      s.memories = new Map(snapshot.map((m) => [m.id, m]));
      s.embeddings = embSnapshot;
      s.bm25 = new BM25();
      s.entityIndex = new Map();
      for (const m of s.memories.values()) this.index(s, m);
      throw err;
    }
  }

  // ---------------------------------------------------------------- persistence

  save(file = this.file) {
    if (!file) return;
    const data = {};
    for (const [uid, s] of this.spaces) {
      data[uid] = {
        turns: [...s.turns.values()],
        memories: [...s.memories.values()],
        audit: s.audit,
        quarantine: s.quarantine,
        meta: s.meta,
      };
    }
    fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data));
  }

  /** Load from disk; embeddings must be restored via `reembed` (served from the embed cache). */
  load(file = this.file) {
    if (!file || !fs.existsSync(file)) return false;
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    for (const [uid, d] of Object.entries(data)) {
      const s = this.ns(uid);
      for (const t of d.turns) s.turns.set(t.id, t);
      for (const m of d.memories) this.putMemory(uid, m);
      s.audit = d.audit || [];
      s.quarantine = d.quarantine || [];
      s.meta = d.meta || s.meta;
    }
    return true;
  }

  async reembed(embedFn) {
    for (const [, s] of this.spaces) {
      const mems = [...s.memories.values()].filter((m) => !s.embeddings.has(m.id));
      if (!mems.length) continue;
      const vecs = await embedFn(mems.map((m) => m.text));
      mems.forEach((m, i) => s.embeddings.set(m.id, vecs[i]));
    }
  }

  dropUser(userId) {
    this.spaces.delete(userId);
  }
}
