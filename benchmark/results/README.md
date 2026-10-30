# Benchmark Results

This directory contains the results from the CortexMemory benchmark suite.

## Files

| File | Description |
|------|-------------|
| `benchmark_report.md` | Full comparison report with all metrics |
| `all_reports.json` | Raw evaluation data for all systems |
| `cortex_raw.json` | Raw CortexMemory Q&A results |
| `mem0_raw.json` | Raw Mem0 Q&A results |
| `zep_raw.json` | Raw Zep Q&A results |
| `baseline_raw.json` | Raw Full-Context Baseline Q&A results |

## Running Benchmarks

```bash
# Run all benchmarks
npm run benchmark

# Run specific system only
node benchmark/runAll.js cortex
node benchmark/runAll.js mem0
node benchmark/runAll.js baseline
node benchmark/runAll.js zep

# Run individual runners
npm run benchmark:cortex
npm run benchmark:mem0
npm run benchmark:baseline
```

## Metrics

| Metric | Description |
|--------|-------------|
| **F1 Score** | Token-level overlap between predicted and ground truth |
| **Accuracy** | LLM-as-Judge binary correct/incorrect |
| **LLM Quality** | GPT-4.1-mini rates answer quality 0-5 |
| **BLEU** | N-gram precision for answer quality |
| **ROUGE-L** | Longest common subsequence for recall |
| **Latency** | Average response time per question |
| **Conflict Resolution** | % of preference-change questions answered correctly |
| **Temporal Reasoning** | % of temporal questions answered correctly |
