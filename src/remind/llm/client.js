import fs from "node:fs";
import path from "node:path";
import { sha256, parseJSONLoose, estimateTokens } from "../util/text.js";
import { costUSD } from "./pricing.js";
import { mockChat, mockEmbed } from "./mock.js";

/**
 * Provider-agnostic LLM client (OpenAI, Gemini via its OpenAI-compatible endpoint, or a
 * deterministic offline mock) with:
 *  - a disk cache keyed by the full request, so re-running a benchmark costs $0,
 *  - a cost meter shared by every component (and by benchmark baselines),
 *  - a hard USD budget that aborts the run instead of overspending,
 *  - RPM throttling + exponential backoff for 429/5xx (needed for the Gemini free tier).
 */

export class BudgetExceededError extends Error {
  constructor(spent, budget) {
    super(`LLM budget exceeded: spent $${spent.toFixed(4)} of $${budget.toFixed(2)}`);
    this.name = "BudgetExceededError";
  }
}

const PROVIDERS = {
  openai: {
    baseURL: "https://api.openai.com/v1",
    keyEnv: "OPENAI_API_KEY",
    chatModel: "gpt-4o-mini",
    embedModel: "text-embedding-3-small",
  },
  // Verified: https://ai.google.dev/gemini-api/docs/openai (Bearer auth, /embeddings supported)
  gemini: {
    baseURL: "https://generativelanguage.googleapis.com/v1beta/openai",
    keyEnv: "GEMINI_API_KEY",
    chatModel: "gemini-3.1-flash-lite",
    embedModel: "gemini-embedding-001",
  },
  mock: { baseURL: "", keyEnv: "", chatModel: "mock", embedModel: "mock" },
};

export class CostMeter {
  constructor({ budgetUSD = Infinity } = {}) {
    this.budgetUSD = budgetUSD;
    this.reset();
  }

  reset() {
    this.calls = 0;
    this.cachedCalls = 0;
    this.inputTokens = 0;
    this.outputTokens = 0;
    this.cost = 0;
    this.latencyMs = 0;
    this.byTag = {};
  }

  check() {
    if (this.cost >= this.budgetUSD) throw new BudgetExceededError(this.cost, this.budgetUSD);
  }

  record({ tag = "untagged", billing, model, inputTokens = 0, outputTokens = 0, latencyMs = 0, cached = false }) {
    const cost = cached ? 0 : costUSD(billing, model, inputTokens, outputTokens);
    const t = (this.byTag[tag] ||= { calls: 0, cachedCalls: 0, inputTokens: 0, outputTokens: 0, cost: 0, latencyMs: 0 });
    for (const target of [this, t]) {
      target.calls += 1;
      if (cached) target.cachedCalls += 1;
      target.inputTokens += inputTokens;
      target.outputTokens += outputTokens;
      target.cost += cost;
      target.latencyMs += latencyMs;
    }
  }

  snapshot() {
    return JSON.parse(JSON.stringify({
      calls: this.calls,
      cachedCalls: this.cachedCalls,
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      cost: this.cost,
      latencyMs: this.latencyMs,
      byTag: this.byTag,
    }));
  }
}

export class DiskCache {
  constructor(dir) {
    this.dir = dir;
    if (dir) fs.mkdirSync(dir, { recursive: true });
  }

  file(key) {
    return path.join(this.dir, key.slice(0, 2), `${key}.json`);
  }

  get(key) {
    if (!this.dir) return undefined;
    try {
      return JSON.parse(fs.readFileSync(this.file(key), "utf8"));
    } catch {
      return undefined;
    }
  }

  set(key, value) {
    if (!this.dir) return;
    const f = this.file(key);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, JSON.stringify(value));
  }
}

const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

export class LLMClient {
  /**
   * @param {object} opts
   * @param {"openai"|"gemini"|"mock"} opts.provider
   * @param {string} [opts.apiKey]
   * @param {string} [opts.chatModel]
   * @param {string} [opts.embedModel]
   * @param {string} [opts.cacheDir]  set to null to disable caching
   * @param {number} [opts.rpm]       max requests per minute
   * @param {CostMeter} [opts.meter]
   * @param {boolean} [opts.freeTier] bill Gemini calls at $0
   */
  constructor({
    provider = process.env.REMIND_PROVIDER || "openai",
    apiKey,
    chatModel,
    embedModel,
    baseURL,
    cacheDir = process.env.REMIND_CACHE_DIR || ".cache/llm",
    rpm = Number(process.env.REMIND_RPM) || 0,
    meter = new CostMeter(),
    freeTier = provider === "gemini" && process.env.GEMINI_PAID !== "1",
  } = {}) {
    const p = PROVIDERS[provider];
    if (!p) throw new Error(`Unknown provider "${provider}"`);
    this.provider = provider;
    this.baseURL = baseURL || p.baseURL;
    this.apiKey = apiKey ?? (p.keyEnv ? process.env[p.keyEnv] : "");
    this.chatModel = chatModel || p.chatModel;
    this.embedModel = embedModel || p.embedModel;
    this.cache = new DiskCache(cacheDir);
    this.minIntervalMs = rpm > 0 ? 60000 / rpm : 0;
    this.nextSlot = 0;
    this.meter = meter;
    this.billing = provider === "gemini" && freeTier ? "gemini-free" : provider;
    this.jsonModeSupported = true;
    if (provider !== "mock" && !this.apiKey) {
      throw new Error(`Missing API key for provider "${provider}" (set ${p.keyEnv})`);
    }
  }

  async throttle() {
    if (!this.minIntervalMs) return;
    const now = Date.now();
    const slot = Math.max(now, this.nextSlot);
    this.nextSlot = slot + this.minIntervalMs;
    if (slot > now) await sleepMs(slot - now);
  }

  async post(endpoint, body) {
    let delay = 2000;
    for (let attempt = 0; ; attempt++) {
      await this.throttle();
      const res = await fetch(`${this.baseURL}${endpoint}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify(body),
      });
      if (res.ok) return res.json();
      const text = await res.text();
      const retryable = res.status === 429 || res.status >= 500;
      if (!retryable || attempt >= 6) {
        const err = new Error(`${this.provider} ${endpoint} HTTP ${res.status}: ${text.slice(0, 500)}`);
        err.status = res.status;
        throw err;
      }
      const ra = Number(res.headers.get("retry-after"));
      await sleepMs(ra > 0 ? ra * 1000 : delay);
      delay = Math.min(delay * 2, 60000);
    }
  }

  /**
   * Chat completion. Always temperature 0 so results are cacheable/reproducible.
   * @param {object} req
   * @param {string} [req.system]
   * @param {string} [req.user]
   * @param {object[]} [req.messages]
   * @param {boolean} [req.json]   request a JSON object and parse it
   * @param {number} [req.maxTokens]
   * @param {string} [req.tag]     cost-accounting bucket, e.g. "remind.extract"
   * @param {string} [req.model]
   * @returns {Promise<{text: string, json: any, usage: object, cached: boolean}>}
   */
  async chat({ system, user, messages, json = false, maxTokens = 1500, tag = "chat", model }) {
    const msgs = messages || [
      ...(system ? [{ role: "system", content: system }] : []),
      { role: "user", content: user },
    ];
    const m = model || this.chatModel;
    const key = sha256({ p: this.provider, m, msgs, json, maxTokens });
    const hit = this.cache.get(key);
    if (hit) {
      this.meter.record({ tag, billing: this.billing, model: m, ...hit.usage, cached: true });
      return { ...hit, json: json ? parseJSONLoose(hit.text) : null, cached: true };
    }
    this.meter.check();

    const started = Date.now();
    let text;
    let usage;
    if (this.provider === "mock") {
      text = mockChat(tag, msgs);
      usage = { inputTokens: estimateTokens(JSON.stringify(msgs)), outputTokens: estimateTokens(text) };
    } else {
      const body = { model: m, messages: msgs };
      const reasoningModel = /^(gpt-5|o\d)/.test(m);
      if (!reasoningModel) body.temperature = 0;
      if (this.provider === "openai") body.max_completion_tokens = reasoningModel ? maxTokens * 4 : maxTokens;
      else body.max_tokens = maxTokens;
      if (json && this.jsonModeSupported) body.response_format = { type: "json_object" };
      let data;
      try {
        data = await this.post("/chat/completions", body);
      } catch (err) {
        // Gemini's OpenAI-compat layer is in beta; fall back to prompt-only JSON if json mode is rejected.
        if (json && err.status === 400 && /response_format|json/i.test(err.message)) {
          this.jsonModeSupported = false;
          delete body.response_format;
          data = await this.post("/chat/completions", body);
        } else throw err;
      }
      text = data.choices?.[0]?.message?.content ?? "";
      usage = {
        inputTokens: data.usage?.prompt_tokens ?? estimateTokens(JSON.stringify(msgs)),
        outputTokens: data.usage?.completion_tokens ?? estimateTokens(text),
      };
    }
    const latencyMs = Date.now() - started;
    this.meter.record({ tag, billing: this.billing, model: m, ...usage, latencyMs });
    this.cache.set(key, { text, usage });
    this.meter.check();
    return { text, json: json ? parseJSONLoose(text) : null, usage, cached: false };
  }

  /** Embed texts (cached per text). @returns {Promise<number[][]>} */
  async embed(texts, { tag = "embed" } = {}) {
    const out = new Array(texts.length);
    const missing = [];
    texts.forEach((t, i) => {
      const hit = this.cache.get(sha256({ e: this.provider, m: this.embedModel, t }));
      if (hit) out[i] = hit;
      else missing.push(i);
    });
    for (let s = 0; s < missing.length; s += 64) {
      const idx = missing.slice(s, s + 64);
      const batch = idx.map((i) => texts[i] || " ");
      this.meter.check();
      const started = Date.now();
      let vectors;
      let inputTokens;
      if (this.provider === "mock") {
        vectors = batch.map(mockEmbed);
        inputTokens = batch.reduce((n, t) => n + estimateTokens(t), 0);
      } else {
        const data = await this.post("/embeddings", { model: this.embedModel, input: batch });
        vectors = data.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
        inputTokens = data.usage?.prompt_tokens ?? batch.reduce((n, t) => n + estimateTokens(t), 0);
      }
      this.meter.record({ tag, billing: this.billing, model: this.embedModel, inputTokens, latencyMs: Date.now() - started });
      idx.forEach((i, j) => {
        out[i] = vectors[j];
        this.cache.set(sha256({ e: this.provider, m: this.embedModel, t: texts[i] }), vectors[j]);
      });
    }
    return out;
  }
}

export function createLLM(opts = {}) {
  return new LLMClient(opts);
}
