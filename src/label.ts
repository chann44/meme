import { join } from "path";
import { readdirSync, writeFileSync } from "fs";
import db from "./db/index.ts";
import { MemeLabel, type MemeLabel as MemeLabelType } from "./types.ts";
import { LABELING_PROMPT } from "./prompts.ts";
import { OLLAMA_URL, OLLAMA_MODEL } from "./ai.ts";

function extractJSON(text: string): string {
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) return fixJSON(fenceMatch[1]!.trim());
  const braceMatch = text.match(/\{[\s\S]*\}/);
  if (braceMatch) return fixJSON(braceMatch[0]);
  return fixJSON(text);
}

function fixJSON(text: string): string {
  let out = text;
  out = out.replace(/,\s*([}\]])/g, "$1");
  out = out.replace(/(\{|,|\[)\s*'([^']*)'\s*:/g, '$1"$2":');
  out = out.replace(/:\s*'([^']*)'\s*([,}\]])/g, ':"$1"$2');
  out = out.replace(/[\x00-\x1f]/g, (ch) => {
    if (ch === "\n" || ch === "\r" || ch === "\t") return ch;
    return "";
  });
  out = out.replace(/\/\/.*$/gm, "");
  out = out.replace(/\/\*[\s\S]*?\*\//g, "");

  return out;
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
            { type: "text", text: `Analyze this meme and return the JSON label. Set id to: ${memeId}` },
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

    if (!text.trim().endsWith("}")) {
      console.error(`[parse] Response appears truncated (doesn't end with '}'), retrying...`);
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
      const raw = extractJSON(text);
      const parsed = JSON.parse(raw);
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