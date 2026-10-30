# REMind benchmark harness

Everything here runs **without databases** and is **resumable and cached**. Every LLM and embedding
call is cached on disk (`.cache/llm`), so re-running a command costs $0, and `--budget` is a hard cap.

## 0. Free checks (no API key)

```bash
npm install
npm test                                   # engine unit tests (mock LLM)
node bench/run.js --dataset locomo --system remind --convs 0 --max-questions 20 \
  --ingest-provider mock --answer-provider mock --judge-provider mock --run smoke   # plumbing only
node bench/security.js --systems remind,remind-noguard,memgpt,rag --provider mock  # plumbing only
node bench/estimate.js                     # cost estimate for a full LoCoMo run
```

Mock numbers only show that the wiring works. They are **not results**.

## Protocols (what makes the numbers comparable)

| Protocol | Answer prompt | Judge | Use it for |
|---|---|---|---|
| **P1** (default) | Mem0 paper `ANSWER_PROMPT` (verbatim) | Mem0 paper `ACCURACY_PROMPT`, gpt-4o-mini, temp 0 | Comparing with the published LoCoMo table in the Mem0 paper (all gpt-4o-mini) |
| **P2** | same answers as P1 | Mem0's 2026 `memory-benchmarks` judge (very lenient) | Sensitivity analysis only. Mem0's 92.5 uses gpt-4o/gpt-5 + top-200 + this judge, so it is **not comparable** |
| **LME** | `LME_ANSWER_PROMPT` | LongMemEval's own per-type judge prompts | LongMemEval |

LoCoMo categories follow Mem0's mapping: 1 multi-hop (282), 2 temporal (321), 3 open-domain (96),
4 single-hop (841), and 5 adversarial (446, excluded). Total scored: **1,540**.

## Budget plan ($5 OpenAI + free Gemini + optional Jev)

The split is fixed in advance so no one can tune on the test set: **dev = conversation 0**
(iterate freely), **test = conversations 1–9** (run once, report).

| # | Run | Command | ≈ cost |
|---|---|---|---|
| 1 | Pilot + calibration | `node bench/run.js --dataset locomo --system remind --convs 0 --max-questions 40 --budget 0.10` | $0.05 |
| 2 | **Main result** (P1, gpt-4o-mini everywhere = Mem0 paper setup) | `node bench/run.js --dataset locomo --system remind --convs 1,2,3,4,5,6,7,8,9 --protocol both --budget 1.50 --run remind-test` | ~$1.1 |
| 3 | Mem0 OSS head-to-head (same harness, real `mem0ai@3`) | pilot: `--system mem0 --convs 1 --max-questions 30 --budget 0.30`, then `--convs 1,2 --budget 0.80 --run mem0-h2h` | measure in pilot |
| 4 | MemGPT-style + RAG head-to-head | `--system memgpt --convs 1,2 --run memgpt-h2h` · `--system rag --convs 1,2 --run rag-h2h` | ~$0.25 + $0.1 |
| 5 | Ablations (convs 1,2) | `--system remind-nosleep` · `remind-noguard` · `remind-nogate` | ~$0.1 each |
| 6 | Security / privacy suite | `node bench/security.js --systems remind,remind-noguard,mem0,memgpt,rag --budget 0.40` | ~$0.1–0.3 |
| 7 | Jev gate | `--system remind-jev --convs 1,2` (needs `TYPESAFE_API_KEY`; ~1 Jev call per turn ≈ $0.03) | Jev $ |
| 8 | LongMemEval on **Gemini free** | `node bench/run.js --dataset longmemeval --lme-split s --lme-limit 60 --system remind --ingest-provider gemini --answer-provider gemini --judge-provider openai --rpm 10` | $0 + ~$0.02 judge |
| 9 | Second backbone (robustness) | rerun #2 on convs 1,2 with `--ingest-provider gemini --answer-provider gemini` | $0 + judge |

Keep **≥ $1 in reserve** for reruns after bug fixes.

Compare runs on the same questions with paired statistics:

```bash
node bench/compare.js --dataset locomo --metric p1 remind-test mem0-h2h memgpt-h2h rag-h2h
```

`compare.js` uses only the questions that every run shares, so the main REMind run (convs 1–9)
lines up with the convs 1,2 head-to-head runs without spending anything extra.

## Reporting rules (reviewers check these)

- Report **95% CIs** and paired tests (`compare.js`). Claim "better" only when the paired Δ interval excludes 0.
- Published baselines (Mem0 paper table) are **cited, not re-run**. Say so in the table caption. Our
  head-to-head against Mem0 OSS v3 is the apples-to-apples comparison.
- "MemGPT-style" is our reimplementation of MemGPT's memory hierarchy, not the official Letta server. Label it that way.
- The security scenarios and the MemGuard detectors were written together. Before the paper, have a
  teammate who has **not** read `src/remind/guard/` write a held-out set of scenarios, and report both.
- Report MemGuard's false-positive cost on LoCoMo: `summary.json → efficiency.ingest[].stats.guard`
  (benign turns redacted, candidates rejected) next to the accuracy numbers.
- Report Mem0 `add()` failures (`efficiency.mem0AddFailures`). The harness never swallows them.
