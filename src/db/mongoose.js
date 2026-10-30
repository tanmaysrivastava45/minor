import mongoose from "mongoose";
import config from "../config/index.js";

let isConnected = false;

/**
 * Connect to MongoDB with retry logic
 */
export async function connectMongoDB() {
  if (isConnected) return mongoose.connection;

  try {
    const conn = await mongoose.connect(config.mongodb.uri, {
      maxPoolSize: 10,
      serverSelectionTimeoutMS: 5000,
      socketTimeoutMS: 45000,
    });

    isConnected = true;
    console.log(`✅ MongoDB connected: ${conn.connection.host}`);
    return conn.connection;
  } catch (error) {
    console.error("❌ MongoDB connection failed:", error.message);
    // Retry after 5 seconds
    console.log("Retrying in 5 seconds...");
    await new Promise((r) => setTimeout(r, 5000));
    return connectMongoDB();
  }
}

/**
 * Disconnect from MongoDB
 */
export async function disconnectMongoDB() {
  if (!isConnected) return;
  await mongoose.disconnect();
  isConnected = false;
  console.log("MongoDB disconnected");
}

export default { connectMongoDB, disconnectMongoDB };
