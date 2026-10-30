import http from "node:http";

/**
 * Local OpenAI-compatible pass-through that meters tokens/cost of third-party memory
 * systems (Mem0, Letta) into the same CostMeter we use for REMind, so cost/latency
 * comparisons are apples-to-apples. Point the system's `baseURL` at `proxy.url`.
 */
export async function startUsageProxy({ upstream, apiKey, meter, billing, tagPrefix = "baseline" }) {
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks);
    let body = null;
    try {
      body = JSON.parse(raw.toString("utf8") || "null");
    } catch {
      // non-JSON body: forward untouched
    }
    const endpoint = req.url.replace(/^\/v1/, "");
    const started = Date.now();
    try {
      meter.check();
      const upstreamRes = await fetch(`${upstream}${endpoint}`, {
        method: req.method,
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: req.method === "GET" ? undefined : raw,
      });
      const text = await upstreamRes.text();
      if (upstreamRes.ok) {
        try {
          const data = JSON.parse(text);
          const isEmbed = endpoint.startsWith("/embeddings");
          meter.record({
            tag: `${tagPrefix}.${isEmbed ? "embed" : "chat"}`,
            billing,
            model: body?.model,
            inputTokens: data.usage?.prompt_tokens || 0,
            outputTokens: isEmbed ? 0 : data.usage?.completion_tokens || 0,
            latencyMs: Date.now() - started,
          });
        } catch {
          // streaming or non-JSON response: not metered
        }
      }
      res.writeHead(upstreamRes.status, { "Content-Type": upstreamRes.headers.get("content-type") || "application/json" });
      res.end(text);
    } catch (err) {
      res.writeHead(err.name === "BudgetExceededError" ? 402 : 502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: err.message } }));
    }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  return { url: `http://127.0.0.1:${port}/v1`, close: () => new Promise((r) => server.close(r)) };
}
