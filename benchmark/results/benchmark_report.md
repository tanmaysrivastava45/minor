# 🧠 CortexMemory Benchmark Results

**Date:** 2026-09-07
**Dataset:** 150 messages, 30 questions (LoCoMo-inspired)
**LLM:** gpt-4.1-mini

## Overall Comparison

| Metric | CortexMemory | Mem0 |
|--------|------|------|
| F1 Score | 43.0% | 41.3% |
| Accuracy | 82.6% | 52.2% |
| LLM Quality (0-5) | 3.91 | 2.87 |
| BLEU | 16.6% | 15.0% |
| ROUGE-L | 32.2% | 29.2% |
| Avg Latency (ms) | 6108ms | 1890ms |
| Load Time | 349.8s | 45.1s |


---

## CortexMemory Benchmark Results

### Overall Scores
| Metric | Score |
|--------|-------|
| F1 Score | 43.0% |
| Accuracy (LLM Judge) | 82.6% |
| LLM Quality (0-5) | 3.91 |
| BLEU | 16.6% |
| ROUGE-L | 32.2% |
| Avg Latency | 6108ms |

### Per-Category Scores
| Category | F1 | Accuracy | Quality | BLEU | ROUGE-L | Count |
|----------|-----|----------|---------|------|---------|-------|
| single_hop | 30.1% | 60.0% | 2.8 | 19.3% | 23.8% | 5 |
| multi_hop | 46.9% | 80.0% | 3.8 | 17.2% | 34.8% | 5 |
| temporal | 42.0% | 100.0% | 4.4 | 12.9% | 32.8% | 5 |
| preference_change | 42.5% | 75.0% | 4.3 | 10.1% | 27.6% | 4 |
| episodic | 56.2% | 100.0% | 4.5 | 23.8% | 43.3% | 4 |

---

## Mem0 Benchmark Results

### Overall Scores
| Metric | Score |
|--------|-------|
| F1 Score | 41.3% |
| Accuracy (LLM Judge) | 52.2% |
| LLM Quality (0-5) | 2.87 |
| BLEU | 15.0% |
| ROUGE-L | 29.2% |
| Avg Latency | 1890ms |

### Per-Category Scores
| Category | F1 | Accuracy | Quality | BLEU | ROUGE-L | Count |
|----------|-----|----------|---------|------|---------|-------|
| single_hop | 29.5% | 80.0% | 3.4 | 18.9% | 21.2% | 5 |
| multi_hop | 43.1% | 20.0% | 2.4 | 13.8% | 32.3% | 5 |
| temporal | 50.3% | 60.0% | 3.2 | 17.4% | 34.4% | 5 |
| preference_change | 46.0% | 50.0% | 3.3 | 14.3% | 28.8% | 4 |
| episodic | 37.8% | 50.0% | 2.0 | 9.2% | 29.2% | 4 |

---

## Category Comparison

### Single Hop

| System | F1 | Accuracy | Quality |
|--------|-----|----------|--------|
| CortexMemory | 30.1% | 60.0% | 2.8 |
| Mem0 | 29.5% | 80.0% | 3.4 |

### Multi Hop

| System | F1 | Accuracy | Quality |
|--------|-----|----------|--------|
| CortexMemory | 46.9% | 80.0% | 3.8 |
| Mem0 | 43.1% | 20.0% | 2.4 |

### Temporal

| System | F1 | Accuracy | Quality |
|--------|-----|----------|--------|
| CortexMemory | 42.0% | 100.0% | 4.4 |
| Mem0 | 50.3% | 60.0% | 3.2 |

### Preference Change

| System | F1 | Accuracy | Quality |
|--------|-----|----------|--------|
| CortexMemory | 42.5% | 75.0% | 4.3 |
| Mem0 | 46.0% | 50.0% | 3.3 |

### Episodic

| System | F1 | Accuracy | Quality |
|--------|-----|----------|--------|
| CortexMemory | 56.2% | 100.0% | 4.5 |
| Mem0 | 37.8% | 50.0% | 2.0 |

### Adversarial

| System | F1 | Accuracy | Quality |
|--------|-----|----------|--------|
| CortexMemory | N/A | N/A | N/A |
| Mem0 | N/A | N/A | N/A |

