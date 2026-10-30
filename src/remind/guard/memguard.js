import { scanText, redact, secretFingerprints, injectionSignals } from "./detectors.js";
import { lexicalSupport } from "../util/text.js";
import { humanDay, isoDay } from "../util/time.js";

/**
 * MemGuard — the firewall that sits on every edge of the memory system:
 *   W (write gate):  raw turn -> recall store, candidate memory -> archival store
 *   S (sleep gate):  every operation proposed during sleep is verified before commit
 *   R (read gate):   retrieved context -> model prompt
 *
 * Integrity labels: "high" (explicitly stated by the user), "medium" (inferred from user
 * turns), "low" (anything derived from assistant/tool/document text). Integrity can only
 * go DOWN through merges (min-propagation), never up — this is what blocks "provenance
 * laundering", where untrusted text becomes a trusted user fact after consolidation.
 */

const INTEGRITY_RANK = { low: 0, medium: 1, high: 2 };
export const minIntegrity = (...levels) =>
  levels.reduce((a, b) => (INTEGRITY_RANK[b] < INTEGRITY_RANK[a] ? b : a), "high");
export const integrityAtLeast = (level, floor) => INTEGRITY_RANK[level] >= INTEGRITY_RANK[floor];

export class MemGuard {
  constructor({ enabled = true, minGrounding = 0.35, minMergeSupport = 0.6 } = {}) {
    this.enabled = enabled;
    this.minGrounding = minGrounding;
    this.minMergeSupport = minMergeSupport;
    this.stats = { turnsBlocked: 0, turnsRedacted: 0, candidatesRejected: 0, candidatesRelabelled: 0, sleepOpsRejected: 0, outputRedactions: 0 };
  }

  /** W0: sanitize a raw turn before it is persisted or sent to any model. */
  inspectTurn(turn) {
    if (!this.enabled) return { turn, findings: [], fingerprints: [] };
    const { findings, hasBlock, hasRedact } = scanText(turn.text);
    if (hasBlock) this.stats.turnsBlocked++;
    else if (hasRedact) this.stats.turnsRedacted++;
    return {
      turn: findings.length ? { ...turn, text: redact(turn.text, findings), guarded: findings.map((f) => f.type) } : turn,
      findings,
      fingerprints: secretFingerprints(findings),
    };
  }

  /**
   * W1: decide whether an extracted candidate memory may be written.
   * @param {object} cand        candidate from the extractor
   * @param {Map} turnsById      id -> stored (already sanitized) turn
   * @param {string[]} fingerprints  secrets seen in this batch (pre-redaction digits/tokens)
   * @returns {{accept: boolean, reasons: string[], memory: object}}
   */
  checkCandidate(cand, turnsById, fingerprints = []) {
    const reasons = [];
    let text = String(cand.text || "").trim();
    if (!text) return { accept: false, reasons: ["empty"], memory: cand };

    // Provenance: keep only citations to real turns; otherwise attach the best lexical match.
    let sources = (cand.source_turns || []).filter((id) => turnsById.has(id));
    if (sources.length === 0) {
      let best = null;
      let bestScore = 0;
      for (const [id, t] of turnsById) {
        const s = lexicalSupport(text, t.text);
        if (s > bestScore) {
          bestScore = s;
          best = id;
        }
      }
      if (best) sources = [best];
      reasons.push("uncited");
    }
    const srcTurns = sources.map((id) => turnsById.get(id));
    const evidence = srcTurns.map((t) => `${t.speaker || ""} ${t.text} ${t.date ? `${humanDay(t.date)} ${isoDay(t.date)}` : ""}`).join("\n");
    const grounding = lexicalSupport(text, evidence);

    if (!this.enabled) {
      return { accept: true, reasons, memory: { ...cand, text, sources, grounding, integrity: "high", flags: {} } };
    }

    // Secrets: never store, even if the extractor paraphrased them.
    const scan = scanText(text);
    if (scan.hasBlock) {
      this.stats.candidatesRejected++;
      return { accept: false, reasons: ["secret_in_memory"], memory: cand };
    }
    const digits = text.replace(/\D/g, "");
    if (fingerprints.some((fp) => fp.length >= 4 && (/^\d+$/.test(fp) ? digits.includes(fp) : text.toLowerCase().includes(fp)))) {
      this.stats.candidatesRejected++;
      return { accept: false, reasons: ["secret_fingerprint"], memory: cand };
    }
    if (scan.hasRedact) text = redact(text, scan.findings);

    const authors = new Set(srcTurns.map((t) => t.author || "user"));
    const userOnly = [...authors].every((a) => a === "user");
    let subject = cand.subject || "User";
    let integrity = userOnly ? (cand.explicit === false ? "medium" : "high") : "low";
    const flags = {};

    // Untrusted text may never become a fact *about the user*: relabel it as an assistant/tool claim.
    if (!userOnly && subject !== "Assistant") {
      const who = authors.has("assistant") ? "Assistant" : "External content";
      if (!/^(assistant|external content)\b/i.test(text)) text = `${who} said: ${text}`;
      subject = who === "Assistant" ? "Assistant" : "External";
      reasons.push("relabelled_untrusted_source");
      this.stats.candidatesRelabelled++;
    }

    const inj = injectionSignals(text);
    if (inj.hit) {
      if (!userOnly) {
        this.stats.candidatesRejected++;
        return { accept: false, reasons: ["injection_from_untrusted_source", ...inj.hits], memory: cand };
      }
      flags.instruction = true; // user-authored instruction/preference: kept, but never promoted to core
    }
    if (grounding < this.minGrounding) {
      flags.weakGrounding = true;
      integrity = minIntegrity(integrity, "medium");
    }

    return { accept: true, reasons, memory: { ...cand, text, subject, sources, grounding, integrity, flags } };
  }

  /**
   * S: verify one proposed sleep operation against the append-only recall store.
   * @param {object} op       { op: "MERGE"|"INVALIDATE"|"PROMOTE"|"DEMOTE", ... } already resolved to records
   * @param {(ids: string[]) => object[]} getTurns
   * @returns {{ok: boolean, reason?: string}}
   */
  verifySleepOp(op, getTurns, { promoteMinConfidence = 0.8 } = {}) {
    if (!this.enabled) return { ok: true };
    const reject = (reason) => {
      this.stats.sleepOpsRejected++;
      return { ok: false, reason };
    };

    if (op.op === "MERGE") {
      const { inputs, text } = op;
      if (!text || inputs.length < 2) return reject("malformed_merge");
      const subjects = new Set(inputs.map((m) => m.subject));
      if (subjects.size > 1) return reject("cross_subject_merge");
      if (scanText(text).hasBlock) return reject("secret_in_merge");
      if (injectionSignals(text).hit && !inputs.some((m) => injectionSignals(m.text).hit)) return reject("merge_introduced_instruction");
      const turns = getTurns([...new Set(inputs.flatMap((m) => m.sources))]);
      const rawEvidence = turns.map((t) => `${t.speaker || ""} ${t.text} ${t.date ? `${humanDay(t.date)} ${isoDay(t.date)}` : ""}`).join("\n");
      const memEvidence = inputs.map((m) => m.text).join("\n");
      if (lexicalSupport(text, `${rawEvidence}\n${memEvidence}`) < this.minMergeSupport) return reject("merge_not_supported_by_inputs");
      if (lexicalSupport(text, rawEvidence) < this.minGrounding) return reject("merge_not_grounded_in_recall");
      return { ok: true };
    }

    if (op.op === "INVALIDATE") {
      const { target, by } = op;
      if (!target || !by || target.id === by.id) return reject("malformed_invalidate");
      if (target.subject !== by.subject) return reject("cross_subject_invalidate");
      if (!integrityAtLeast(by.integrity, target.integrity)) return reject("lower_integrity_cannot_invalidate");
      if (target.hardness === "immutable" && !(by.integrity === "high" && by.explicit !== false)) return reject("immutable_needs_explicit_user_evidence");
      const tTime = target.eventTime || target.recordedAt;
      const bTime = by.eventTime || by.recordedAt;
      if (tTime && bTime && new Date(bTime) < new Date(tTime)) return reject("invalidator_is_older");
      return { ok: true };
    }

    if (op.op === "PROMOTE") {
      const m = op.target;
      if (!m) return reject("malformed_promote");
      if (m.integrity !== "high") return reject("promote_requires_high_integrity");
      if (m.flags?.instruction) return reject("instructions_never_core");
      if (m.flags?.weakGrounding) return reject("promote_requires_grounding");
      if (m.confidence < promoteMinConfidence) return reject("promote_requires_confidence");
      return { ok: true };
    }

    if (op.op === "DEMOTE") return { ok: true };
    return reject("unknown_op");
  }

  /** R: last check before memory text enters a prompt or leaves the system. */
  inspectOutput(text, fingerprints = []) {
    if (!this.enabled) return text;
    const { findings } = scanText(text);
    let out = findings.length ? redact(text, findings) : text;
    for (const fp of fingerprints) {
      if (fp.length >= 4 && out.includes(fp)) out = out.split(fp).join("[REDACTED]");
    }
    if (out !== text) this.stats.outputRedactions++;
    return out;
  }
}
