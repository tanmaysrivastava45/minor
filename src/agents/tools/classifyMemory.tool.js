import { z } from "zod";
import OpenAI from "openai";
import config from "../../config/index.js";

const client = new OpenAI({ apiKey: config.openai.apiKey });

/**
 * Classify Memory Tool
 * 
 * Takes a batch of messages and determines which ones contain information
 * worthy of long-term storage (factual or episodic).
 * 
 * This is the first stage of the consolidation pipeline.
 */

export const classifyMemorySchema = z.object({
  messages: z.array(
    z.object({
      role: z.string(),
      content: z.string(),
      index: z.number(),
    })
  ),
});

/**
 * Classify a batch of messages to identify long-term memory candidates
 * 
 * @param {object[]} messages - Array of { role, content, index }
 * @returns {object[]} Array of { index, isLongTerm, memoryType, reason }
 */
export async function classifyMemoryBatch(messages) {
  // Format messages into pairs (user+assistant) for context
  const formattedMessages = messages.map(
    (m) => `[${m.index}] ${m.role}: ${m.content}`
  ).join("\n");

  const systemPrompt = `You are an expert memory classification AI. Your job is to analyze conversation messages and determine which ones contain information that should be stored in long-term memory.

CLASSIFICATION RULES:
1. LONG-TERM FACTUAL: Personal facts, preferences, biographical details, professional info, relationships, skills, education, health info, financial info
   - Examples: "My name is Tanmay", "I work at Google", "My birthday is June 27th", "I love pizza"
   
2. LONG-TERM EPISODIC: Significant events, experiences, stories, emotional moments, achievements, plans
   - Examples: "I just got promoted!", "We went to Japan last month", "I'm planning to move to NYC"

3. SHORT-TERM (skip): General knowledge questions, math problems, coding help, generic conversations
   - Examples: "What is 2+2?", "Explain polymorphism", "How do I sort an array?"

For each message pair (user+assistant), classify as:
- "factual" — contains extractable facts about the user
- "episodic" — contains significant events/experiences  
- "both" — contains both factual and episodic elements
- "none" — nothing worth storing long-term

IMPORTANT: 
- Focus on USER messages primarily — they contain the personal information
- Assistant messages provide context but rarely contain storable facts about the user
- BE EXTREMELY GENEROUS: Even small details like names, dates, tools used, jobs, and past events MUST be marked as factual or episodic.
- If in doubt, mark it as "both" or "factual". Never mark as "none" if there is any personal context.
- Group consecutive related messages together

Respond in JSON format:
{
  "classifications": [
    {
      "indices": [0, 1],
      "type": "factual",
      "reason": "User stated their name"
    }
  ]
}`;

  try {
    const response = await client.chat.completions.create({
      model: config.openai.llmModel,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: `Classify these messages:\n\n${formattedMessages}` },
      ],
      response_format: { type: "json_object" },
      temperature: 0.1,
    });

    const result = JSON.parse(response.choices[0].message.content);
    return result.classifications || [];
  } catch (error) {
    console.error("Memory classification failed:", error.message);
    return [];
  }
}

export default { classifyMemoryBatch };
