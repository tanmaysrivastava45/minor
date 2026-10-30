import "dotenv/config";

const config = {
  // OpenAI
  openai: {
    apiKey: process.env.OPENAI_API_KEY,
    llmModel: process.env.LLM_MODEL || "gpt-4.1-mini",
    embeddingModel: process.env.EMBEDDING_MODEL || "text-embedding-3-large",
  },

  // MongoDB
  mongodb: {
    uri: process.env.MONGODB_URI || "mongodb://localhost:27017/cortex_memory",
  },

  // Qdrant
  qdrant: {
    url: process.env.QDRANT_URL || "http://localhost:6333",
    apiKey: process.env.QDRANT_API_KEY || "",
    collectionName: "cortex-episodic-memory",
  },

  // Neo4j
  neo4j: {
    uri: process.env.NEO4J_URI || "bolt://localhost:7687",
    username: process.env.NEO4J_USERNAME || "neo4j",
    password: process.env.NEO4J_PASSWORD || "password",
    database: process.env.NEO4J_DATABASE || "neo4j",
  },

  // Memory Configuration
  memory: {
    batchSize: parseInt(process.env.BATCH_SIZE) || 30,
  },

  // Temporal Decay Configuration (in days)
  temporalDecay: {
    expiry: {
      immutable: parseInt(process.env.EXPIRY_IMMUTABLE) || 365,
      semi_mutable: parseInt(process.env.EXPIRY_SEMI_MUTABLE) || 90,
      mutable: parseInt(process.env.EXPIRY_MUTABLE) || 30,
      episodic: parseInt(process.env.EXPIRY_EPISODIC) || 60,
    },
    miracleWindowDays: parseInt(process.env.MIRACLE_WINDOW_DAYS) || 7,
    rescueExtensionDays: parseInt(process.env.RESCUE_EXTENSION_DAYS) || 14,
    maxRescueExtensionDays: 90,
    confidenceRescueBoost: 0.1,
    maxConfidence: 1.0,
    minConfidence: 0.05,
    cleanupConfidenceThreshold: 0.1,
  },

  // Confidence source factors
  confidence: {
    sourceFactor: {
      explicit: 1.0,
      corrected: 0.9,
      inferred: 0.7,
    },
    hardnessFactor: {
      immutable: 1.0,
      semi_mutable: 0.85,
      mutable: 0.65,
    },
    // Conflict resolution thresholds
    immutableOverrideThreshold: 0.95,
    confidenceDifferenceThreshold: 0.2,
    accessCountDominanceMultiplier: 2,
  },

  // Retrieval configuration
  retrieval: {
    vectorTopK: 15,
    maxFactualResults: 50,
    maxGraphDepth: 3,
  },
};

// Validate required config
function validateConfig() {
  const required = [
    ["openai.apiKey", config.openai.apiKey],
  ];

  const missing = required.filter(([name, val]) => !val);
  if (missing.length > 0) {
    console.warn(
      `⚠️  Missing configuration: ${missing.map(([n]) => n).join(", ")}. Some features may not work.`
    );
  }
}

validateConfig();

export default config;
