import { LLMClient, CostMeter } from "./llm/client.js";
import { LocalStore } from "./store/localStore.js";
import { MemGuard } from "./guard/memguard.js";
import { createClassifier } from "./classify/index.js";
import { extractCandidates, decideUpdates, buildMemory, reaffirm, mergedTextIsFaithful } from "./core/write.js";
import { retrieve as retrieveCore, renderContext } from "./core/retrieve.js";
import { runSleep } from "./core/sleep.js";
import { computeConfidence } from "./core/lifecycle.js";
import { parseDate } from "./util/time.js";

/**
 * REMind v2 — "a memory that sleeps", with a guarded sleep.
 *
 *   const remind = createRemind({ provider: "openai" });
 *   await remind.addToMemory("u1", [{ role: "user", content: "I'm Asha, I moved to Pune." }], { session: "s1", date: "2024-03-01" });
 *   await remind.sleep("u1", { now: "2024-03-02" });
 *   const { context } = await remind.retrieve("u1", "Where does Asha live?", { now: "2024-03-05" });
 *
 * All time-dependent logic uses the conversation time you pass in (`date` / `now`), never the
 * wall clock, so long-horizon behaviour (expiry, assurity, staleness) is testable offline.
 */

export const DEFAULTS = {
  batchTurns: 16,
  maxWindowChars: 7000,
  contextTurns: 4,
  maxAssistantChars: 2000,
  classifier: "heuristic", // "none" | "heuristic" | "llm" | "jev"
  guard: true,
  update: { neighbours: 5, duplicateSimilarity: 0.93, relatedSimilarity: 0.5 },
  sleep: {
    enabled: true,
    clusterSimilarity: 0.8,
    clusterMaxSize: 6,
    clustersPerCall: 8,
    maxClustersPerSleep: 60,
    promoteMinConfidence: 0.75,
    purgeDormant: false,
    purgeBelowConfidence: 0.5,
  },
  retrieve: { k: 20, coreMax: 25 },
};

function merge(base, over = {}) {
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) {
    out[k] = v && typeof v === "object" && !Array.isArray(v) && base[k] && typeof base[k] === "object" ? { ...base[k], ...v } : v;
  }
  return out;
}

const ROLE_TO_AUTHOR = { user: "user", human: "user", assistant: "assistant", ai: "assistant", tool: "tool", function: "tool", document: "document", system: "document" };

export class Remind {
  /**
   * @param {object} [opts]
   * @param {LLMClient} [opts.llm]      or pass provider/apiKey/models to build one
   * @param {LocalStore} [opts.store]
   * @param {CostMeter} [opts.meter]
   */
  constructor(opts = {}) {
    this.options = merge(DEFAULTS, opts.options || {});
    this.meter = opts.meter || opts.llm?.meter || new CostMeter({ budgetUSD: opts.budgetUSD ?? Infinity });
    this.llm = opts.llm || new LLMClient({ ...opts.llmOptions, meter: this.meter });
    this.store = opts.store || new LocalStore({ file: opts.storeFile || null });
    this.guard = new MemGuard({ enabled: this.options.guard });
    this.classifier = createClassifier(this.options.classifier, { llm: this.llm, meter: this.meter });
    this.pending = new Map(); // userId -> turns awaiting consolidation
    this.fingerprints = new Map(); // userId -> secret fingerprints seen (never persisted)
    this.ctx = { store: this.store, llm: this.llm, guard: this.guard };
    this.timings = { writeMs: 0, sleepMs: 0, readMs: 0 };
  }

  /**
   * Add messages to memory. Turns are sanitized and stored in recall immediately; consolidation
   * into long-term memory runs every `batchTurns` turns (or on flush/sleep).
   * @param {string} userId
   * @param {{role: string, content: string, speaker?: string, date?: string}[]} messages
   * @param {{session?: string, date?: string|Date}} [meta]
   */
  async addToMemory(userId, messages, meta = {}) {
    const session = String(meta.session ?? "default");
    const sessionDate = parseDate(meta.date) || null;
    const queue = this.pending.get(userId) || [];
    const fps = this.fingerprints.get(userId) || [];
    for (const msg of messages) {
      const author = ROLE_TO_AUTHOR[msg.role] || "user";
      let text = String(msg.content ?? "").trim();
      if (!text) continue;
      if (author === "assistant" && text.length > this.options.maxAssistantChars) text = `${text.slice(0, this.options.maxAssistantChars)} …`;
      const meta = this.store.ns(userId).meta;
      meta.turnSeq = (meta.turnSeq || 0) + 1;
      const raw = {
        id: `t${meta.turnSeq}`,
        session,
        author,
        speaker: msg.speaker || (author === "user" ? "User" : author === "assistant" ? "Assistant" : "External"),
        text,
        date: (parseDate(msg.date) || sessionDate || null)?.toISOString() || null,
      };
      const { turn, fingerprints } = this.guard.inspectTurn(raw);
      fps.push(...fingerprints);
      if (fingerprints.length) this.store.log(userId, { type: "guard.turn", turnId: turn.id, guarded: turn.guarded });
      this.store.addTurn(userId, turn);
      queue.push(turn);
    }
    this.pending.set(userId, queue);
    this.fingerprints.set(userId, fps);

    const reports = [];
    while (this.windowReady(queue)) reports.push(await this.consolidate(userId, this.takeWindow(queue)));
    return reports;
  }

  windowReady(queue) {
    if (queue.length >= this.options.batchTurns) return true;
    return queue.reduce((n, t) => n + t.text.length, 0) >= this.options.maxWindowChars;
  }

  takeWindow(queue) {
    let chars = 0;
    let n = 0;
    while (n < queue.length && n < this.options.batchTurns && (n === 0 || chars + queue[n].text.length <= this.options.maxWindowChars)) {
      chars += queue[n].text.length;
      n++;
    }
    return queue.splice(0, n);
  }

  /** Consolidate everything still pending for this user. */
  async flush(userId) {
    const queue = this.pending.get(userId) || [];
    const reports = [];
    while (queue.length) reports.push(await this.consolidate(userId, this.takeWindow(queue)));
    return reports;
  }

  async consolidate(userId, window) {
    const started = Date.now();
    const report = { turns: window.length, kept: 0, candidates: 0, added: 0, updated: 0, invalidated: 0, noop: 0, rejected: 0, llmDecisions: 0 };
    if (!window.length) return report;
    const now = new Date(window[window.length - 1].date || Date.now());
    const s = this.store.ns(userId);

    // L1 gate
    const labels = await this.classifier.classify(window);
    const kept = window.filter((t) => labels.get(t.id)?.keep !== false);
    report.kept = kept.length;
    if (!kept.length) return report;

    // L2 extraction (with a little preceding context for coreference)
    const firstIdx = Number(window[0].id.slice(1));
    const contextTurns = [];
    for (let i = Math.max(1, firstIdx - this.options.contextTurns); i < firstIdx; i++) {
      const t = s.turns.get(`t${i}`);
      if (t && t.session === window[0].session) contextTurns.push(t);
    }
    const cands = await extractCandidates(this.llm, kept, contextTurns);
    report.candidates = cands.length;

    // W1 guard
    const turnsById = new Map(window.map((t) => [t.id, t]));
    const fps = this.fingerprints.get(userId) || [];
    const guarded = [];
    for (const c of cands) {
      const verdict = this.guard.checkCandidate(c, turnsById, fps);
      if (!verdict.accept) {
        report.rejected++;
        this.store.quarantine(userId, { type: "write.rejected", reasons: verdict.reasons, text: this.guard.inspectOutput(String(c.text || ""), fps) });
        continue;
      }
      guarded.push(buildMemory(this.store, userId, verdict.memory, turnsById, now));
    }
    if (!guarded.length) return report;

    // Update phase: fast paths by similarity, one batched LLM call for the ambiguous rest.
    const vecs = await this.llm.embed(guarded.map((m) => m.text), { tag: "remind.embed.write" });
    const u = this.options.update;
    const ambiguous = [];
    for (let i = 0; i < guarded.length; i++) {
      const mem = guarded[i];
      const neighbours = this.store
        .vectorSearch(userId, vecs[i], { k: u.neighbours, filter: (m) => m.status === "live" && m.subject === mem.subject })
        .map((n) => ({ ...n, memory: this.store.getMemory(userId, n.id) }));
      const top = neighbours[0];
      if (top && top.score >= u.duplicateSimilarity) {
        this.applyNoop(userId, top.memory, mem, now);
        report.noop++;
      } else if (!top || top.score < u.relatedSimilarity) {
        this.store.putMemory(userId, mem, vecs[i]);
        report.added++;
      } else {
        ambiguous.push({ i, cand: { text: mem.text, event_time: mem.eventTime, date: mem.recordedAt.slice(0, 10) }, neighbours: neighbours.filter((n) => n.score >= u.relatedSimilarity) });
      }
    }

    if (ambiguous.length) {
      const decisions = await decideUpdates(this.llm, ambiguous);
      report.llmDecisions = ambiguous.length;
      for (let j = 0; j < ambiguous.length; j++) {
        const { i } = ambiguous[j];
        const mem = guarded[i];
        const d = decisions[j];
        const target = d.target ? this.store.getMemory(userId, d.target) : null;
        if (d.op === "NOOP" && target) {
          this.applyNoop(userId, target, mem, now);
          report.noop++;
        } else if (d.op === "UPDATE" && target && d.text && mergedTextIsFaithful(d.text, target.text, mem.text)) {
          const [vec] = await this.llm.embed([d.text], { tag: "remind.embed.write" });
          const evidence = [...target.evidence, ...mem.evidence];
          const integrity = mem.integrity === "high" && target.integrity === "high" ? "high" : target.integrity === "low" || mem.integrity === "low" ? "low" : "medium";
          const next = {
            ...mem,
            text: d.text,
            entities: [...new Set([...target.entities, ...mem.entities])],
            sources: [...new Set([...target.sources, ...mem.sources])],
            evidence,
            integrity,
            confidence: computeConfidence(evidence, integrity),
            tier: target.tier,
            version: (target.version || 1) + 1,
            supersedes: [target.id],
          };
          this.store.putMemory(userId, next, vec);
          this.store.patchMemory(userId, target.id, { status: "superseded", supersededBy: next.id, supersedeReason: "refined" });
          report.updated++;
        } else if (d.op === "INVALIDATE" && target) {
          const verdict = this.guard.verifySleepOp({ op: "INVALIDATE", target, by: mem }, (ids) => this.store.getTurns(userId, ids));
          this.store.putMemory(userId, verdict.ok ? mem : { ...mem, flags: { ...mem.flags, conflictsWith: target.id } }, vecs[i]);
          if (verdict.ok) {
            this.store.patchMemory(userId, target.id, { status: "superseded", supersededBy: mem.id, invalidAt: mem.eventTime || mem.recordedAt, supersedeReason: "contradicted", tier: "archival" });
            report.invalidated++;
          } else {
            this.store.quarantine(userId, { type: "write.invalidate_rejected", reason: verdict.reason, target: target.id, by: mem.id });
            report.added++;
          }
        } else {
          this.store.putMemory(userId, mem, vecs[i]);
          report.added++;
        }
      }
    }

    this.store.log(userId, { type: "consolidate", report });
    this.timings.writeMs += Date.now() - started;
    return report;
  }

  applyNoop(userId, existing, mem, now) {
    this.store.patchMemory(userId, existing.id, reaffirm(existing, mem, now));
  }

  /**
   * Retrieve memory context for a query.
   * @returns {Promise<{context: string, core: object[], items: object[]}>}
   */
  async retrieve(userId, query, { now, k, subject, includeHistory = true } = {}) {
    const started = Date.now();
    const t = parseDate(now) || new Date();
    const res = await retrieveCore(this.ctx, userId, query, {
      now: t,
      k: k ?? this.options.retrieve.k,
      coreMax: this.options.retrieve.coreMax,
      subject,
      includeHistory,
    });
    const fps = this.fingerprints.get(userId) || [];
    const context = this.guard.inspectOutput(renderContext(res, { now: t }), fps);
    for (const it of [...res.core, ...res.items]) it.text = this.guard.inspectOutput(it.text, fps);
    this.timings.readMs += Date.now() - started;
    return { context, ...res };
  }

  /** Sleep: flush pending turns, then run guarded consolidation. */
  async sleep(userId, { now } = {}) {
    await this.flush(userId);
    if (!this.options.sleep.enabled) return { skipped: true };
    const started = Date.now();
    const t = parseDate(now) || new Date();
    const report = await runSleep(this.ctx, userId, { now: t, options: this.options.sleep });
    this.timings.sleepMs += Date.now() - started;
    return report;
  }

  /**
   * Right-to-be-forgotten with provenance cascade: deleting turns deletes every memory
   * derived from them — including merged/consolidated descendants — so nothing survives
   * in a summary. Returns counts for residue auditing.
   * @param {{session?: string, turnIds?: string[], memoryIds?: string[]}} what
   */
  async forget(userId, what = {}) {
    const s = this.store.ns(userId);
    const turnIds = new Set(what.turnIds || []);
    if (what.session != null) for (const t of s.turns.values()) if (t.session === String(what.session)) turnIds.add(t.id);
    const doomed = new Set(what.memoryIds || []);
    for (const m of s.memories.values()) if (m.sources.some((id) => turnIds.has(id))) doomed.add(m.id);
    // Cascade to descendants (merges/refinements built from a doomed memory carry its content).
    let grew = true;
    while (grew) {
      grew = false;
      for (const m of s.memories.values()) {
        if (doomed.has(m.id)) continue;
        if ([].concat(m.supersedes || [], m.mergedFrom || []).some((p) => doomed.has(p))) {
          doomed.add(m.id);
          grew = true;
        }
      }
    }
    // Surviving parents of a deleted merge/refinement become current again.
    for (const m of s.memories.values()) {
      if (!doomed.has(m.id) && m.status === "superseded" && doomed.has(m.supersededBy) && m.supersedeReason !== "contradicted") {
        this.store.patchMemory(userId, m.id, { status: "live", supersededBy: null, supersedeReason: null });
      }
    }
    for (const id of doomed) this.store.deleteMemory(userId, id);
    for (const id of turnIds) s.turns.delete(id);
    const queue = this.pending.get(userId) || [];
    this.pending.set(userId, queue.filter((t) => !turnIds.has(t.id)));
    this.store.log(userId, { type: "forget", turns: turnIds.size, memories: doomed.size });
    return { turnsDeleted: turnIds.size, memoriesDeleted: doomed.size };
  }

  stats(userId) {
    const mems = this.store.memories(userId);
    const by = (f) => mems.reduce((acc, m) => ((acc[f(m)] = (acc[f(m)] || 0) + 1), acc), {});
    const s = this.store.ns(userId);
    return {
      turns: s.turns.size,
      memories: mems.length,
      byStatus: by((m) => m.status),
      byTier: by((m) => m.tier),
      byIntegrity: by((m) => m.integrity),
      quarantined: s.quarantine.length,
      guard: { ...this.guard.stats },
      cost: this.meter.snapshot(),
      timings: { ...this.timings },
    };
  }
}

export function createRemind(opts = {}) {
  return new Remind(opts);
}

export { LLMClient, CostMeter, LocalStore, MemGuard };
export default createRemind;
