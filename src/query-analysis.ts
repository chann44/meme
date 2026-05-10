import { generateObject } from "ai";
import { z } from "zod";
import { analysisChatModel } from "./ai.ts";
import { QUERY_ANALYSIS_SYSTEM_PROMPT } from "./prompts.ts";

const QueryAnalysisSchema = z.object({
  language: z.enum([
    "hindi", "hinglish", "english", "tamil", "telugu",
    "kannada", "malayalam", "marathi", "bengali", "punjabi", "gujarati", "unknown",
  ]),
  emotions: z.array(z.enum([
    "shock", "sarcasm", "anger", "joy", "sadness", "confusion", "awkward",
    "embarrassment", "flirting", "disappointment", "excitement", "fear",
    "pride", "jealousy", "boredom", "sleepy", "stress", "cringe",
    "suspicion", "approval", "disapproval",
  ])).max(3),
  intents: z.array(z.enum([
    "react_to_absurdity", "roast_someone", "agree", "disagree", "celebrate",
    "flirt", "tease", "show_confusion", "show_disappointment", "show_shock",
    "show_sarcasm", "avoid_reply", "late_reply", "fake_motivation", "exam_stress",
    "office_stress", "relationship_drama", "money_problem", "food_craving",
    "sleepy_reply", "unknown",
  ])).max(3),
  regions: z.array(z.enum([
    "pan_india", "north_india", "south_india", "west_india", "east_india",
    "delhi", "mumbai", "bangalore", "chennai", "hyderabad", "punjab", "gujarat",
    "maharashtra", "bengal", "kerala", "tamil_nadu", "andhra_telangana",
    "karnataka", "unknown",
  ])).max(2),
  detected_people: z.array(z.string()).default([]),
  source_reference: z.string().default(""),
  expanded_text: z.string(),
});

export type QueryAnalysis = z.infer<typeof QueryAnalysisSchema>;

export async function analyzeQuery(rawQuery: string): Promise<QueryAnalysis> {
  const { object } = await generateObject({
    model: analysisChatModel,
    schema: QueryAnalysisSchema,
    system: QUERY_ANALYSIS_SYSTEM_PROMPT,
    prompt: rawQuery,
  });
  return object;
}
