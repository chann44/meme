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

export const geminiModel = google("gemini-1.0-pro");
export const embeddingModel = google.embedding("gemini-embedding-2");

/** OpenRouter (OpenAI-compatible) for vision labeling — set `OPENROUTER_API_KEY` in `.env`. */
export function getOpenRouterApiKey(): string | undefined {
  return process.env.OPENROUTER_API_KEY?.trim() || undefined;
}

export const OPENROUTER_CHAT_URL =
  process.env.OPENROUTER_BASE_URL?.trim() || "https://openrouter.ai/api/v1/chat/completions";

/** Default matches OpenRouter model id for Gemini 2.5 Flash Lite. */
export const OPENROUTER_LABEL_MODEL =
  process.env.OPENROUTER_MODEL?.trim() || "google/gemini-2.5-flash-lite";