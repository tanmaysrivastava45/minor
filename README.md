# REMind v2 (src/remind) — a memory that sleeps, safely

`src/remind/` is the current engine. It runs without databases. Its SDK has three main calls,
plus a deletion call:

```js
import { createRemind } from "./src/remind/index.js";
const remind = createRemind({ llmOptions: { provider: "openai" }, budgetUSD: 1 });
await remind.addToMemory("u1", [{ role: "user", content: "I'm Asha, I moved to Pune." }], { session: "s1", date: "2024-03-01" });
await remind.sleep("u1", { now: "2024-03-02" });          // guarded, transactional consolidation
const { context } = await remind.retrieve("u1", "Where does Asha live?", { now: "2024-03-05" });
await remind.forget("u1", { session: "s1" });             // provenance-cascading deletion
```

The pipeline, in order:

1. **L0 MemGuard:** local secret and PII detectors run before any text leaves the process.
2. **L1 gate:** a heuristic, LLM or Jev classifier decides which turns are worth extracting.
3. **L2 extraction:** batched LLM extraction of memories.
4. **Write gate:** checks provenance and integrity labels, and relabels assistant or tool claims so they never become user facts.
5. **Update phase:** Mem0-style ADD, UPDATE, INVALIDATE or NOOP, with bi-temporal history.
6. **Validity:** expiry plus an assurity window, computed from conversation time.
7. **Confidence:** a noisy-OR over *independent sessions*, so repeating a claim doesn't raise it.
8. **Core tier:** a MemGPT-style block of always-in-context memories.
9. **Sleep:** proposes MERGE, INVALIDATE, PROMOTE or DEMOTE. MemGuard-S verifies each operation against the append-only recall store, then the batch commits or rolls back.

Benchmarks: see [bench/README.md](bench/README.md). The legacy CortexMemory v1 (MongoDB, Qdrant
and Neo4j) is kept below as an ablation baseline. Its old `benchmark/` folder is superseded by `bench/`.

---

# CortexMemory: Neuroscience-Inspired AI Memory Layer

CortexMemory is an advanced AI memory layer designed to surpass current state-of-the-art memory systems (like mem0 and Zep) by closely mimicking human brain memory retention patterns.

## Architecture

CortexMemory uses a tri-store architecture:
1. **Factual Memory (MongoDB)**: Stores semantic facts (e.g., name, birthday, preferences).
2. **Episodic Memory (Qdrant)**: Stores vector embeddings of experiences and events with emotional valence and temporal context.
3. **Graph Memory (Neo4j)**: Stores entity relationships (User -> LIKES -> Ramen) for deep multi-hop reasoning.

## Key Innovations

1. **Hippocampal Consolidation**: Instead of processing every message instantly, CortexMemory buffers messages (default: 30) and processes them in batches, mimicking the brain's sleep replay mechanism.
2. **Temporal Decay Engine**: Memories decay over time based on the Ebbinghaus forgetting curve.
3. **Miracle Window**: Expired memories enter a grace period. If accessed during this window, they are "rescued," and their confidence score is boosted (spaced repetition).
4. **Memory Hardness**: Facts are classified as `immutable`, `semi_mutable`, or `mutable`. Immutable facts (like a birthday) are much harder to overwrite than mutable facts (like a favorite food).
5. **Hybrid Conflict Resolution**: Uses algorithmic logic (based on hardness, recency, confidence) and LLM reasoning to resolve conflicting memories.

## Benchmarking Suite

The project includes a comprehensive benchmarking suite inspired by the LoCoMo dataset.

- **Dataset**: A 150-message conversation across 5 sessions spanning 14 months, testing preference changes, career transitions, and relationship dynamics.
- **Questions**: 30 questions across 6 categories: Single-hop, Multi-hop, Temporal, Preference Change, Episodic, and Adversarial.
- **Evaluation**: Uses token-level F1, BLEU, ROUGE-L, and LLM-as-Judge (Accuracy and 0-5 Quality Score).

### Running Benchmarks

Set up your `.env` file with `OPENAI_API_KEY`, `MEM0_API_KEY` (optional), and `ZEP_API_KEY` (optional). Make sure MongoDB, Qdrant, and Neo4j are running locally.

```bash
npm install
npm run benchmark
```

You can also run specific runners:
```bash
npm run benchmark:cortex
npm run benchmark:mem0
npm run benchmark:zep
npm run benchmark:baseline
```
