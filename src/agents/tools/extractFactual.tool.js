import OpenAI from "openai";
import config from "../../config/index.js";

const client = new OpenAI({ apiKey: config.openai.apiKey });

/**
 * Extract Factual Memory Tool
 * 
 * Extracts structured factual memories from classified messages.
 * Assigns category, hardness (immutability), confidence, and entities.
 */

/**
 * Extract factual memories from a set of messages
 * 
 * @param {object[]} messages - Messages identified as containing factual information
 * @returns {object[]} Array of extracted facts
 */
export async function extractFactualMemories(messages) {
  const formattedMessages = messages
    .map((m) => `${m.role}: ${m.content}`)
    .join("\n");

  const systemPrompt = `You are an expert fact extraction AI. Extract all factual information about the USER from the conversation messages.

For each fact, provide:
1. "fact": A clear, concise statement (e.g., "User's name is Tanmay Srivastava")
2. "category": One of:
   - "identity" (name, age, gender, nationality)
   - "preference" (food, music, hobbies, interests)
   - "biographical" (birthday, birthplace, family members)
   - "professional" (job, company, role, salary)
   - "social" (friends, relationships, social circles)
   - "educational" (degrees, schools, certifications)
   - "health" (medical conditions, fitness, diet)
   - "location" (current city, address, past residences)
   - "financial" (income, investments, spending)
   - "other" (anything else)

3. "hardness": How likely this fact is to change:
   - "immutable" — Name, birthday, birthplace, blood type (almost never changes)
   - "semi_mutable" — Job, school, location (changes occasionally)
   - "mutable" — Preferences, mood, current interests (changes often)

4. "confidence": How confident you are this is accurate (0.0-1.0):
   - 1.0: Explicitly stated ("My name is X")
   - 0.8-0.9: Strongly implied with clear context
   - 0.6-0.7: Inferred from context
   - 0.3-0.5: Weak inference

5. "source": 
   - "explicit" — User directly stated it
   - "inferred" — Derived from context
   - "corrected" — User corrected a previous statement

6. "entities": Key entity names for this fact (for conflict detection)

IMPORTANT:
- Extract ONLY facts about the USER, not general knowledge
- Break down complex sentences into MULTIPLE atomic statements
- Example: "I work at Google as a Tech Lead and previously worked at Microsoft" -> 
  Fact 1: "User works at Google", Fact 2: "User is a Tech Lead", Fact 3: "User previously worked at Microsoft"
- Extract absolutely every entity mentioned (schools, companies, pets, friends' names, locations)
- Prefer explicit statements over inferences
- Include ALL relevant facts, don't skip anything

Respond in JSON:
{
  "facts": [
    {
      "fact": "User's name is Tanmay Srivastava",
      "category": "identity",
      "hardness": "immutable",
      "confidence": 1.0,
      "source": "explicit",
      "entities": ["name", "Tanmay Srivastava"]
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
          content: `Extract factual memories from:\n\n${formattedMessages}`,
        },
      ],
      response_format: { type: "json_object" },
      temperature: 0.1,
    });

    const result = JSON.parse(response.choices[0].message.content);
    return result.facts || [];
  } catch (error) {
    console.error("Factual extraction failed:", error.message);
    return [];
  }
}

export default { extractFactualMemories };
