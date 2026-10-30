import OpenAI from "openai";
import config from "../../config/index.js";

const client = new OpenAI({ apiKey: config.openai.apiKey });

/**
 * Extract Relations Tool
 * 
 * Extracts entity relationships from episodic memories for the knowledge graph.
 * Output format: subject-predicate-object triples with typed objects.
 */

/**
 * Extract graph relations from episodic memories
 * 
 * @param {object[]} episodes - Extracted episodic memories
 * @param {string} userId
 * @returns {object[]} Array of relations { subject, predicate, object, objectType, properties, confidence }
 */
export async function extractRelations(episodes, userId) {
  if (!episodes || episodes.length === 0) return [];

  const episodeText = episodes
    .map((e, i) => `[${i}] ${e.content} (Entities: ${e.entities?.join(", ") || "none"})`)
    .join("\n");

  const systemPrompt = `You are an expert knowledge graph extraction AI. From the given episodic memories about a user, extract relationships that should be stored in a knowledge graph.

Each relationship should be a triple: (User) -[PREDICATE]-> (Object:Type)

Valid object types (pick the most specific):
- "Preference" — things the user likes/dislikes
- "Location" — places (cities, countries, addresses)
- "Organization" — companies, non-profits
- "Person" — people the user knows
- "Event" — significant events
- "Skill" — skills or abilities
- "Institution" — schools, universities
- "Food" — food items or cuisines
- "Hobby" — hobbies or activities
- "Pet" — pets
- "Language" — languages spoken
- "Project" — projects or work items
- "Topic" — topics of interest
- "Entity" — anything else

Valid predicate examples (use UPPER_SNAKE_CASE):
LIKES, DISLIKES, LIVES_IN, WORKS_AT, KNOWS, EXPERIENCED, HAS_SKILL, STUDIES_AT,
SPEAKS, OWNS, VISITED, PLANS_TO, BORN_IN, INTERESTED_IN, PLAYS, WORKS_ON, EATS,
PREFERS, MARRIED_TO, SIBLING_OF, PARENT_OF, CHILD_OF, FRIEND_OF, COLLEAGUE_OF

For each relation provide:
1. "predicate": The relationship type
2. "object": The entity name
3. "objectType": One of the valid types above
4. "properties": Additional properties (e.g., { "since": "2024", "role": "Engineer" })
5. "confidence": 0.0-1.0
6. "temporalContext": When this relation was established (if known)

Respond in JSON:
{
  "relations": [
    {
      "predicate": "WORKS_AT",
      "object": "Google",
      "objectType": "Organization",
      "properties": { "role": "Software Engineer", "since": "2024" },
      "confidence": 0.9,
      "temporalContext": "2024"
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
          content: `Extract knowledge graph relations from these episodes about user ${userId}:\n\n${episodeText}`,
        },
      ],
      response_format: { type: "json_object" },
      temperature: 0.1,
    });

    const result = JSON.parse(response.choices[0].message.content);
    return result.relations || [];
  } catch (error) {
    console.error("Relation extraction failed:", error.message);
    return [];
  }
}

export default { extractRelations };
