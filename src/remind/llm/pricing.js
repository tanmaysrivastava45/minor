/**
 * USD per 1M tokens. Verified 2026-10-31 against
 * https://developers.openai.com/api/docs/pricing and
 * https://ai.google.dev/gemini-api/docs/pricing and https://docs.typesafe.ai.
 * Gemini free-tier calls are billed at 0 (free tier content may be used by Google
 * to improve its products — only send public benchmark data on the free tier).
 */
export const PRICES = {
  // OpenAI chat
  "gpt-4o-mini": { input: 0.15, output: 0.6 },
  "gpt-4.1-mini": { input: 0.4, output: 1.6 },
  "gpt-4.1-nano": { input: 0.1, output: 0.4 },
  "gpt-5-mini": { input: 0.25, output: 2.0 },
  "gpt-5-nano": { input: 0.05, output: 0.4 },
  // OpenAI embeddings
  "text-embedding-3-small": { input: 0.02, output: 0 },
  "text-embedding-3-large": { input: 0.13, output: 0 },
  // Gemini paid tier (free tier is billed as 0 via the "gemini-free" billing key)
  "gemini-3.1-flash-lite": { input: 0.25, output: 1.5 },
  // TypeSafe Jev (output tokens are free)
  "jev-latest": { input: 0.042, output: 0 },
  // Mock provider
  mock: { input: 0, output: 0 },
};

export function priceFor(provider, model) {
  if (provider === "gemini-free" || provider === "mock") return { input: 0, output: 0 };
  return PRICES[model] || null;
}

export function costUSD(provider, model, inputTokens, outputTokens) {
  const p = priceFor(provider, model);
  if (!p) return 0;
  return (inputTokens * p.input + outputTokens * p.output) / 1e6;
}
