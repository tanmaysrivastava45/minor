import { addDays, parseDate } from "../util/time.js";

/**
 * Memory lifecycle: confidence from evidence, validity windows and status.
 *
 * Confidence is NOT a number the LLM makes up. It is a noisy-OR over *independent*
 * evidence, where evidence from the same session counts once (max reliability). Saying
 * a false claim 20 times in one session therefore cannot out-vote one explicit statement —
 * the "repetition inflation" attack on confidence-driven sleep.
 */

export const RELIABILITY = {
  user: { explicit: 0.8, implicit: 0.6 },
  assistant: { explicit: 0.35, implicit: 0.3 },
  tool: { explicit: 0.25, implicit: 0.2 },
  document: { explicit: 0.25, implicit: 0.2 },
};

export const LOW_INTEGRITY_CAP = 0.6;

export function evidenceReliability(e) {
  const r = RELIABILITY[e.author] || RELIABILITY.tool;
  return e.explicit === false ? r.implicit : r.explicit;
}

/** @param {{session: string, author: string, explicit: boolean}[]} evidence */
export function computeConfidence(evidence, integrity = "high") {
  const bySession = new Map();
  for (const e of evidence) {
    const r = evidenceReliability(e);
    bySession.set(e.session, Math.max(bySession.get(e.session) || 0, r));
  }
  let miss = 1;
  for (const r of bySession.values()) miss *= 1 - r;
  let c = 1 - miss;
  if (integrity === "low") c = Math.min(c, LOW_INTEGRITY_CAP);
  return Math.round(Math.min(c, 0.99) * 1000) / 1000;
}

export function independentSessions(evidence) {
  return new Set(evidence.map((e) => e.session)).size;
}

/** Defaults in days. Prospective memories expire at their date; states go stale if never re-affirmed. */
export const VALIDITY = {
  staleAfterDays: { immutable: null, semi_mutable: 730, mutable: 180 },
  assurityDays: { prospective: 7, factual: 30, episodic: 30 },
};

/**
 * Compute validity fields for a new memory.
 * @param {object} m   { kind, hardness, eventTime, validUntil }
 * @param {Date} now   conversation time (NOT wall-clock), so benchmarks exercise decay correctly
 */
export function initialValidity(m, now) {
  let expiresAt = null;
  if (m.kind === "prospective") {
    const until = parseDate(m.validUntil) || parseDate(m.eventTime);
    expiresAt = until && until > now ? addDays(until, 1) : until ? addDays(now, 1) : addDays(now, 14);
  } else if (m.validUntil) {
    expiresAt = parseDate(m.validUntil);
  }
  return {
    expiresAt: expiresAt ? expiresAt.toISOString() : null,
    assurityDays: VALIDITY.assurityDays[m.kind] ?? 30,
    lastAffirmedAt: now.toISOString(),
  };
}

/**
 * @returns {"active"|"stale"|"grace"|"dormant"|"superseded"|"quarantined"}
 *  grace   = past validity but inside the assurity window: still retrievable; re-affirmation rescues it
 *  dormant = past validity + assurity: kept in the archive, excluded from "current" answers,
 *            purged by sleep only if the forgetting policy allows it
 */
export function statusAt(m, now) {
  if (m.status === "superseded" || m.status === "quarantined") return m.status;
  if (m.expiresAt) {
    const exp = new Date(m.expiresAt);
    if (now > addDays(exp, m.assurityDays ?? 7)) return "dormant";
    if (now > exp) return "grace";
  }
  const staleDays = VALIDITY.staleAfterDays[m.hardness] ?? null;
  if (staleDays && m.lastAffirmedAt && now > addDays(new Date(m.lastAffirmedAt), staleDays)) return "stale";
  return "active";
}

export const STATUS_WEIGHT = { active: 1, stale: 0.85, grace: 0.8, superseded: 0.55, dormant: 0.45, quarantined: 0 };
