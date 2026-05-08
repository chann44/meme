import { createGoogleGenerativeAI } from "@ai-sdk/google";

const google = createGoogleGenerativeAI({
  apiKey: process.env.GEMINI_API_KEY,
});

export const OLLAMA_URL = process.env.OLLAMA_URL || "http://localhost:11434/v1/chat/completions";
export const OLLAMA_MODEL = process.env.OLLAMA_MODEL || "gemma4:e4b";

export const geminiModel = google("gemini-2.0-flash");
export const embeddingModel = google.textEmbeddingModel("text-embedding-004");