#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bootstrapCI, pairedBootstrap, mcnemar, pct } from "./lib/stats.js";

/**
 * Paper-ready comparison on the SAME questions:
 *   node bench/compare.js --dataset locomo --metric p1 remind-run mem0-run memgpt-run
 * The first run is the reference for paired tests (Δ with paired-bootstrap 95% CI, exact McNemar p).
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : d;
};
const dataset = opt("dataset", "locomo");
const metric = opt("metric", dataset === "locomo" ? "p1" : "lme");
const runs = argv.filter((a, i) => !a.startsWith("--") && !argv[i - 1]?.startsWith("--"));
if (!runs.length) {
  console.log("usage: node bench/compare.js --dataset locomo --metric p1 <run> <run> ...");
  process.exit(0);
}

const load = (run) => {
  const dir = path.join(HERE, "results", dataset, run);
  const rows = fs.readFileSync(path.join(dir, "results.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const sumFile = ["summary.json", "summary.partial.json"].map((f) => path.join(dir, f)).find((f) => fs.existsSync(f));
  return { run, rows: new Map(rows.map((r) => [r.id, r])), summary: sumFile ? JSON.parse(fs.readFileSync(sumFile, "utf8")) : {} };
};

const data = runs.map(load);
const shared = [...data[0].rows.keys()].filter((id) => data.every((d) => typeof d.rows.get(id)?.[metric] === "number"));
if (!shared.length) {
  console.log("No questions scored by every run with that metric.");
  process.exit(1);
}
const catKey = dataset === "locomo" ? "categoryName" : "type";
const cats = [...new Set(shared.map((id) => data[0].rows.get(id)[catKey]))].sort();

const header = ["System", `Overall ${metric.toUpperCase()}`, ...cats, "Ctx tokens/q", "Memory $ (ingest+search)"];
const lines = [`| ${header.join(" | ")} |`, `|${header.map(() => "---").join("|")}|`];
for (const d of data) {
  const xs = shared.map((id) => d.rows.get(id)[metric]);
  const ci = bootstrapCI(xs);
  const perCat = cats.map((c) => pct(bootstrapCI(shared.filter((id) => d.rows.get(id)[catKey] === c).map((id) => d.rows.get(id)[metric])).mean));
  const ctx = shared.reduce((n, id) => n + (d.rows.get(id).contextTokens || 0), 0) / shared.length;
  const cost = d.summary.cost?.memorySystem;
  lines.push(`| ${d.summary.system || d.run} | ${pct(ci.mean)} [${pct(ci.lo)}, ${pct(ci.hi)}] | ${perCat.join(" | ")} | ${Math.round(ctx)} | ${cost != null ? `$${cost.toFixed(3)}` : "n/a"} |`);
}
console.log(`\n${dataset} — ${shared.length} shared questions — metric ${metric}\n`);
console.log(lines.join("\n"));

if (data.length > 1) {
  console.log(`\nPaired tests vs ${data[0].summary.system || data[0].run}:`);
  const ref = shared.map((id) => data[0].rows.get(id)[metric]);
  for (const d of data.slice(1)) {
    const other = shared.map((id) => d.rows.get(id)[metric]);
    const diff = pairedBootstrap(ref, other);
    const mc = mcnemar(ref, other);
    console.log(`  vs ${d.summary.system || d.run}: Δ = ${pct(diff.mean)} [${pct(diff.lo)}, ${pct(diff.hi)}], McNemar p = ${mc.p.toPrecision(3)} (ref-only ${mc.onlyA}, other-only ${mc.onlyB})`);
  }
  console.log("\nOnly claim 'better' when the Δ interval excludes 0 (and say so per category, not just overall).");
}
