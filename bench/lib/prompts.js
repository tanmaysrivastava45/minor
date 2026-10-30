/**
 * Evaluation prompts vendored VERBATIM so every system is scored exactly like the
 * published baselines. Do not edit the strings — comparability depends on it.
 *
 * P1 — Mem0 paper protocol (arXiv 2504.19413), Apache-2.0,
 *      github.com/mem0ai/mem0 @ aae5989e78a6188b3b047c104d960c9ad0927e75
 *      evaluation/prompts.py (ANSWER_PROMPT) and evaluation/metrics/llm_judge.py (ACCURACY_PROMPT,
 *      judged by gpt-4o-mini, temperature 0, JSON label). Categories 1–4, adversarial (5) excluded.
 * P2 — Mem0 memory-benchmarks (2026), Apache-2.0, github.com/mem0ai/memory-benchmarks
 *      benchmarks/locomo/prompts.py: the newer, much more lenient judge (no-evidence variant).
 * LME — LongMemEval (ICLR 2025), github.com/xiaowu0162/LongMemEval src/evaluation/evaluate_qa.py.
 */

export const P1_ANSWER_PROMPT = "\n    You are an intelligent memory assistant tasked with retrieving accurate information from conversation memories.\n\n    # CONTEXT:\n    You have access to memories from two speakers in a conversation. These memories contain \n    timestamped information that may be relevant to answering the question.\n\n    # INSTRUCTIONS:\n    1. Carefully analyze all provided memories from both speakers\n    2. Pay special attention to the timestamps to determine the answer\n    3. If the question asks about a specific event or fact, look for direct evidence in the memories\n    4. If the memories contain contradictory information, prioritize the most recent memory\n    5. If there is a question about time references (like \"last year\", \"two months ago\", etc.), \n       calculate the actual date based on the memory timestamp. For example, if a memory from \n       4 May 2022 mentions \"went to India last year,\" then the trip occurred in 2021.\n    6. Always convert relative time references to specific dates, months, or years. For example, \n       convert \"last year\" to \"2022\" or \"two months ago\" to \"March 2023\" based on the memory \n       timestamp. Ignore the reference while answering the question.\n    7. Focus only on the content of the memories from both speakers. Do not confuse character \n       names mentioned in memories with the actual users who created those memories.\n    8. The answer should be less than 5-6 words.\n\n    # APPROACH (Think step by step):\n    1. First, examine all memories that contain information related to the question\n    2. Examine the timestamps and content of these memories carefully\n    3. Look for explicit mentions of dates, times, locations, or events that answer the question\n    4. If the answer requires calculation (e.g., converting relative time references), show your work\n    5. Formulate a precise, concise answer based solely on the evidence in the memories\n    6. Double-check that your answer directly addresses the question asked\n    7. Ensure your final answer is specific and avoids vague time references\n\n    Memories for user {{speaker_1_user_id}}:\n\n    {{speaker_1_memories}}\n\n    Memories for user {{speaker_2_user_id}}:\n\n    {{speaker_2_memories}}\n\n    Question: {{question}}\n\n    Answer:\n    ";

export const P1_JUDGE_PROMPT = "\nYour task is to label an answer to a question as ’CORRECT’ or ’WRONG’. You will be given the following data:\n    (1) a question (posed by one user to another user), \n    (2) a ’gold’ (ground truth) answer, \n    (3) a generated answer\nwhich you will score as CORRECT/WRONG.\n\nThe point of the question is to ask about something one user should know about the other user based on their prior conversations.\nThe gold answer will usually be a concise and short answer that includes the referenced topic, for example:\nQuestion: Do you remember what I got the last time I went to Hawaii?\nGold answer: A shell necklace\nThe generated answer might be much longer, but you should be generous with your grading - as long as it touches on the same topic as the gold answer, it should be counted as CORRECT. \n\nFor time related questions, the gold answer will be a specific date, month, year, etc. The generated answer might be much longer or use relative time references (like \"last Tuesday\" or \"next month\"), but you should be generous with your grading - as long as it refers to the same date or time period as the gold answer, it should be counted as CORRECT. Even if the format differs (e.g., \"May 7th\" vs \"7 May\"), consider it CORRECT if it's the same date.\n\nNow it's time for the real question:\nQuestion: {question}\nGold answer: {gold_answer}\nGenerated answer: {generated_answer}\n\nFirst, provide a short (one sentence) explanation of your reasoning, then finish with CORRECT or WRONG. \nDo NOT include both CORRECT and WRONG in your response, or it will break the evaluation script.\n\nJust return the label CORRECT or WRONG in a json format with the key as \"label\".\n";

export const P2_JUDGE_SYSTEM = "You are evaluating conversational AI memory recall. Return JSON only with the format requested.";

export const P2_JUDGE_PROMPT = `Label the generated answer as CORRECT or WRONG.

## Rules

1. **PARTIAL CREDIT**: If the generated answer includes AT LEAST ONE correct item from the gold answer's list, mark CORRECT. Getting 1 out of 2, 2 out of 4, etc. is always acceptable. Only mark WRONG if NONE of the gold answer items appear.

2. **PARAPHRASES COUNT**: Same concept in different words is CORRECT. "Chocolate raspberry tart" = "chocolate cake with raspberries". "Shelter meal service" = "volunteering at a homeless shelter". Emotions and sentiments in the same positive/negative family count as paraphrases: "proud" = "fulfilled" = "accomplished"; "huge success" = "relieved" = "thrilled" (all express positive achievement). Judge semantic meaning, not exact wording.

3. **EXTRA DETAIL IS FINE**: A longer answer that includes the gold answer's key facts plus additional information is CORRECT. Never penalize for being more detailed or specific. If the generated answer adds extra descriptive details beyond the gold answer while still referencing the same core entity or concept, mark CORRECT.

4. **DATE TOLERANCE**: Dates within 14 days of each other are CORRECT. Durations within 50% are CORRECT (e.g., "5 months" matches "six months"; "19 days" matches "two weeks"). Relative dates ("few days before November") match specific dates in the same window. A specific date (e.g., "February 2020") that is consistent with a vague reference (e.g., "a few years ago" relative to 2023) is CORRECT. Converting "last year" to the actual year (e.g., "2022" when conversations are in 2023) is CORRECT.

5. **SEMANTIC OVERLAP**: Judge whether the generated answer addresses the same topic and captures the core idea of the gold answer. Different wording, phrasing, or level of detail should not result in WRONG if the underlying concept matches. For EMOTIONS and FEELINGS questions, answers expressing sentiments in the same valence (positive/negative) about the same event are CORRECT — do not require the exact same emotion word.

6. **SAME REFERENT**: If the generated answer mentions or references the same named entity, character, person, or concept as the gold answer, mark CORRECT — even if the generated answer provides a different physical description or includes additional details. The key question is: does the generated answer identify the same core entity? If yes, it is CORRECT.

7. **FOCUS ON KNOWLEDGE, NOT WORDING**: The goal is to assess whether the system recalled the right fact. Minor differences in specificity, phrasing, or scope should not result in WRONG. Only mark WRONG when the generated answer demonstrates a genuinely different or incorrect understanding.

## ONLY mark WRONG if:
- The generated answer contains ZERO correct items from the gold answer
- The answer addresses a completely different topic

## Question
Question: {question}
Gold answer: {answer}
Generated answer: {response}

Return JSON with "reasoning" (one sentence) and "label" (CORRECT or WRONG). Do NOT include both labels.`;

const LME_BASE =
  "I will give you a question, a correct answer, and a response from a model. Please answer yes if the response contains the correct answer. Otherwise, answer no. If the response is equivalent to the correct answer or contains all the intermediate steps to get the correct answer, you should also answer yes. If the response only contains a subset of the information required by the answer, answer no. ";

export function lmeJudgePrompt(task, question, answer, response, abstention) {
  let template;
  if (abstention) {
    template =
      "I will give you an unanswerable question, an explanation, and a response from a model. Please answer yes if the model correctly identifies the question as unanswerable. The model could say that the information is incomplete, or some other information is given but the asked information is not.\n\nQuestion: {}\n\nExplanation: {}\n\nModel Response: {}\n\nDoes the model correctly identify the question as unanswerable? Answer yes or no only.";
  } else if (["single-session-user", "single-session-assistant", "multi-session"].includes(task)) {
    template = `${LME_BASE}\n\nQuestion: {}\n\nCorrect Answer: {}\n\nModel Response: {}\n\nIs the model response correct? Answer yes or no only.`;
  } else if (task === "temporal-reasoning") {
    template = `${LME_BASE}In addition, do not penalize off-by-one errors for the number of days. If the question asks for the number of days/weeks/months, etc., and the model makes off-by-one errors (e.g., predicting 19 days when the answer is 18), the model's response is still correct. \n\nQuestion: {}\n\nCorrect Answer: {}\n\nModel Response: {}\n\nIs the model response correct? Answer yes or no only.`;
  } else if (task === "knowledge-update") {
    template =
      "I will give you a question, a correct answer, and a response from a model. Please answer yes if the response contains the correct answer. Otherwise, answer no. If the response contains some previous information along with an updated answer, the response should be considered as correct as long as the updated answer is the required answer.\n\nQuestion: {}\n\nCorrect Answer: {}\n\nModel Response: {}\n\nIs the model response correct? Answer yes or no only.";
  } else if (task === "single-session-preference") {
    template =
      "I will give you a question, a rubric for desired personalized response, and a response from a model. Please answer yes if the response satisfies the desired response. Otherwise, answer no. The model does not need to reflect all the points in the rubric. The response is correct as long as it recalls and utilizes the user's personal information correctly.\n\nQuestion: {}\n\nRubric: {}\n\nModel Response: {}\n\nIs the model response correct? Answer yes or no only.";
  } else {
    throw new Error(`Unknown LongMemEval task ${task}`);
  }
  const parts = [question, answer, response];
  let i = 0;
  return template.replace(/\{\}/g, () => String(parts[i++]));
}

/** Our own answer prompt for LongMemEval (the benchmark prescribes none for memory systems). */
export const LME_ANSWER_PROMPT = `You are a helpful assistant with long-term memory of your past conversations with the user.
Use the memories below to answer the question. Memories marked "no longer current" were later replaced; prefer the most recent information.
If the memories do not contain the answer, say that you don't know.

Current date: {date}

{memories}

Question: {question}
Answer concisely.`;
