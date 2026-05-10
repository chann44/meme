import { z } from "zod";

const str = z.string().default("");
const arr = z.array(z.string()).default([]);
const bool = z.boolean().default(false);
const num = z.number().default(0);

export const MemeLabel = z.object({
  id: z.string(),
  primary_language: z.string().default("unknown"),
  supported_languages: arr,
  caption: z.object({
    original: str,
    translations: z.object({
      english: str,
      hindi: str,
      hinglish: str,
      tamil: str,
      telugu: str,
    }).default({ english: "", hindi: "", hinglish: "", tamil: "", telugu: "" }),
  }).default({ original: "", translations: { english: "", hindi: "", hinglish: "", tamil: "", telugu: "" } }),
  ocr_text: str,
  image_description: str,
  meaning: z.object({
    english: str,
    hindi: str,
    hinglish: str,
    tamil: str,
    telugu: str,
  }).default({ english: "", hindi: "", hinglish: "", tamil: "", telugu: "" }),
  emotion: arr,
  intent: z.union([z.array(z.string()), z.string()]).transform(v => Array.isArray(v) ? v : [v]).default([]),
  humor_type: arr,
  tone: arr,
  regions: arr,
  tags: z.object({
    english: arr,
    hindi: arr,
    hinglish: arr,
    tamil: arr,
    telugu: arr,
  }).default({ english: [], hindi: [], hinglish: [], tamil: [], telugu: [] }),
  query_examples: z.object({
    english: arr,
    hindi: arr,
    hinglish: arr,
    tamil: arr,
    telugu: arr,
  }).default({ english: [], hindi: [], hinglish: [], tamil: [], telugu: [] }),
  negative_examples: z.object({
    english: arr,
    hinglish: arr,
  }).default({ english: [], hinglish: [] }),
  // New: people/source/cultural context
  people: arr,
  source: str,
  cultural_references: arr,
  scene_description: str,
  safety: z.object({
    nsfw: bool,
    abusive: bool,
    hate: bool,
    political: bool,
    religious: bool,
  }).default({ nsfw: false, abusive: false, hate: false, political: false, religious: false }),
  quality: z.object({
    is_meme: bool,
    label_confidence: num,
  }).default({ is_meme: true, label_confidence: 0 }),
  multilingual_embedding_text: str,
});

export type MemeLabel = z.infer<typeof MemeLabel>;
