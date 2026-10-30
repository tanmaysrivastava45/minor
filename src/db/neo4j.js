import neo4j from "neo4j-driver";
import config from "../config/index.js";

let driver = null;

/**
 * Get or create Neo4j driver singleton
 */
export function getNeo4jDriver() {
  if (!driver) {
    driver = neo4j.driver(
      config.neo4j.uri,
      neo4j.auth.basic(config.neo4j.username, config.neo4j.password),
      {
        maxConnectionPoolSize: 50,
        connectionAcquisitionTimeout: 10000,
      }
    );
    console.log("✅ Neo4j driver initialized");
  }
  return driver;
}

/**
 * Execute a Cypher query with automatic session management
 */
export async function executeCypher(query, params = {}) {
  const d = getNeo4jDriver();
  try {
    const result = await d.executeQuery(query, params, {
      database: config.neo4j.database,
    });
    return result;
  } catch (error) {
    console.error("❌ Neo4j query error:", error.message);
    throw error;
  }
}

/**
 * Close Neo4j driver
 */
export async function closeNeo4j() {
  if (driver) {
    await driver.close();
    driver = null;
    console.log("Neo4j driver closed");
  }
}

/**
 * Initialize Neo4j constraints and indexes for performance
 */
export async function initNeo4jSchema() {
  const constraints = [
    "CREATE CONSTRAINT IF NOT EXISTS FOR (u:User) REQUIRE u.id IS UNIQUE",
    "CREATE CONSTRAINT IF NOT EXISTS FOR (p:Preference) REQUIRE p.id IS UNIQUE",
    "CREATE CONSTRAINT IF NOT EXISTS FOR (l:Location) REQUIRE l.id IS UNIQUE",
    "CREATE CONSTRAINT IF NOT EXISTS FOR (o:Organization) REQUIRE o.id IS UNIQUE",
    "CREATE CONSTRAINT IF NOT EXISTS FOR (pe:Person) REQUIRE pe.id IS UNIQUE",
    "CREATE CONSTRAINT IF NOT EXISTS FOR (e:Event) REQUIRE e.id IS UNIQUE",
    "CREATE CONSTRAINT IF NOT EXISTS FOR (s:Skill) REQUIRE s.id IS UNIQUE",
    "CREATE CONSTRAINT IF NOT EXISTS FOR (i:Institution) REQUIRE i.id IS UNIQUE",
  ];

  for (const constraint of constraints) {
    try {
      await executeCypher(constraint);
    } catch (error) {
      // Constraints may already exist, that's fine
      if (!error.message.includes("already exists")) {
        console.warn(`Neo4j constraint warning: ${error.message}`);
      }
    }
  }
  console.log("✅ Neo4j schema initialized");
}

export default { getNeo4jDriver, executeCypher, closeNeo4j, initNeo4jSchema };
