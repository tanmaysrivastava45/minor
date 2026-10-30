import mongoose from "mongoose";

const episodicMemorySchema = new mongoose.Schema(
  {
    userId: {
      type: String,
      required: true,
      index: true,
    },
    qdrantPointId: {
      type: String,
      required: true,
      unique: true,
    },
    content: {
      type: String,
      required: true,
    },
    emotionalValence: {
      type: String,
      enum: ["positive", "neutral", "negative"],
      default: "neutral",
    },
    temporalContext: {
      type: String,   // ISO date or descriptive like "last summer"
    },
    entities: [String],
    confidence: {
      type: Number,
      required: true,
      min: 0.0,
      max: 1.0,
      default: 0.7,
    },
    accessCount: {
      type: Number,
      default: 0,
    },
    lastAccessedAt: {
      type: Date,
      default: Date.now,
    },
    expiryAt: {
      type: Date,
      required: true,
    },
    miracleWindowEnd: {
      type: Date,
      required: true,
    },
    isExpired: {
      type: Boolean,
      default: false,
    },
    batchId: {
      type: String,
    },
    metadata: {
      relatedEpisodes: [{ type: mongoose.Schema.Types.ObjectId, ref: "EpisodicMemory" }],
      graphNodeIds: [String],     // Neo4j node IDs linked to this episode
      originalMessages: [String], // the original messages this was extracted from
    },
  },
  {
    timestamps: true,
  }
);

// Indexes
episodicMemorySchema.index({ userId: 1, isExpired: 1 });
episodicMemorySchema.index({ expiryAt: 1, isExpired: 1 });
episodicMemorySchema.index({ userId: 1, entities: 1 });

const EpisodicMemory = mongoose.model("EpisodicMemory", episodicMemorySchema);

export default EpisodicMemory;
