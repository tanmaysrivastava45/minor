import { OpenAIEmbeddings } from "@langchain/openai";
import { QdrantVectorStore } from "@langchain/qdrant";
import config from "../config/index.js";

let vectorStore = null;
let embeddings = null;

/**
 * Get embeddings instance (singleton)
 */
export function getEmbeddings() {
  if (!embeddings) {
    embeddings = new OpenAIEmbeddings({
      model: config.openai.embeddingModel,
      openAIApiKey: config.openai.apiKey,
    });
  }
  return embeddings;
}

/**
 * Initialize or get the Qdrant vector store
 */
export async function getVectorStore() {
  if (vectorStore) return vectorStore;

  try {
    const emb = getEmbeddings();
    vectorStore = await QdrantVectorStore.fromExistingCollection(emb, {
      url: config.qdrant.url,
      apiKey: config.qdrant.apiKey || undefined,
      collectionName: config.qdrant.collectionName,
    });
    console.log("✅ Qdrant vector store connected");
    return vectorStore;
  } catch (error) {
    // Collection might not exist yet, create it
    console.log("Creating new Qdrant collection...");
    const emb = getEmbeddings();
    // Create an empty collection by adding a dummy document then deleting it
    // Or simply use fromDocuments with an empty array (won't work)
    // Best approach: directly create with fromTexts
    vectorStore = await QdrantVectorStore.fromTexts(
      ["initialization"],
      [{ type: "init", userId: "system" }],
      emb,
      {
        url: config.qdrant.url,
        apiKey: config.qdrant.apiKey || undefined,
        collectionName: config.qdrant.collectionName,
      }
    );
    console.log("✅ Qdrant collection created and connected");
    return vectorStore;
  }
}

/**
 * Get a retriever with user-scoped filtering
 */
export async function getUserRetriever(userId, topK = null) {
  const store = await getVectorStore();
  // Scope every search to this user — without this filter, other users' episodes leak into the prompt.
  return store.asRetriever({
    k: topK || config.retrieval.vectorTopK,
    filter: { must: [{ key: "metadata.userId", match: { value: userId.toString() } }] },
  });
}

export default { getEmbeddings, getVectorStore, getUserRetriever };
