import { join, resolve } from "path";
import { existsSync, readdirSync, statSync, writeFileSync } from "fs";
import db from "./db/index.ts";
import { MemeLabel, type MemeLabel as MemeLabelType } from "./types.ts";
import { LABELING_PROMPT } from "./prompts.ts";
import {
  OPENROUTER_CHAT_URL,
  OPENROUTER_LABEL_MODEL,
  getOpenRouterApiKey,
} from "./ai.ts";

const IMAGE_FILE_RE = /\.(jpg|jpeg|png|webp)$/i;

function isImageFilePath(p: string): boolean {
  if (!IMAGE_FILE_RE.test(p)) return false;
  try {
    return existsSync(p) && statSync(p).isFile();
  } catch {
    return false;
  }
}

function assistantTextFromChatResponse(data: unknown): string {
  const d = data as {
    choices?: { message?: { content?: string | null | Array<{ type?: string; text?: string }> } }[];
  };
  const raw = d.choices?.[0]?.message?.content;
  if (raw == null) return "";
  if (typeof raw === "string") return raw;
  if (Array.isArray(raw)) {
    return raw
      .map((part) => {
        if (typeof part === "object" && part && "text" in part && typeof part.text === "string") {
          return part.text;
        }
        return "";
      })
      .join("");
  }
  return String(raw);
}

function openRouterHeaders(apiKey: string): Record<string, string> {
  const h: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
  };
  const referer = process.env.OPENROUTER_HTTP_REFERER?.trim();
  if (referer) h["HTTP-Referer"] = referer;
  const title = process.env.OPENROUTER_APP_TITLE?.trim();
  if (title) h["X-Title"] = title;
  return h;
}

function parseTOONToJSON(toonText: string): any {
  const lines = toonText.trim().split('\n');
  const result: any = {};
  const stack: any[] = [result];
  const indentStack: number[] = [0];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line.trim() || line.trim().startsWith('#')) continue;

    const indent = line.search(/\S/);
    const content = line.slice(indent);

    while (indentStack.length > 1 && indent <= indentStack[indentStack.length - 1]!) {
      indentStack.pop();
      stack.pop();
    }

    const current = stack[stack.length - 1]!;

    if (content.includes('[') && content.includes(']') && content.includes('{') && content.includes('}')) {
      const match = content.match(/^(\w+)\[(\d+)\]\{([^}]+)\}:$/);
      if (match) {
        const arrayName = match[1]!;
        const fields = match[3]!;
        const fieldList = fields.split(',').map(f => f.trim());
        current[arrayName] = [];

        const dataIndent = indent + 2;
        let j = i + 1;
        while (j < lines.length) {
          const dataLine = lines[j]!;
          const dataLineIndent = dataLine.search(/\S/);
          if (dataLineIndent !== dataIndent) break;

          const values = dataLine.trim().split(',').map(v => parseValue(v.trim()));
          const obj: any = {};
          fieldList.forEach((field, idx) => {
            obj[field] = values[idx];
          });
          current[arrayName].push(obj);
          j++;
        }
        i = j - 1;
        continue;
      }
    }

    if (content.includes('[') && content.includes(']:')) {
      const match = content.match(/^(\w+)\[(\d+)\]:(.*)$/);
      if (match) {
        const arrayName = match[1]!;
        const values = match[3]!;
        current[arrayName] = values.trim().split(',').map(v => parseValue(v.trim()));
        continue;
      }
    }

    if (content.includes(':')) {
      const colonIndex = content.indexOf(':');
      const key = content.slice(0, colonIndex).trim();
      const value = content.slice(colonIndex + 1).trim();

      if (value === '') {
        const newObj: any = {};
        current[key] = newObj;
        stack.push(newObj);
        indentStack.push(indent);
      } else {
        current[key] = parseValue(value);
      }
    }
  }

  return result;
}

const ARRAY_FIELDS = new Set([
  'supported_languages', 'emotion', 'humor_type', 'tone', 'regions',
  'english', 'hindi', 'hinglish', 'tamil', 'telugu',
]);

function toArray(value: any): any {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string' && value.includes(',')) {
    return value.split(',').map(v => parseValue(v.trim())).filter(v => v !== '');
  }
  return [value];
}

function normalizeTOON(obj: any): any {
  if (obj.supported_languages) obj.supported_languages = toArray(obj.supported_languages);
  if (obj.emotion) obj.emotion = toArray(obj.emotion);
  if (obj.intent && typeof obj.intent === 'string') obj.intent = [obj.intent];
  if (obj.humor_type) obj.humor_type = toArray(obj.humor_type);
  if (obj.tone) obj.tone = toArray(obj.tone);
  if (obj.regions) obj.regions = toArray(obj.regions);
  if (obj.people) obj.people = toArray(obj.people);
  if (obj.cultural_references) obj.cultural_references = toArray(obj.cultural_references);

  for (const section of ['tags', 'query_examples', 'negative_examples', 'do_not_show_when']) {
    if (obj[section]) {
      for (const lang of ['english', 'hindi', 'hinglish', 'tamil', 'telugu']) {
        if (obj[section][lang]) obj[section][lang] = toArray(obj[section][lang]);
      }
    }
  }

  return obj;
}

function parseValue(value: string): any {
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value === 'null') return null;

  if (value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1);
  }

  const num = Number(value);
  if (!isNaN(num)) return num;

  return value;
}

const MAX_RETRIES = 3;

async function callOpenRouterVision(imagePath: string, memeId: string): Promise<string> {
  const apiKey = getOpenRouterApiKey();
  if (!apiKey) {
    throw new Error("OPENROUTER_API_KEY is not set (add it to .env)");
  }

  const file = Bun.file(imagePath);
  const base64Image = Buffer.from(await file.arrayBuffer()).toString("base64");
  const mimeType = file.type || (imagePath.endsWith(".png") ? "image/png" : "image/jpeg");

  const t0 = performance.now();
  const response = await fetch(OPENROUTER_CHAT_URL, {
    method: "POST",
    headers: openRouterHeaders(apiKey),
    body: JSON.stringify({
      model: OPENROUTER_LABEL_MODEL,
      max_tokens: 16384,
      messages: [
        { role: "system", content: LABELING_PROMPT },
        {
          role: "user",
          content: [
            { type: "image_url", image_url: { url: `data:${mimeType};base64,${base64Image}` } },
            { type: "text", text: `Analyze this meme and return the TOON label. Set id to: ${memeId}` },
          ],
        },
      ],
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    const ms = Math.round(performance.now() - t0);
    console.log(`[openrouter] ${ms}ms (failed HTTP ${response.status})`);
    throw new Error(`OpenRouter error: ${response.status} ${err}`);
  }

  const data = await response.json();
  const text = assistantTextFromChatResponse(data);
  const ms = Math.round(performance.now() - t0);
  console.log(`[openrouter] ${ms}ms (AI)`);

  if (!text.trim()) {
    throw new Error("OpenRouter returned empty assistant content");
  }
  return text;
}

export async function labelMeme(imagePath: string, memeId: string): Promise<MemeLabelType> {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    console.log(
      `[openrouter] model=${OPENROUTER_LABEL_MODEL} ${memeId} (attempt ${attempt}/${MAX_RETRIES})...`
    );
    const text = await callOpenRouterVision(imagePath, memeId);
    console.log(`[openrouter] Response length: ${text.length} chars`);

    if (!text.trim().includes('multilingual_embedding_text:')) {
      console.error(`[parse] Response appears truncated (missing multilingual_embedding_text), retrying...`);
      if (attempt === MAX_RETRIES) throw new Error("Response truncated after max retries");
      await new Promise((r) => setTimeout(r, 2000));
      continue;
    }

    const debugPath = join(import.meta.dir, "..", "debug", `${memeId}_attempt${attempt}.txt`);
    try {
      writeFileSync(debugPath, text);
      console.log(`[debug] Raw response saved to ${debugPath}`);
    } catch {}

    try {
      const raw = parseTOONToJSON(text);
      const parsed = normalizeTOON(raw);
      console.log(`[parse] Parsed keys: ${Object.keys(parsed).join(", ")}`);
      const label = MemeLabel.parse(parsed);
      console.log(`[zod] Validated: id=${label.id}, language=${label.primary_language}, intent=${label.intent}`);
      return label;
    } catch (parseErr) {
      console.error(`[parse] Attempt ${attempt} failed: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}`);
      if (attempt === MAX_RETRIES) throw parseErr;
      console.log(`[parse] Retrying...`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }

  throw new Error("Max retries exceeded");
}

/** Label a single image file (one OpenRouter call path). Useful for manual testing. */
export async function labelOneImageFile(imagePathAbs: string): Promise<{
  label: MemeLabelType;
  imagePath: string;
}> {
  const resolved = resolve(imagePathAbs);
  if (!isImageFilePath(resolved)) {
    throw new Error(`Not a readable image file: ${resolved}`);
  }
  const memeId = `meme_${Date.now()}`;
  console.log(`\n=== single image ===`);
  console.log(resolved);
  const label = await labelMeme(resolved, memeId);
  await saveMemeLabel(label, resolved);
  console.log(`✓ Saved to DB: ${resolved}`);
  return { label, imagePath: resolved };
}

function buildFTSSearchText(label: MemeLabelType): string {
  const parts: string[] = [];
  if (label.caption.original) parts.push(label.caption.original);
  if (label.caption.translations.english) parts.push(label.caption.translations.english);
  if (label.ocr_text) parts.push(label.ocr_text);
  if (label.image_description) parts.push(label.image_description);
  if (label.scene_description) parts.push(label.scene_description);
  if (label.meaning.english) parts.push(label.meaning.english);
  if (label.meaning.hinglish) parts.push(label.meaning.hinglish);
  if (label.source) parts.push(label.source);
  parts.push(...label.people);
  parts.push(...label.cultural_references);
  parts.push(...label.tags.english);
  parts.push(...label.tags.hinglish);
  parts.push(...label.query_examples.english);
  parts.push(...label.query_examples.hinglish);
  return parts.filter(Boolean).join(' ');
}

function normalizePeopleName(name: string): string {
  return name
    .toLowerCase()
    .replace(/\s*\(.*?\)/g, '') // strip parenthetical variants
    .trim();
}

export async function saveMemeLabel(label: MemeLabelType, imagePath: string) {
  await db.execute({
    sql: `
      INSERT INTO memes (
        id, image_path, primary_language, supported_languages,
        caption, meaning, tags, query_examples,
        emotion, intent, regions, safety, quality,
        multilingual_embedding_text, labeled_at,
        ocr_text, image_description,
        people, source, cultural_references, scene_description
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    args: [
      String(label.id),
      String(imagePath),
      String(label.primary_language),
      JSON.stringify(label.supported_languages),
      JSON.stringify(label.caption),
      JSON.stringify(label.meaning),
      JSON.stringify(label.tags),
      JSON.stringify(label.query_examples),
      JSON.stringify(label.emotion),
      JSON.stringify(label.intent),
      JSON.stringify(label.regions),
      JSON.stringify(label.safety),
      JSON.stringify(label.quality),
      String(label.multilingual_embedding_text),
      new Date().toISOString(),
      String(label.ocr_text),
      String(label.image_description),
      JSON.stringify(label.people),
      String(label.source),
      JSON.stringify(label.cultural_references),
      String(label.scene_description),
    ],
  });

  // Populate inverted people index
  if (label.people.length > 0) {
    const peopleInserts = label.people.map((rawName) => ({
      sql: `INSERT OR IGNORE INTO meme_people(person_name, meme_id) VALUES (?, ?)`,
      args: [normalizePeopleName(rawName), String(label.id)],
    }));
    try {
      await db.batch(peopleInserts, "write");
    } catch {}
  }

  // Populate FTS index
  try {
    const searchText = buildFTSSearchText(label);
    await db.execute({
      sql: `INSERT OR REPLACE INTO memes_fts(meme_id, search_text) VALUES (?, ?)`,
      args: [String(label.id), searchText],
    });
  } catch {}
}

export type LabelFolderOptions = {
  /** Process at most this many images (after sort). Omit = all. */
  limit?: number;
};

export async function labelFolder(folderPath: string, options: LabelFolderOptions = {}) {
  const { limit } = options;
  let allFiles = readdirSync(folderPath).filter((f) =>
    /\.(jpg|jpeg|png|webp)$/i.test(f)
  );

  allFiles.sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }));

  if (limit !== undefined && limit > 0 && allFiles.length > limit) {
    console.log(`Using first ${limit} of ${allFiles.length} images (sorted by filename)`);
    allFiles = allFiles.slice(0, limit);
  }

  console.log(`Found ${allFiles.length} images`);

  let succeeded = 0;
  let failed = 0;

  for (const file of allFiles) {
    const imagePath = join(folderPath, file);
    const memeId = `meme_${Date.now()}`;

    try {
      console.log(`\n=== [${succeeded + failed + 1}/${allFiles.length}] ${file} ===`);
      const label = await labelMeme(imagePath, memeId);
      await saveMemeLabel(label, imagePath);
      succeeded++;
      console.log(`✓ Saved ${file}`);
    } catch (err) {
      failed++;
      console.error(`✗ Failed ${file}:`, err);
    }

    await new Promise((r) => setTimeout(r, 1000));
  }

  return { total: allFiles.length, succeeded, failed };
}

if (import.meta.main) {
  const arg = process.argv[2] || "./memes";
  const asFile = resolve(arg);
  if (isImageFilePath(asFile)) {
    labelOneImageFile(asFile).catch((err) => {
      console.error(err);
      process.exit(1);
    });
  } else {
    const maybeLimit = process.argv[3];
    const limit =
      maybeLimit && /^\d+$/.test(maybeLimit) ? parseInt(maybeLimit, 10) : undefined;
    labelFolder(arg, { limit }).catch((err) => {
      console.error(err);
      process.exit(1);
    });
  }
}