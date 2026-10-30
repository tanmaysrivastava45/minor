import OpenAI from "openai";
import config from "../../config/index.js";

const client = new OpenAI({ apiKey: config.openai.apiKey });

/**
 * Extract Episodic Memory Tool
 * 
 * Extracts episodic memories (events, experiences, stories) from messages.
 * Captures temporal context, entities, and emotional valence.
 */

/**
 * Extract episodic memories from a set of messages
 * 
 * @param {object[]} messages - Messages identified as containing episodic information
 * @returns {object[]} Array of extracted episodes
 */
export async function extractEpisodicMemories(messages) {
  const formattedMessages = messages
    .map((m) => `${m.role}: ${m.content}`)
    .join("\n");

  const systemPrompt = `You are an expert episodic memory extraction AI. Extract significant events, experiences, and episodes from the conversation.

Episodic memories are like diary entries — they capture WHAT happened, WHEN, WHERE, and how the user FELT about it.

For each episode, provide:
1. "content": A concise narrative description of the episode (1-3 sentences)
   - Example: "User went on a trip to Japan in March 2024 and loved the sushi in Tokyo"
   
2. "temporalContext": When this happened (ISO date if available, otherwise descriptive)
   - Example: "2024-03-15" or "last summer" or "recently"
   
3. "entities": All mentioned entities (people, places, organizations, things)
   - Example: ["Japan", "Tokyo", "sushi"]
   
4. "emotionalValence": The emotional tone
   - "positive" — happy, excited, proud, grateful
   - "neutral" — informational, matter-of-fact
   - "negative" — sad, frustrated, angry, worried
   
5. "confidence": How confident this episode is accurate (0.0-1.0)

IMPORTANT:
- Focus on EVENTS and EXPERIENCES, not static facts
- Capture the narrative and context, not just data points
- Include temporal markers when available
- Preserve the emotional context — it helps with retrieval
- Group related messages into a single episode

Respond in JSON:
{
  "episodes": [
    {
      "content": "User traveled to Japan in March 2024, visited Tokyo, and especially enjoyed trying authentic sushi",
      "temporalContext": "2024-03",
      "entities": ["Japan", "Tokyo", "sushi", "travel"],
      "emotionalValence": "positive",
      "confidence": 0.9
    }
  ]
}`;

  try {
    const response = await client.chat.completions.create({
      model: config.openai.llmModel,
      messages: [
        { role: "system", content: systemPrompt },
        {
          role: "user",
          content: `Extract episodic memories from:\n\n${formattedMessages}`,
        },
      ],
      response_format: { type: "json_object" },
      temperature: 0.2,
    });

    const result = JSON.parse(response.choices[0].message.content);
    return result.episodes || [];
  } catch (error) {
    console.error("Episodic extraction failed:", error.message);
    return [];
  }
}

export default { extractEpisodicMemories };
