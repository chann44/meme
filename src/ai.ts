import { createGoogleGenerativeAI } from "@ai-sdk/google";

/** Supports `GEMINI_API_KEY` (project convention) or Google AI SDK env names. */
export function getGoogleApiKey(): string | undefined {
  return (
    process.env.GEMINI_API_KEY ||
    process.env.GOOGLE_GENERATIVE_AI_API_KEY ||
    process.env.GOOGLE_API_KEY ||
    undefined
  );
}

const google = createGoogleGenerativeAI({
  apiKey: getGoogleApiKey(),
});

export const OLLAMA_URL = process.env.OLLAMA_URL || "http://localhost:11434/v1/chat/completions";
export const OLLAMA_MODEL = process.env.OLLAMA_MODEL || "gemma4:e4b";

export const geminiModel = google("gemini-1.0-pro");
export const embeddingModel = google.embedding("gemini-embedding-2");