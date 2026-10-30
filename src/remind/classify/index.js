import { contentTokens, sha256 } from "../util/text.js";
import { DiskCache } from "../llm/client.js";

/**
 * L1 write gate: decide cheaply which turns are worth sending to the (expensive) LLM
 * extractor. Errs on the side of keeping — a skipped turn is unrecoverable recall loss,
 * so we only skip when the classifier is confident the turn is chit-chat.
 *
 * Every classifier returns Map<turnId, { keep: boolean, kind: string, confidence: number }>.
 */

export const KIND_CRITERIA = {
  personal_fact:
    "States a lasting fact about a person: name, identity, family, relationships, job, school, home, possessions, pets, health, skills or background.",
  preference: "Expresses a like, dislike, opinion, habit, value, or how the person wants things done.",
  event: "Describes something that happened or an experience the person had, often with feelings or details like place, date or people.",
  plan: "Mentions a future plan, appointment, meeting, schedule, deadline, trip or intention.",
  assistant_info:
    "An assistant reply that gives specific recommendations, names, numbers, lists or facts the person may ask about later.",
  chitchat:
    "Greetings, thanks, acknowledgements, filler, generic small talk, or general-knowledge questions that reveal nothing about the person.",
};

const FILLER_RE = /^(?:hi|hey|hello|yo|ok(?:ay)?|sure|thanks?(?: you)?(?: so much)?|great|cool|nice|awesome|lol|haha|bye|good (?:night|morning)|see you|you too|same here|wow|yeah|yep|nope|no worries)[!. ]*$/i;

export class HeuristicClassifier {
  name = "heuristic";

  async classify(turns) {
    const out = new Map();
    for (const t of turns) {
      const text = String(t.text || "").trim();
      const toks = contentTokens(text);
      const signal = /\d/.test(text) || /\b[A-Z][a-z]+/.test(text.slice(1)) || /\b(?:i|my|me|we|our)\b/i.test(text);
      const skip = FILLER_RE.test(text) || (toks.length < 3 && !signal);
      out.set(t.id, { keep: !skip, kind: skip ? "chitchat" : "unknown", confidence: skip ? 0.9 : 0.5 });
    }
    return out;
  }
}

export class LLMClassifier {
  name = "llm";

  constructor(llm) {
    this.llm = llm;
  }

  async classify(turns) {
    const lines = turns.map((t) => `[${t.id}] (${t.author}) ${t.speaker}: ${t.text}`).join("\n");
    const labels = Object.keys(KIND_CRITERIA);
    const { json } = await this.llm.chat({
      tag: "remind.classify",
      json: true,
      maxTokens: 40 + turns.length * 20,
      system: `Label each message for a long-term personal memory system. Labels:\n${labels
        .map((k) => `- ${k}: ${KIND_CRITERIA[k]}`)
        .join("\n")}\nReturn JSON {"labels":[{"id":"t1","label":"<label>"}]} with one entry per message.`,
      user: lines,
    });
    const out = new Map(turns.map((t) => [t.id, { keep: true, kind: "unknown", confidence: 0.5 }]));
    for (const l of json?.labels || []) {
      if (!out.has(l.id)) continue;
      const kind = labels.includes(l.label) ? l.label : "unknown";
      out.set(l.id, { keep: kind !== "chitchat", kind, confidence: 0.8 });
    }
    return out;
  }
}

/**
 * TypeSafe Jev (non-generative "System One" decision model).
 * API per https://docs.typesafe.ai/api/system-one.md: POST /v1/systemone with
 * { model, state, questions: { <name>: { type: "choice", instructions, criteria: {label: description} } } }
 * -> { answers: { <name>: { choice, confidence, probabilities } }, usage }.
 * Only MemGuard-redacted text is sent: Jev is a third-party cloud API.
 */
export class JevClassifier {
  name = "jev";

  constructor({
    apiKey = process.env.TYPESAFE_API_KEY,
    baseURL = process.env.TYPESAFE_API_BASE || "https://api.typesafe.ai",
    model = process.env.JEV_MODEL || "jev-latest",
    meter,
    cacheDir = process.env.REMIND_CACHE_DIR || ".cache/llm",
    skipThreshold = 0.7,
    concurrency = 4,
  } = {}) {
    if (!apiKey) throw new Error("JevClassifier needs TYPESAFE_API_KEY");
    Object.assign(this, { apiKey, baseURL, model, meter, skipThreshold, concurrency });
    this.cache = new DiskCache(cacheDir);
  }

  async decide(turn, previous) {
    const state = previous
      ? `Previous message (${previous.speaker}): ${previous.text}\nLatest message (${turn.speaker}, ${turn.author}): ${turn.text}`
      : `Latest message (${turn.speaker}, ${turn.author}): ${turn.text}`;
    const body = {
      model: this.model,
      state,
      questions: {
        kind: {
          type: "choice",
          instructions: "Classify the latest message for a long-term personal memory system.",
          criteria: KIND_CRITERIA,
        },
      },
    };
    const key = sha256({ jev: body });
    let data = this.cache.get(key);
    let cached = true;
    const started = Date.now();
    if (!data) {
      cached = false;
      this.meter?.check();
      for (let attempt = 0; ; attempt++) {
        const res = await fetch(`${this.baseURL}/v1/systemone`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.apiKey}` },
          body: JSON.stringify(body),
        });
        if (res.ok) {
          data = await res.json();
          break;
        }
        if ((res.status === 429 || res.status === 529 || res.status >= 500) && attempt < 5) {
          await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
          continue;
        }
        throw new Error(`Jev HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
      }
      this.cache.set(key, data);
    }
    this.meter?.record({
      tag: "remind.classify.jev",
      billing: "typesafe",
      model: "jev-latest",
      inputTokens: data.usage?.input_tokens || 0,
      outputTokens: data.usage?.output_tokens || 0,
      latencyMs: Date.now() - started,
      cached,
    });
    const ans = data.answers?.kind || {};
    const kind = ans.choice || "unknown";
    const confidence = typeof ans.confidence === "number" ? ans.confidence : 0.5;
    return { keep: !(kind === "chitchat" && confidence >= this.skipThreshold), kind, confidence };
  }

  async classify(turns) {
    const out = new Map();
    let i = 0;
    const worker = async () => {
      while (i < turns.length) {
        const idx = i++;
        out.set(turns[idx].id, await this.decide(turns[idx], turns[idx - 1]));
      }
    };
    await Promise.all(Array.from({ length: Math.min(this.concurrency, turns.length) }, worker));
    return out;
  }
}

export class KeepAllClassifier {
  name = "none";

  async classify(turns) {
    return new Map(turns.map((t) => [t.id, { keep: true, kind: "unknown", confidence: 1 }]));
  }
}

export function createClassifier(kind, { llm, meter } = {}) {
  switch (kind) {
    case "jev":
      return new JevClassifier({ meter });
    case "llm":
      return new LLMClassifier(llm);
    case "none":
      return new KeepAllClassifier();
    case "heuristic":
    default:
      return new HeuristicClassifier();
  }
}
