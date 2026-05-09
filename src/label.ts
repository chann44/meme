import { join } from "path";
import { readdirSync, writeFileSync } from "fs";
import db from "./db/index.ts";
import { MemeLabel, type MemeLabel as MemeLabelType } from "./types.ts";
import { LABELING_PROMPT } from "./prompts.ts";
import { OLLAMA_URL, OLLAMA_MODEL } from "./ai.ts";

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

  for (const section of ['tags', 'query_examples', 'negative_examples']) {
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

async function callOllama(imagePath: string, memeId: string): Promise<string> {
  const file = Bun.file(imagePath);
  const base64Image = Buffer.from(await file.arrayBuffer()).toString("base64");
  const mimeType = file.type || (imagePath.endsWith(".png") ? "image/png" : "image/jpeg");

  const response = await fetch(OLLAMA_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: OLLAMA_MODEL,
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
    throw new Error(`Ollama API error: ${response.status} ${err}`);
  }

  const data = (await response.json()) as { choices: { message: { content: string } }[] };
  return data.choices[0]!.message.content;
}

export async function labelMeme(imagePath: string, memeId: string): Promise<MemeLabelType> {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    console.log(`[ollama] Sending request for ${memeId} (attempt ${attempt}/${MAX_RETRIES})...`);
    const text = await callOllama(imagePath, memeId);
    console.log(`[ollama] Response length: ${text.length} chars`);

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

export function saveMemeLabel(label: MemeLabelType, imagePath: string) {
  const stmt = db.prepare(`
    INSERT INTO memes (
      id, image_path, primary_language, supported_languages,
      caption, meaning, tags, query_examples,
      emotion, intent, regions, safety, quality,
      multilingual_embedding_text, labeled_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  stmt.run(
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
    new Date().toISOString()
  );
}

export async function labelFolder(folderPath: string) {
  const allFiles = readdirSync(folderPath).filter((f) =>
    /\.(jpg|jpeg|png|webp)$/i.test(f)
  );

  console.log(`Found ${allFiles.length} images`);

  let succeeded = 0;
  let failed = 0;

  for (const file of allFiles) {
    const imagePath = join(folderPath, file);
    const memeId = `meme_${Date.now()}`;

    try {
      console.log(`\n=== [${succeeded + failed + 1}/${allFiles.length}] ${file} ===`);
      const label = await labelMeme(imagePath, memeId);
      saveMemeLabel(label, imagePath);
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
  const folder = process.argv[2] || "./memes";
  labelFolder(folder);
}