import mongoose from "mongoose";

const messageSchema = new mongoose.Schema({
  role: {
    type: String,
    required: true,
    enum: ["user", "assistant"],
  },
  content: {
    type: String,
    required: true,
  },
  timestamp: {
    type: Date,
    default: Date.now,
  },
});

const messageBufferSchema = new mongoose.Schema(
  {
    userId: {
      type: String,
      required: true,
      index: true,
    },
    sessionId: {
      type: String,
      required: true,
    },
    messages: [messageSchema],
    batchNumber: {
      type: Number,
      default: 0,
    },
    isConsolidated: {
      type: Boolean,
      default: false,
    },
    consolidatedAt: {
      type: Date,
    },
  },
  {
    timestamps: true,
  }
);

// Compound index for efficient buffer lookup
messageBufferSchema.index({ userId: 1, sessionId: 1, isConsolidated: 1 });

const MessageBuffer = mongoose.model("MessageBuffer", messageBufferSchema);

export default MessageBuffer;
