import { v4 as uuidv4 } from "uuid";
import { executeCypher, initNeo4jSchema } from "../db/neo4j.js";

/**
 * Graph Memory Store
 * Handles Neo4j knowledge graph operations for user entity relationships.
 * Supports: MERGE nodes, create/update relationships, fetch user graph,
 * and update relations from episodic memories.
 */

// ============================================================================
// INITIALIZATION
// ============================================================================

/**
 * Ensure Neo4j schema (constraints/indexes) is set up
 */
export async function initGraphStore() {
  await initNeo4jSchema();
}

// ============================================================================
// USER NODE
// ============================================================================

/**
 * Ensure user node exists in the graph
 * @param {string} userId
 * @param {string} name - Optional user name
 */
export async function ensureUserNode(userId, name = null) {
  const query = name
    ? `MERGE (u:User {id: $userId}) SET u.name = $name RETURN u`
    : `MERGE (u:User {id: $userId}) RETURN u`;

  await executeCypher(query, { userId: userId.toString(), name });
}

// ============================================================================
// ADD RELATIONS
// ============================================================================

/**
 * Add a relationship to the knowledge graph
 * Uses MERGE to avoid duplicates
 * 
 * @param {object} params
 * @param {string} params.userId - The user ID
 * @param {string} params.subject - Subject entity (usually the user)
 * @param {string} params.predicate - Relationship type (e.g., "LIKES", "WORKS_AT")
 * @param {string} params.object - Object entity
 * @param {string} params.objectType - Node type for the object (e.g., "Preference", "Organization")
 * @param {object} params.properties - Additional properties for the relationship/object node
 * @param {number} params.confidence - Confidence score
 * @returns {object} Result of the operation
 */
export async function addRelation({
  userId,
  subject = null,
  predicate,
  object,
  objectType = "Entity",
  properties = {},
  confidence = 0.7,
}) {
  // Generate a deterministic ID for the object node to enable MERGE
  const objectId = `${userId}_${objectType}_${object}`.toLowerCase().replace(/\s+/g, "_");
  
  // Clean predicate: convert to UPPER_SNAKE_CASE for Neo4j convention
  const cleanPredicate = predicate.toUpperCase().replace(/\s+/g, "_").replace(/[^A-Z0-9_]/g, "");

  // Build properties string for the object node
  const propEntries = Object.entries(properties);
  const propsSetClause = propEntries.length > 0
    ? `, ${propEntries.map(([k, v]) => `n.${k} = $prop_${k}`).join(", ")}`
    : "";

  // Build params
  const params = {
    userId: userId.toString(),
    objectId,
    objectName: object,
    confidence,
    updatedAt: new Date().toISOString(),
  };

  // Add property params
  for (const [k, v] of propEntries) {
    params[`prop_${k}`] = v;
  }

  // Dynamic label query — Neo4j doesn't support parameterized labels,
  // so we validate objectType to prevent injection
  const validTypes = [
    "Preference", "Location", "Organization", "Person",
    "Event", "Skill", "Institution", "Entity", "Topic",
    "Food", "Hobby", "Pet", "Language", "Project",
  ];
  const safeType = validTypes.includes(objectType) ? objectType : "Entity";

  const query = `
    MERGE (u:User {id: $userId})
    MERGE (n:${safeType} {id: $objectId})
    SET n.name = $objectName ${propsSetClause}
    MERGE (u)-[r:${cleanPredicate}]->(n)
    SET r.confidence = $confidence, r.updatedAt = $updatedAt
    RETURN u, r, n
  `;

  try {
    const result = await executeCypher(query, params);
    return {
      success: true,
      subject: userId,
      predicate: cleanPredicate,
      object,
      objectType: safeType,
    };
  } catch (error) {
    console.error("Failed to add graph relation:", error.message);
    return { success: false, error: error.message };
  }
}

/**
 * Add multiple relations from extracted relation data
 * 
 * @param {string} userId
 * @param {object[]} relations - Array of { subject, predicate, object, objectType, properties, confidence }
 * @returns {object[]} Results
 */
export async function addRelations(userId, relations) {
  const results = [];
  for (const rel of relations) {
    const result = await addRelation({
      userId,
      ...rel,
    });
    results.push(result);
  }
  return results;
}

// ============================================================================
// FETCH RELATIONS
// ============================================================================

/**
 * Fetch all relationships for a user from the knowledge graph
 * 
 * @param {string} userId
 * @returns {object} { graphMap: string, relations: object[] }
 */
export async function fetchUserGraph(userId) {
  const query = `
    MATCH (u:User {id: $userId})-[r]->(n)
    RETURN u, type(r) as relType, properties(r) as relProps, n, labels(n) as nodeLabels
  `;

  try {
    const { records } = await executeCypher(query, { userId: userId.toString() });

    if (!records || records.length === 0) {
      return {
        graphMap: "",
        relations: [],
      };
    }

    const relations = [];
    let graphMap = "";

    for (const record of records) {
      const user = record.get("u");
      const relType = record.get("relType");
      const relProps = record.get("relProps");
      const node = record.get("n");
      const nodeLabels = record.get("nodeLabels");

      const relation = {
        userProperties: user.properties,
        relationType: relType,
        relationProperties: relProps,
        nodeProperties: node.properties,
        nodeLabels,
      };

      relations.push(relation);

      graphMap += `User: ${JSON.stringify(user.properties)} `;
      graphMap += `-[${relType}]-> `;
      graphMap += `${nodeLabels.join(":")}(${JSON.stringify(node.properties)})\n`;
    }

    return { graphMap, relations };
  } catch (error) {
    console.error("Failed to fetch user graph:", error.message);
    return { graphMap: "", relations: [] };
  }
}

/**
 * Fetch relevant graph relations based on entities/query
 * More targeted than fetching the entire graph
 * 
 * @param {string} userId
 * @param {string[]} entities - Entity names to search for
 * @returns {object} { graphMap: string, relations: object[] }
 */
export async function fetchRelevantRelations(userId, entities = []) {
  if (entities.length === 0) {
    return fetchUserGraph(userId);
  }

  // Search for nodes matching any of the entities
  const query = `
    MATCH (u:User {id: $userId})-[r]->(n)
    WHERE any(e IN $entities WHERE toLower(n.name) CONTAINS toLower(e))
    RETURN u, type(r) as relType, properties(r) as relProps, n, labels(n) as nodeLabels
  `;

  try {
    const { records } = await executeCypher(query, {
      userId: userId.toString(),
      entities,
    });

    if (!records || records.length === 0) {
      // Fall back to full graph
      return fetchUserGraph(userId);
    }

    const relations = [];
    let graphMap = "";

    for (const record of records) {
      const user = record.get("u");
      const relType = record.get("relType");
      const relProps = record.get("relProps");
      const node = record.get("n");
      const nodeLabels = record.get("nodeLabels");

      relations.push({
        userProperties: user.properties,
        relationType: relType,
        relationProperties: relProps,
        nodeProperties: node.properties,
        nodeLabels,
      });

      graphMap += `User: ${JSON.stringify(user.properties)} `;
      graphMap += `-[${relType}]-> `;
      graphMap += `${nodeLabels.join(":")}(${JSON.stringify(node.properties)})\n`;
    }

    return { graphMap, relations };
  } catch (error) {
    console.error("Failed to fetch relevant relations:", error.message);
    return fetchUserGraph(userId);
  }
}

// ============================================================================
// UPDATE RELATIONS (from episodic memories)
// ============================================================================

/**
 * Update graph relations based on extracted relations from episodic memories
 * Handles versioning (e.g., user changed jobs)
 * 
 * @param {string} userId
 * @param {object[]} newRelations
 */
export async function updateRelationsFromEpisodic(userId, newRelations) {
  for (const rel of newRelations) {
    // Check if a conflicting relation exists
    const existingQuery = `
      MATCH (u:User {id: $userId})-[r:${rel.predicate.toUpperCase().replace(/\s+/g, "_").replace(/[^A-Z0-9_]/g, "")}]->(n)
      RETURN r, n
    `;

    try {
      const { records } = await executeCypher(existingQuery, {
        userId: userId.toString(),
      });

      if (records && records.length > 0) {
        // Existing relation found — update if the object changed
        const existingNode = records[0].get("n");
        if (
          existingNode.properties.name &&
          existingNode.properties.name.toLowerCase() !== rel.object.toLowerCase()
        ) {
          // Object changed: add temporal marker to old relation and create new
          const archiveQuery = `
            MATCH (u:User {id: $userId})-[r:${rel.predicate.toUpperCase().replace(/\s+/g, "_").replace(/[^A-Z0-9_]/g, "")}]->(n)
            SET r.endDate = $endDate, r.isCurrent = false
          `;
          await executeCypher(archiveQuery, {
            userId: userId.toString(),
            endDate: new Date().toISOString(),
          });
        }
      }

      // Add/update the relation
      await addRelation({
        userId,
        predicate: rel.predicate,
        object: rel.object,
        objectType: rel.objectType || "Entity",
        properties: {
          ...rel.properties,
          isCurrent: true,
          startDate: rel.temporalContext || new Date().toISOString(),
        },
        confidence: rel.confidence || 0.7,
      });
    } catch (error) {
      // If the relation type doesn't exist yet, just add it
      await addRelation({
        userId,
        predicate: rel.predicate,
        object: rel.object,
        objectType: rel.objectType || "Entity",
        properties: rel.properties || {},
        confidence: rel.confidence || 0.7,
      });
    }
  }
}

export default {
  initGraphStore,
  ensureUserNode,
  addRelation,
  addRelations,
  fetchUserGraph,
  fetchRelevantRelations,
  updateRelationsFromEpisodic,
};
