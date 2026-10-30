import mongoose from "mongoose";

const factualMemorySchema = new mongoose.Schema(
  {
    userId: {
      type: String,
      required: true,
      index: true,
    },
    fact: {
      type: String,
      required: true,
    },
    category: {
      type: String,
      required: true,
      enum: [
        "identity",        // name, age, gender
        "preference",      // food, music, hobbies
        "biographical",    // birthday, birthplace, family
        "professional",    // job, company, skills
        "social",          // friends, relationships
        "educational",     // degrees, schools
        "health",          // medical, fitness
        "location",        // current residence, past residences
        "financial",       // income, spending habits
        "other",
      ],
      index: true,
    },
    hardness: {
      type: String,
      required: true,
      enum: ["immutable", "semi_mutable", "mutable"],
      default: "mutable",
    },
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
    source: {
      type: String,
      required: true,
      enum: ["explicit", "inferred", "corrected"],
      default: "explicit",
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
    isSuperseded: {
      type: Boolean,
      default: false,
    },
    metadata: {
      extractedFrom: String,      // batch reference ID
      relatedFacts: [{ type: mongoose.Schema.Types.ObjectId, ref: "FactualMemory" }],
      supersedes: { type: mongoose.Schema.Types.ObjectId, ref: "FactualMemory" },
      supersededBy: { type: mongoose.Schema.Types.ObjectId, ref: "FactualMemory" },
      version: { type: Number, default: 1 },
      entities: [String],         // extracted entity names for quick lookup
      originalMessage: String,    // the original message this was extracted from
    },
  },
  {
    timestamps: true,
  }
);

// Compound indexes for efficient queries
factualMemorySchema.index({ userId: 1, category: 1, isExpired: 1 });
factualMemorySchema.index({ userId: 1, isSuperseded: 1, isExpired: 1 });
factualMemorySchema.index({ expiryAt: 1, isExpired: 1 });
factualMemorySchema.index({ userId: 1, "metadata.entities": 1 });

const FactualMemory = mongoose.model("FactualMemory", factualMemorySchema);

export default FactualMemory;
