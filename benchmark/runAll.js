import "dotenv/config";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { evaluateAll, formatReportMarkdown } from "./evaluate.js";
import { runCortexMemoryBenchmark } from "./runners/cortexMemoryRunner.js";
import { runMem0Benchmark } from "./runners/mem0Runner.js";
import { runZepBenchmark } from "./runners/zepRunner.js";
import { runBaselineBenchmark } from "./runners/baselineRunner.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Master Benchmark Orchestrator
 *
 * Runs ALL benchmark runners, evaluates results, and generates
 * a comprehensive comparison report.
 *
 * Systems tested:
 * 1. CortexMemory (ours)
 * 2. Mem0 (via mem0ai SDK)
 * 3. Zep (via @getzep/zep-cloud SDK)
 * 4. Full-Context Baseline (upper bound)
 *
 * Metrics:
 * - F1 Score, Accuracy (LLM Judge), LLM Quality (0-5)
 * - BLEU, ROUGE-L
 * - Latency, Memory Efficiency
 * - Per-category breakdowns
 */

// Parse CLI args to allow running specific systems
const args = process.argv.slice(2);
const runOnlySystems = args.length > 0
  ? args.map((a) => a.toLowerCase())
  : null;

function shouldRun(systemName) {
  if (!runOnlySystems) return true;
  return runOnlySystems.some(
    (s) => systemName.toLowerCase().includes(s) || s.includes(systemName.toLowerCase())
  );
}

async function main() {
  console.log("\n" + "█".repeat(60));
  console.log("  🧠 CortexMemory Benchmark Suite");
  console.log("  Comparing: CortexMemory vs Mem0 vs Zep vs Baseline");
  console.log("█".repeat(60));

  const allResults = {};
  const allReports = {};
  const systemTimings = {};

  // ============================================================
  // Run each system
  // ============================================================

  // 1. Full-Context Baseline (run first — it's the reference)
  if (shouldRun("baseline")) {
    try {
      console.log("\n\n🏁 Running Full-Context Baseline...");
      const result = await runBaselineBenchmark();
      allResults["Full-Context Baseline"] = result;
      systemTimings["Full-Context Baseline"] = result.loadTimeMs;
    } catch (error) {
      console.error("Baseline runner failed:", error.message);
      allResults["Full-Context Baseline"] = {
        system: "Full-Context Baseline",
        results: [],
        error: error.message,
      };
    }
  }

  // 2. CortexMemory (ours)
  if (shouldRun("cortex")) {
    try {
      console.log("\n\n🏁 Running CortexMemory...");
      const result = await runCortexMemoryBenchmark();
      allResults["CortexMemory"] = result;
      systemTimings["CortexMemory"] = result.loadTimeMs;
    } catch (error) {
      console.error("CortexMemory runner failed:", error.message);
      allResults["CortexMemory"] = {
        system: "CortexMemory",
        results: [],
        error: error.message,
      };
    }
  }

  // 3. Mem0
  if (shouldRun("mem0")) {
    try {
      console.log("\n\n🏁 Running Mem0...");
      const result = await runMem0Benchmark();
      allResults["Mem0"] = result;
      systemTimings["Mem0"] = result.loadTimeMs;
    } catch (error) {
      console.error("Mem0 runner failed:", error.message);
      allResults["Mem0"] = {
        system: "Mem0",
        results: [],
        error: error.message,
      };
    }
  }

  // 4. Zep
  if (shouldRun("zep")) {
    try {
      console.log("\n\n🏁 Running Zep...");
      const result = await runZepBenchmark();
      allResults["Zep"] = result;
      systemTimings["Zep"] = result.loadTimeMs;
    } catch (error) {
      console.error("Zep runner failed:", error.message);
      allResults["Zep"] = {
        system: "Zep",
        results: [],
        error: error.message,
      };
    }
  }

  // ============================================================
  // Evaluate all results
  // ============================================================
  console.log("\n\n" + "=".repeat(60));
  console.log("  📊 Evaluating Results...");
  console.log("=".repeat(60));

  for (const [systemName, runResult] of Object.entries(allResults)) {
    if (runResult.skipped || runResult.error || !runResult.results?.length) {
      console.log(`\n⚠️  Skipping evaluation for ${systemName} (no results)`);
      allReports[systemName] = null;
      continue;
    }

    console.log(`\n📊 Evaluating ${systemName}...`);
    const report = await evaluateAll(runResult.results);
    allReports[systemName] = report;
  }

  // ============================================================
  // Generate comparison report
  // ============================================================
  console.log("\n\n" + "=".repeat(60));
  console.log("  📝 Generating Report...");
  console.log("=".repeat(60));

  let markdown = `# 🧠 CortexMemory Benchmark Results\n\n`;
  markdown += `**Date:** ${new Date().toISOString().split("T")[0]}\n`;
  markdown += `**Dataset:** 150 messages, 30 questions (LoCoMo-inspired)\n`;
  markdown += `**LLM:** ${process.env.LLM_MODEL || "gpt-4.1-mini"}\n\n`;

  // Comparison table
  markdown += `## Overall Comparison\n\n`;
  markdown += `| Metric | ${Object.keys(allReports).join(" | ")} |\n`;
  markdown += `|--------|${Object.keys(allReports).map(() => "------").join("|")}|\n`;

  const metrics = ["f1", "accuracy", "llm_quality", "bleu", "rouge_l", "avg_latency_ms"];
  const metricLabels = {
    f1: "F1 Score",
    accuracy: "Accuracy",
    llm_quality: "LLM Quality (0-5)",
    bleu: "BLEU",
    rouge_l: "ROUGE-L",
    avg_latency_ms: "Avg Latency (ms)",
  };

  for (const metric of metrics) {
    const values = Object.entries(allReports).map(([name, report]) => {
      if (!report) return "N/A";
      const val = report.overall[metric];
      if (metric === "avg_latency_ms") return `${val.toFixed(0)}ms`;
      if (metric === "llm_quality") return val.toFixed(2);
      return `${(val * 100).toFixed(1)}%`;
    });
    markdown += `| ${metricLabels[metric]} | ${values.join(" | ")} |\n`;
  }

  // Add load times
  const loadTimes = Object.entries(allResults).map(([name, r]) => {
    return r.loadTimeMs ? `${(r.loadTimeMs / 1000).toFixed(1)}s` : "N/A";
  });
  markdown += `| Load Time | ${loadTimes.join(" | ")} |\n`;

  markdown += `\n`;

  // Per-system detailed reports
  for (const [systemName, report] of Object.entries(allReports)) {
    if (!report) {
      markdown += `\n---\n\n## ${systemName}\n\n*Skipped — system not available.*\n`;
      continue;
    }
    markdown += `\n---\n\n`;
    markdown += formatReportMarkdown(systemName, report);
  }

  // Category comparison
  markdown += `\n---\n\n## Category Comparison\n\n`;
  const categories = [
    "single_hop",
    "multi_hop",
    "temporal",
    "preference_change",
    "episodic",
    "adversarial",
  ];

  for (const cat of categories) {
    markdown += `### ${cat.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())}\n\n`;
    markdown += `| System | F1 | Accuracy | Quality |\n`;
    markdown += `|--------|-----|----------|--------|\n`;

    for (const [systemName, report] of Object.entries(allReports)) {
      if (!report || !report.per_category[cat]) {
        markdown += `| ${systemName} | N/A | N/A | N/A |\n`;
        continue;
      }
      const catReport = report.per_category[cat];
      markdown += `| ${systemName} | ${(catReport.f1 * 100).toFixed(1)}% | ${(catReport.accuracy * 100).toFixed(1)}% | ${catReport.llm_quality.toFixed(1)} |\n`;
    }
    markdown += `\n`;
  }

  // Save report
  const reportPath = path.join(__dirname, "results", "benchmark_report.md");
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, markdown);
  console.log(`\n📄 Report saved to: ${reportPath}`);

  // Save raw data
  const rawPath = path.join(__dirname, "results", "all_reports.json");
  fs.writeFileSync(
    rawPath,
    JSON.stringify({ reports: allReports, timings: systemTimings }, null, 2)
  );
  console.log(`📊 Raw data saved to: ${rawPath}`);

  // Print summary to console
  console.log("\n\n" + "═".repeat(60));
  console.log("  🏆 BENCHMARK SUMMARY");
  console.log("═".repeat(60));

  for (const [systemName, report] of Object.entries(allReports)) {
    if (!report) {
      console.log(`\n  ${systemName}: SKIPPED`);
      continue;
    }
    console.log(`\n  ${systemName}:`);
    console.log(`    F1: ${(report.overall.f1 * 100).toFixed(1)}%`);
    console.log(`    Accuracy: ${(report.overall.accuracy * 100).toFixed(1)}%`);
    console.log(`    Quality: ${report.overall.llm_quality.toFixed(2)}/5`);
    console.log(`    Latency: ${report.overall.avg_latency_ms.toFixed(0)}ms`);
  }

  console.log("\n" + "═".repeat(60));
  console.log(`\n✅ Benchmark complete! See ${reportPath} for full details.\n`);
}

main().catch((error) => {
  console.error("\n❌ Benchmark suite failed:", error);
  process.exit(1);
});
