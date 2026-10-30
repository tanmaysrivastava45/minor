import OpenAI from "openai";
import config from "../src/config/index.js";

const client = new OpenAI({ apiKey: config.openai.apiKey });

/**
 * Benchmark Evaluation Engine
 * 
 * Implements multiple metrics for evaluating AI memory systems:
 * 1. F1 Score — token-level overlap
 * 2. Accuracy (LLM-as-Judge) — binary correct/incorrect
 * 3. LLM Quality Score — 0-5 quality rating
 * 4. BLEU Score — n-gram precision
 * 5. ROUGE-L — longest common subsequence
 * 6. Latency — response time
 * 7. Category-specific scores — temporal, conflict, adversarial
 */

// ============================================================================
// TOKENIZATION HELPERS
// ============================================================================

function tokenize(text) {
  return text
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 0);
}

// ============================================================================
// F1 SCORE
// ============================================================================

/**
 * Calculate token-level F1 score between prediction and ground truth
 */
export function calculateF1(prediction, groundTruth) {
  const predTokens = new Set(tokenize(prediction));
  const truthTokens = new Set(tokenize(groundTruth));

  if (predTokens.size === 0 && truthTokens.size === 0) return 1.0;
  if (predTokens.size === 0 || truthTokens.size === 0) return 0.0;

  const intersection = new Set([...predTokens].filter((t) => truthTokens.has(t)));
  const precision = intersection.size / predTokens.size;
  const recall = intersection.size / truthTokens.size;

  if (precision + recall === 0) return 0.0;
  return (2 * precision * recall) / (precision + recall);
}

// ============================================================================
// BLEU SCORE (simplified)
// ============================================================================

/**
 * Calculate BLEU-like score using n-gram precision
 */
export function calculateBLEU(prediction, groundTruth, maxN = 4) {
  const predTokens = tokenize(prediction);
  const truthTokens = tokenize(groundTruth);

  if (predTokens.length === 0 || truthTokens.length === 0) return 0.0;

  let totalScore = 0;
  let validN = 0;

  for (let n = 1; n <= maxN; n++) {
    const predNgrams = getNgrams(predTokens, n);
    const truthNgrams = getNgrams(truthTokens, n);

    if (predNgrams.length === 0) continue;

    const truthNgramSet = new Set(truthNgrams);
    const matches = predNgrams.filter((ng) => truthNgramSet.has(ng)).length;
    const precision = matches / predNgrams.length;

    if (precision > 0) {
      totalScore += Math.log(precision);
      validN++;
    }
  }

  if (validN === 0) return 0.0;

  // Brevity penalty
  const bp =
    predTokens.length >= truthTokens.length
      ? 1
      : Math.exp(1 - truthTokens.length / predTokens.length);

  return bp * Math.exp(totalScore / validN);
}

function getNgrams(tokens, n) {
  const ngrams = [];
  for (let i = 0; i <= tokens.length - n; i++) {
    ngrams.push(tokens.slice(i, i + n).join(" "));
  }
  return ngrams;
}

// ============================================================================
// ROUGE-L (Longest Common Subsequence)
// ============================================================================

/**
 * Calculate ROUGE-L score
 */
export function calculateROUGEL(prediction, groundTruth) {
  const predTokens = tokenize(prediction);
  const truthTokens = tokenize(groundTruth);

  if (predTokens.length === 0 || truthTokens.length === 0) return 0.0;

  const lcsLength = computeLCS(predTokens, truthTokens);
  const precision = lcsLength / predTokens.length;
  const recall = lcsLength / truthTokens.length;

  if (precision + recall === 0) return 0.0;
  return (2 * precision * recall) / (precision + recall);
}

function computeLCS(a, b) {
  const m = a.length;
  const n = b.length;
  const dp = Array(m + 1)
    .fill(null)
    .map(() => Array(n + 1).fill(0));

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }
  return dp[m][n];
}

// ============================================================================
// LLM-AS-JUDGE
// ============================================================================

/**
 * Use GPT to judge if the answer is correct (binary) and rate quality (0-5)
 */
export async function llmJudge(question, prediction, groundTruth) {
  try {
    const response = await client.chat.completions.create({
      model: config.openai.llmModel,
      messages: [
        {
          role: "system",
          content: `You are an impartial judge evaluating AI memory system answers.

Given a question, a ground truth answer, and a predicted answer, evaluate:
1. "is_correct": Is the predicted answer factually correct? (true/false)
   - true if the key facts match, even if wording differs
   - true if the prediction contains the correct answer plus additional correct context
   - false if key facts are wrong, missing critical information, or contradicted
   
2. "quality_score": Rate the answer quality from 0-5:
   - 0: Completely wrong or irrelevant
   - 1: Mostly wrong with minor correct elements
   - 2: Partially correct but missing significant details
   - 3: Mostly correct with some gaps
   - 4: Correct and comprehensive
   - 5: Perfect — matches or exceeds ground truth

3. "reasoning": Brief explanation of your judgment

Respond in JSON format.`,
        },
        {
          role: "user",
          content: `Question: ${question}
          
Ground Truth Answer: ${groundTruth}

Predicted Answer: ${prediction}`,
        },
      ],
      response_format: { type: "json_object" },
      temperature: 0.0,
    });

    return JSON.parse(response.choices[0].message.content);
  } catch (error) {
    console.error("LLM judge failed:", error.message);
    return { is_correct: false, quality_score: 0, reasoning: "Judge error" };
  }
}

// ============================================================================
// FULL EVALUATION
// ============================================================================

/**
 * Evaluate a complete set of predictions against ground truth
 * 
 * @param {object[]} results - Array of { question, prediction, groundTruth, category, latencyMs }
 * @returns {object} Comprehensive evaluation report
 */
export async function evaluateAll(results) {
  const report = {
    overall: {
      f1: 0,
      accuracy: 0,
      llm_quality: 0,
      bleu: 0,
      rouge_l: 0,
      avg_latency_ms: 0,
      total_questions: results.length,
    },
    per_category: {},
    per_question: [],
  };

  // Initialize category buckets
  const categoryScores = {};

  for (const result of results) {
    const qReport = {
      id: result.id,
      question: result.question,
      category: result.category,
      prediction: result.prediction,
      groundTruth: result.groundTruth,
      latencyMs: result.latencyMs || 0,
    };

    // Calculate text metrics
    qReport.f1 = calculateF1(result.prediction, result.groundTruth);
    qReport.bleu = calculateBLEU(result.prediction, result.groundTruth);
    qReport.rouge_l = calculateROUGEL(result.prediction, result.groundTruth);

    // LLM judge
    const judgeResult = await llmJudge(
      result.question,
      result.prediction,
      result.groundTruth
    );
    qReport.is_correct = judgeResult.is_correct;
    qReport.quality_score = judgeResult.quality_score;
    qReport.judge_reasoning = judgeResult.reasoning;

    report.per_question.push(qReport);

    // Accumulate category scores
    const cat = result.category;
    if (!categoryScores[cat]) {
      categoryScores[cat] = {
        f1: [],
        accuracy: [],
        quality: [],
        bleu: [],
        rouge_l: [],
        latency: [],
      };
    }
    categoryScores[cat].f1.push(qReport.f1);
    categoryScores[cat].accuracy.push(qReport.is_correct ? 1 : 0);
    categoryScores[cat].quality.push(qReport.quality_score);
    categoryScores[cat].bleu.push(qReport.bleu);
    categoryScores[cat].rouge_l.push(qReport.rouge_l);
    categoryScores[cat].latency.push(qReport.latencyMs);
  }

  // Calculate overall averages
  const avg = (arr) => arr.reduce((a, b) => a + b, 0) / arr.length;

  report.overall.f1 = avg(report.per_question.map((q) => q.f1));
  report.overall.accuracy = avg(
    report.per_question.map((q) => (q.is_correct ? 1 : 0))
  );
  report.overall.llm_quality = avg(
    report.per_question.map((q) => q.quality_score)
  );
  report.overall.bleu = avg(report.per_question.map((q) => q.bleu));
  report.overall.rouge_l = avg(report.per_question.map((q) => q.rouge_l));
  report.overall.avg_latency_ms = avg(
    report.per_question.map((q) => q.latencyMs)
  );

  // Calculate per-category averages
  for (const [cat, scores] of Object.entries(categoryScores)) {
    report.per_category[cat] = {
      f1: avg(scores.f1),
      accuracy: avg(scores.accuracy),
      llm_quality: avg(scores.quality),
      bleu: avg(scores.bleu),
      rouge_l: avg(scores.rouge_l),
      avg_latency_ms: avg(scores.latency),
      count: scores.f1.length,
    };
  }

  // Round all numbers
  const round = (obj) => {
    for (const key of Object.keys(obj)) {
      if (typeof obj[key] === "number") {
        obj[key] = Math.round(obj[key] * 1000) / 1000;
      } else if (typeof obj[key] === "object" && obj[key] !== null) {
        round(obj[key]);
      }
    }
  };
  round(report.overall);
  round(report.per_category);

  return report;
}

/**
 * Format evaluation report as a markdown table
 */
export function formatReportMarkdown(systemName, report) {
  let md = `## ${systemName} Benchmark Results\n\n`;

  // Overall table
  md += `### Overall Scores\n`;
  md += `| Metric | Score |\n|--------|-------|\n`;
  md += `| F1 Score | ${(report.overall.f1 * 100).toFixed(1)}% |\n`;
  md += `| Accuracy (LLM Judge) | ${(report.overall.accuracy * 100).toFixed(1)}% |\n`;
  md += `| LLM Quality (0-5) | ${report.overall.llm_quality.toFixed(2)} |\n`;
  md += `| BLEU | ${(report.overall.bleu * 100).toFixed(1)}% |\n`;
  md += `| ROUGE-L | ${(report.overall.rouge_l * 100).toFixed(1)}% |\n`;
  md += `| Avg Latency | ${report.overall.avg_latency_ms.toFixed(0)}ms |\n\n`;

  // Per-category table
  md += `### Per-Category Scores\n`;
  md += `| Category | F1 | Accuracy | Quality | BLEU | ROUGE-L | Count |\n`;
  md += `|----------|-----|----------|---------|------|---------|-------|\n`;
  for (const [cat, scores] of Object.entries(report.per_category)) {
    md += `| ${cat} | ${(scores.f1 * 100).toFixed(1)}% | ${(scores.accuracy * 100).toFixed(1)}% | ${scores.llm_quality.toFixed(1)} | ${(scores.bleu * 100).toFixed(1)}% | ${(scores.rouge_l * 100).toFixed(1)}% | ${scores.count} |\n`;
  }

  return md;
}

export default {
  calculateF1,
  calculateBLEU,
  calculateROUGEL,
  llmJudge,
  evaluateAll,
  formatReportMarkdown,
};
