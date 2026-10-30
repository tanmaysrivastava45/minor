import { computeConfidence, independentSessions, statusAt } from "./lifecycle.js";
import { minIntegrity } from "../guard/memguard.js";

const SLEEP_SYSTEM = `You are the offline "sleep" consolidation phase of a long-term memory system.
For each CLUSTER of related memories propose operations:
- {"op":"MERGE","ids":["a","b"],"text":"..."}: the memories describe the SAME fact or the SAME event (duplicates or complementary details). Write one memory that keeps every specific detail, name, number and date from the inputs and adds nothing else. Never merge different events, different items of a list, or memories about different people.
- {"op":"INVALIDATE","target":"a","by":"b"}: memory "a" is outdated because the newer memory "b" says the situation changed.
- Nothing to do for a cluster: emit no op.
Return JSON {"ops":[...]}. Use only the ids shown.`;

const HARDNESS_RANK = { mutable: 0, semi_mutable: 1, immutable: 2 };

/**
 * Transactional sleep:
 *   1. lifecycle pass (deterministic): compute status, optionally purge dormant low-confidence memories
 *   2. cluster memories touched since the last sleep with their near neighbours
 *   3. ONE batched LLM call per group of clusters proposes MERGE / INVALIDATE
 *   4. deterministic PROMOTE / DEMOTE proposals for the core tier
 *   5. MemGuard-S verifies every op against the append-only recall store
 *   6. accepted ops are committed atomically; rejected ops go to quarantine with a reason
 */
export async function runSleep(ctx, userId, { now, options }) {
  const { store, llm, guard } = ctx;
  const o = options;
  const ns = store.ns(userId);
  const since = ns.meta.lastSleepAt ? new Date(ns.meta.lastSleepAt) : new Date(0);
  const report = { proposed: 0, accepted: 0, rejected: 0, rejectedByReason: {}, merged: 0, invalidated: 0, promoted: 0, demoted: 0, purged: 0 };
  const live = () => store.memories(userId, (m) => m.status === "live");

  // 1. lifecycle pass
  if (o.purgeDormant) {
    for (const m of live()) {
      if (statusAt(m, now) === "dormant" && m.confidence < o.purgeBelowConfidence && m.tier !== "core") {
        store.deleteMemory(userId, m.id);
        store.log(userId, { type: "sleep.purge", memoryId: m.id, reason: "dormant_low_confidence" });
        report.purged++;
      }
    }
  }

  // 2. clusters of recently touched memories
  const dirty = live().filter((m) => new Date(m.recordedAt) > since || new Date(m.lastAffirmedAt) > since);
  const clusterOf = new Map();
  const clusters = [];
  for (const m of dirty) {
    if (clusterOf.has(m.id)) continue;
    const emb = store.embeddingOf(userId, m.id);
    if (!emb) continue;
    const near = store
      .vectorSearch(userId, emb, { k: o.clusterMaxSize, filter: (x) => x.status === "live" && x.subject === m.subject })
      .filter((n) => n.score >= o.clusterSimilarity && !clusterOf.has(n.id));
    if (near.length < 2) continue;
    const ids = near.map((n) => n.id);
    ids.forEach((id) => clusterOf.set(id, clusters.length));
    clusters.push(ids);
    if (clusters.length >= o.maxClustersPerSleep) break;
  }

  // 3. LLM proposals (batched)
  const proposals = [];
  for (let s = 0; s < clusters.length; s += o.clustersPerCall) {
    const group = clusters.slice(s, s + o.clustersPerCall);
    const shortToId = new Map();
    const text = group
      .map((ids, ci) => {
        const lines = ids.map((id) => {
          const m = store.getMemory(userId, id);
          const short = `${String.fromCharCode(97 + (shortToId.size % 26))}${Math.floor(shortToId.size / 26) || ""}`;
          shortToId.set(short, id);
          return `  ${short}: (${m.eventTime || m.recordedAt.slice(0, 10)}) ${m.text}`;
        });
        return `CLUSTER ${ci + 1}:\n${lines.join("\n")}`;
      })
      .join("\n\n");
    const { json } = await llm.chat({ tag: "remind.sleep", json: true, system: SLEEP_SYSTEM, user: text, maxTokens: 200 + group.length * 150 });
    for (const op of json?.ops || []) {
      const kind = String(op.op || "").toUpperCase();
      if (kind === "MERGE") {
        const ids = (op.ids || []).map((x) => shortToId.get(x)).filter(Boolean);
        proposals.push({ op: "MERGE", ids: [...new Set(ids)], text: String(op.text || "").trim() });
      } else if (kind === "INVALIDATE") {
        proposals.push({ op: "INVALIDATE", targetId: shortToId.get(op.target), byId: shortToId.get(op.by) });
      }
    }
  }

  // 4. deterministic core-tier proposals
  for (const m of live()) {
    const eligible =
      m.kind === "factual" &&
      (m.hardness !== "mutable" || independentSessions(m.evidence) >= 2) &&
      m.confidence >= o.promoteMinConfidence;
    if (m.tier !== "core" && eligible) proposals.push({ op: "PROMOTE", targetId: m.id });
    if (m.tier === "core" && (statusAt(m, now) !== "active" || m.confidence < o.promoteMinConfidence * 0.8)) {
      proposals.push({ op: "DEMOTE", targetId: m.id });
    }
  }

  // 5 + 6. verify, then commit atomically
  const accepted = [];
  const getTurns = (ids) => store.getTurns(userId, ids);
  for (const p of proposals) {
    report.proposed++;
    let op;
    if (p.op === "MERGE") op = { op: "MERGE", inputs: p.ids.map((id) => store.getMemory(userId, id)).filter((m) => m?.status === "live"), text: p.text };
    else if (p.op === "INVALIDATE") op = { op: "INVALIDATE", target: store.getMemory(userId, p.targetId), by: store.getMemory(userId, p.byId) };
    else op = { op: p.op, target: store.getMemory(userId, p.targetId) };

    const verdict = guard.verifySleepOp(op, getTurns, { promoteMinConfidence: o.promoteMinConfidence });
    if (verdict.ok) accepted.push(op);
    else {
      report.rejected++;
      report.rejectedByReason[verdict.reason] = (report.rejectedByReason[verdict.reason] || 0) + 1;
      store.quarantine(userId, { type: "sleep.rejected", reason: verdict.reason, op: summarize(op) });
    }
  }

  const mergeTexts = accepted.filter((a) => a.op === "MERGE").map((a) => a.text);
  const mergeVecs = mergeTexts.length ? await llm.embed(mergeTexts, { tag: "remind.embed.sleep" }) : [];

  let mi = 0;
  await store.transaction(userId, async () => {
    for (const op of accepted) {
      if (op.op === "MERGE") {
        const inputs = op.inputs.filter((m) => store.getMemory(userId, m.id)?.status === "live");
        const vec = mergeVecs[mi++];
        if (inputs.length < 2) continue;
        const evidence = inputs.flatMap((m) => m.evidence);
        const integrity = minIntegrity(...inputs.map((m) => m.integrity));
        const merged = {
          ...inputs[0],
          id: store.newId(),
          text: op.text,
          entities: [...new Set(inputs.flatMap((m) => m.entities || []))].slice(0, 16),
          relations: inputs.flatMap((m) => m.relations || []).slice(0, 8),
          sources: [...new Set(inputs.flatMap((m) => m.sources))],
          evidence,
          integrity,
          flags: Object.assign({}, ...inputs.map((m) => m.flags || {})),
          hardness: inputs.map((m) => m.hardness).sort((a, b) => HARDNESS_RANK[b] - HARDNESS_RANK[a])[0],
          eventTime: inputs.map((m) => m.eventTime).filter(Boolean).sort()[0] || null,
          confidence: computeConfidence(evidence, integrity),
          tier: inputs.some((m) => m.tier === "core") && integrity === "high" ? "core" : "archival",
          version: Math.max(...inputs.map((m) => m.version || 1)) + 1,
          supersedes: inputs.map((m) => m.id),
          recordedAt: now.toISOString(),
          lastAffirmedAt: now.toISOString(),
          mergedFrom: inputs.map((m) => m.id),
        };
        store.putMemory(userId, merged, vec);
        for (const m of inputs) store.patchMemory(userId, m.id, { status: "superseded", supersededBy: merged.id, invalidAt: null, supersedeReason: "merged" });
        store.log(userId, { type: "sleep.merge", into: merged.id, from: merged.mergedFrom });
        report.merged++;
      } else if (op.op === "INVALIDATE") {
        store.patchMemory(userId, op.target.id, {
          status: "superseded",
          supersededBy: op.by.id,
          invalidAt: op.by.eventTime || op.by.recordedAt,
          supersedeReason: "contradicted",
          tier: "archival",
        });
        store.log(userId, { type: "sleep.invalidate", target: op.target.id, by: op.by.id });
        report.invalidated++;
      } else if (op.op === "PROMOTE") {
        store.patchMemory(userId, op.target.id, { tier: "core" });
        report.promoted++;
      } else if (op.op === "DEMOTE") {
        store.patchMemory(userId, op.target.id, { tier: "archival" });
        report.demoted++;
      }
      report.accepted++;
    }
  });

  ns.meta.lastSleepAt = now.toISOString();
  store.log(userId, { type: "sleep", report });
  return report;
}

function summarize(op) {
  if (op.op === "MERGE") return { op: "MERGE", inputs: op.inputs.map((m) => m.id), text: op.text };
  return { op: op.op, target: op.target?.id, by: op.by?.id };
}
