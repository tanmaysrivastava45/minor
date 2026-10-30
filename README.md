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
