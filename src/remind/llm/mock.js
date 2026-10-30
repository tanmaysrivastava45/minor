import { contentTokens, sha256, lexicalSupport } from "../util/text.js";

/**
 * Deterministic offline stand-in for an LLM so the whole pipeline (and the benchmark
 * harness) can be smoke-tested for $0. It is NOT a quality baseline.
 * Prompts emit turns as lines: `[t12] (user) Caroline @2023-05-08: text`.
 */

const TURN_RE = /^\[(t\d+)\]\s+\((\w+)\)\s+([^@:]+?)\s*(?:@(\S+))?:\s*(.+)$/;

function userText(messages) {
  const user = messages.filter((m) => m.role === "user");
  return (user.length ? user : messages).map((m) => m.content).join("\n");
}

function turnsFrom(text) {
  return text
    .split("\n")
    .map((l) => l.match(TURN_RE))
    .filter(Boolean)
    .map((m) => ({ id: m[1], author: m[2], speaker: m[3].trim(), date: m[4] || null, text: m[5] }));
}

export function mockChat(tag, messages) {
  const text = userText(messages);
  switch (tag) {
    case "remind.classify": {
      return JSON.stringify({
        labels: turnsFrom(text).map((t) => ({ id: t.id, label: contentTokens(t.text).length >= 3 ? "factual" : "skip" })),
      });
    }
    case "remind.extract": {
      const memories = turnsFrom(text)
        .filter((t) => contentTokens(t.text).length >= 3)
        .map((t) => ({
          text: `${t.speaker}: ${t.text}`,
          subject: t.author === "user" ? t.speaker : "Assistant",
          kind: /\b(tomorrow|next week|meeting|appointment|plan)\b/i.test(t.text) ? "prospective" : "factual",
          hardness: /\b(name|born|birthday)\b/i.test(t.text) ? "immutable" : "mutable",
          event_time: (t.text.match(/\b\d{4}-\d{2}-\d{2}\b/) || [])[0] || t.date,
          valid_until: (t.text.match(/\b\d{4}-\d{2}-\d{2}\b/) || [])[0] || null,
          entities: contentTokens(t.text).slice(0, 3),
          explicit: true,
          source_turns: [t.id],
        }));
      return JSON.stringify({ memories });
    }
    case "remind.update":
      return JSON.stringify({ decisions: [] });
    case "remind.sleep":
      return JSON.stringify({ ops: [] });
    case "memgpt.ingest":
      return JSON.stringify({
        actions: turnsFrom(text)
          .filter((t) => contentTokens(t.text).length >= 3)
          .map((t) => ({ op: "archival_insert", text: `${t.speaker}: ${t.text}` })),
      });
    case "bench.judge": {
      const gold = (text.match(/Gold answer:\s*(.+)/i) || [])[1] || "";
      const gen = (text.match(/Generated answer:\s*([\s\S]+?)(?:\n\n|$)/i) || [])[1] || "";
      return JSON.stringify({ label: lexicalSupport(gold, gen) >= 0.5 ? "CORRECT" : "WRONG" });
    }
    case "bench.judge.lme":
      return "no";
    default: {
      // Answer generation: echo the first memory line that overlaps the question most.
      const q = (text.match(/Question:\s*(.+)/i) || [])[1] || "";
      const lines = text.split("\n").filter((l) => /\d{4}-\d{2}-\d{2}/.test(l) && !/^\s*Question:/i.test(l));
      let best = "I don't know";
      let bestScore = 0;
      for (const l of lines) {
        const s = lexicalSupport(q, l);
        if (s > bestScore) {
          bestScore = s;
          best = l.replace(/^[\s"-]+|[",]+$/g, "");
        }
      }
      return best;
    }
  }
}

/** Hashed bag-of-words embedding (256-d), stable across runs. */
export function mockEmbed(text) {
  const v = new Array(256).fill(0);
  for (const tok of contentTokens(text)) {
    const h = parseInt(sha256(tok).slice(0, 8), 16);
    v[h % 256] += 1;
  }
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / n);
}
