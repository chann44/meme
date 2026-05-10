import { embed } from "ai";
import { resolve } from "node:path";
import db from "./db/index.ts";
import { embeddingModel } from "./ai.ts";

const EMBED_MODEL_ID = "gemini-embedding-2";

type FullMemeRow = {
  id: string;
  multilingual_embedding_text: string;
  people: string | null;
  source: string | null;
  cultural_references: string | null;
  scene_description: string | null;
  ocr_text: string | null;
  image_description: string | null;
  caption: string | null;
  meaning: string | null;
  tags: string | null;
  query_examples: string | null;
  emotion: string | null;
  intent: string | null;
  regions: string | null;
};

type LabelRow = {
  id: string;
  multilingual_embedding_text: string;
  image_path?: string;
  caption?: { original?: string };
};

type LabelCacheFile = {
  model: string;
  built_at: string;
  entries: { id: string; embedding: number[] }[];
};

function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dotProduct / denom;
}

function safeParse(v: string | null): any {
  if (!v) return null;
  try { return JSON.parse(v); } catch { return null; }
}

function buildPeopleText(meme: FullMemeRow): string {
  const parts: string[] = [];
  const people = safeParse(meme.people) as string[] | null;
  const source = meme.source?.trim() || '';

  if (people?.length) {
    parts.push(`People: ${people.join(', ')}.`);
    parts.push(`Names: ${people.join(' ')}.`);
  }
  if (source) {
    parts.push(`Source: ${source}.`);
    parts.push(`Origin: ${source}.`);
  }
  const culturalRefs = safeParse(meme.cultural_references) as string[] | null;
  if (culturalRefs?.length) {
    parts.push(`Cultural references: ${culturalRefs.join('. ')}.`);
  }
  if (meme.ocr_text?.trim()) {
    parts.push(`OCR text: ${meme.ocr_text.trim()}.`);
  }

  return parts.join(' ') || 'No specific people or source identified.';
}

function buildContextText(meme: FullMemeRow): string {
  const parts: string[] = [];
  const scene = meme.scene_description?.trim() || '';
  const imgDesc = meme.image_description?.trim() || '';
  const source = meme.source?.trim() || '';
  const culturalRefs = safeParse(meme.cultural_references) as string[] | null;
  const cap = safeParse(meme.caption);
  const people = safeParse(meme.people) as string[] | null;

  if (scene) parts.push(`Scene: ${scene}.`);
  if (imgDesc) parts.push(`Visual: ${imgDesc}.`);
  if (source) parts.push(`Source/Origin: ${source}.`);
  if (culturalRefs?.length) parts.push(`Cultural: ${culturalRefs.join('. ')}.`);
  if (meme.ocr_text?.trim()) parts.push(`Text in image: ${meme.ocr_text.trim()}.`);
  if (cap?.original) parts.push(`Caption: ${cap.original}.`);
  if (people?.length) parts.push(`People: ${people.join(', ')}.`);

  return parts.join(' ') || 'No contextual information available.';
}

function buildUseCaseText(meme: FullMemeRow): string {
  const parts: string[] = [];
  const meaning = safeParse(meme.meaning);
  const qe = safeParse(meme.query_examples);
  const tags = safeParse(meme.tags);
  const emotion = safeParse(meme.emotion) as string[] | null;
  const intent = safeParse(meme.intent) as string[] | null;
  const regions = safeParse(meme.regions) as string[] | null;

  if (meaning?.english) parts.push(`Meaning (English): ${meaning.english}.`);
  if (meaning?.hindi) parts.push(`Meaning (Hindi): ${meaning.hindi}.`);
  if (meaning?.hinglish) parts.push(`Meaning (Hinglish): ${meaning.hinglish}.`);
  if (meaning?.tamil) parts.push(`Meaning (Tamil): ${meaning.tamil}.`);
  if (meaning?.telugu) parts.push(`Meaning (Telugu): ${meaning.telugu}.`);

  const allQueries = [
    ...(qe?.english ?? []),
    ...(qe?.hinglish ?? []),
    ...(qe?.hindi ?? []),
    ...(qe?.tamil ?? []),
    ...(qe?.telugu ?? []),
  ].join(', ');
  if (allQueries) parts.push(`When to use: ${allQueries}.`);

  const allTags = [
    ...(tags?.english ?? []),
    ...(tags?.hinglish ?? []),
    ...(tags?.hindi ?? []),
    ...(tags?.tamil ?? []),
    ...(tags?.telugu ?? []),
  ].join(', ');
  if (allTags) parts.push(`Tags: ${allTags}.`);

  if (emotion?.length) parts.push(`Emotion: ${emotion.join(', ')}.`);
  if (intent?.length) parts.push(`Intent: ${intent.join(', ')}.`);
  if (regions?.length) parts.push(`Region: ${regions.join(', ')}.`);

  return parts.join(' ') || meme.multilingual_embedding_text;
}

async function embedAndInsert(
  memeId: string,
  text: string,
  table: 'embeddings' | 'embeddings_people' | 'embeddings_context' | 'embeddings_use_case'
) {
  const result = await embed({ model: embeddingModel, value: text });
  await db.execute({
    sql: `INSERT OR REPLACE INTO ${table} (meme_id, embedding, model) VALUES (?, vector32(?), ?)`,
    args: [memeId, JSON.stringify(Array.from(result.embedding)), EMBED_MODEL_ID],
  });
}

export async function embedMemes(batchSize = 5) {
  const { rows } = await db.execute(`
    SELECT m.id, m.multilingual_embedding_text,
           m.people, m.source, m.cultural_references, m.scene_description,
           m.ocr_text, m.image_description, m.caption, m.meaning,
           m.tags, m.query_examples, m.emotion, m.intent, m.regions
    FROM memes m
    WHERE m.id NOT IN (SELECT meme_id FROM embeddings)
       OR m.id NOT IN (SELECT meme_id FROM embeddings_people)
       OR m.id NOT IN (SELECT meme_id FROM embeddings_context)
       OR m.id NOT IN (SELECT meme_id FROM embeddings_use_case)
  `);
  const memes = rows as unknown as FullMemeRow[];

  console.log(`Found ${memes.length} memes needing embeddings`);
  if (memes.length === 0) {
    console.log("Nothing to embed.");
    return { embedded: 0 };
  }

  // Check which tables each meme is missing from
  const { rows: existingMain } = await db.execute(`SELECT meme_id FROM embeddings`);
  const { rows: existingPeople } = await db.execute(`SELECT meme_id FROM embeddings_people`);
  const { rows: existingContext } = await db.execute(`SELECT meme_id FROM embeddings_context`);
  const { rows: existingUseCase } = await db.execute(`SELECT meme_id FROM embeddings_use_case`);

  const hasMain = new Set((existingMain as any[]).map(r => r.meme_id as string));
  const hasPeople = new Set((existingPeople as any[]).map(r => r.meme_id as string));
  const hasContext = new Set((existingContext as any[]).map(r => r.meme_id as string));
  const hasUseCase = new Set((existingUseCase as any[]).map(r => r.meme_id as string));

  let embedded = 0;

  for (let i = 0; i < memes.length; i += batchSize) {
    const batch = memes.slice(i, i + batchSize);

    await Promise.all(batch.map(async (meme) => {
      const tasks: Promise<void>[] = [];

      if (!hasMain.has(meme.id)) {
        tasks.push(embedAndInsert(meme.id, meme.multilingual_embedding_text, 'embeddings'));
      }
      if (!hasPeople.has(meme.id)) {
        tasks.push(embedAndInsert(meme.id, buildPeopleText(meme), 'embeddings_people'));
      }
      if (!hasContext.has(meme.id)) {
        tasks.push(embedAndInsert(meme.id, buildContextText(meme), 'embeddings_context'));
      }
      if (!hasUseCase.has(meme.id)) {
        tasks.push(embedAndInsert(meme.id, buildUseCaseText(meme), 'embeddings_use_case'));
      }

      if (tasks.length > 0) {
        await Promise.all(tasks);
        embedded++;
      }
    }));

    console.log(`Embedded batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(memes.length / batchSize)}`);
    // Small delay to avoid rate limiting
    if (i + batchSize < memes.length) await new Promise(r => setTimeout(r, 200));
  }

  console.log("Done!");
  return { embedded };
}

function cachePathForLabels(labelsPath: string): string {
  return `${resolve(labelsPath)}.embeddings.json`;
}

export async function buildLabelsEmbeddingCache(labelsPath: string, batchSize = 10) {
  const abs = resolve(labelsPath);
  const file = Bun.file(abs);
  if (!(await file.exists())) {
    throw new Error(`Labels file not found: ${abs}`);
  }

  const labels = JSON.parse(await file.text()) as LabelRow[];
  if (!Array.isArray(labels)) {
    throw new Error(`Expected ${abs} to be a JSON array`);
  }

  const entries: { id: string; embedding: number[] }[] = [];

  for (let i = 0; i < labels.length; i += batchSize) {
    const batch = labels.slice(i, i + batchSize);
    const results = await Promise.all(
      batch.map(async (row) => {
        const text = row.multilingual_embedding_text?.trim();
        if (!text) throw new Error(`Missing multilingual_embedding_text for id ${row.id}`);
        const result = await embed({ model: embeddingModel, value: text });
        return { id: row.id, embedding: [...result.embedding] };
      })
    );
    entries.push(...results);
    console.log(`Labels embedded ${Math.min(i + batchSize, labels.length)}/${labels.length}`);
  }

  const payload: LabelCacheFile = {
    model: EMBED_MODEL_ID,
    built_at: new Date().toISOString(),
    entries,
  };

  const outPath = cachePathForLabels(abs);
  await Bun.write(outPath, JSON.stringify(payload));
  console.log(`Wrote ${entries.length} vectors to ${outPath}`);
  return { path: outPath, count: entries.length };
}

export type LabelsQueryHit = {
  id: string;
  similarity: number;
  image_path?: string;
  caption_original?: string;
};

export async function queryLabelsJson(
  labelsPath: string,
  query: string,
  topK = 5
): Promise<LabelsQueryHit[]> {
  const abs = resolve(labelsPath);
  const cacheFile = Bun.file(cachePathForLabels(abs));
  if (!(await cacheFile.exists())) {
    throw new Error(
      `No embedding cache for ${abs}. Run:\n  bun run src/embed.ts --labels ${labelsPath} build`
    );
  }

  const cache = JSON.parse(await cacheFile.text()) as LabelCacheFile;
  const labelsFile = Bun.file(abs);
  const labels = JSON.parse(await labelsFile.text()) as LabelRow[];
  const byId = new Map(labels.map((r) => [r.id, r]));

  const q = query.trim();
  if (!q) throw new Error("Query text is empty");

  const { embedding: queryVecRaw } = await embed({ model: embeddingModel, value: q });
  const queryVec = new Float32Array(queryVecRaw);

  const scored: LabelsQueryHit[] = [];
  for (const { id, embedding } of cache.entries) {
    const row = byId.get(id);
    const sim = cosineSimilarity(queryVec, new Float32Array(embedding));
    scored.push({ id, similarity: sim, image_path: row?.image_path, caption_original: row?.caption?.original });
  }

  scored.sort((a, b) => b.similarity - a.similarity);
  return scored.slice(0, topK);
}

function parseArgv(argv: string[]) {
  let labelsPath: string | null = null;
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--labels" && argv[i + 1]) {
      labelsPath = argv[++i]!;
    } else {
      rest.push(a);
    }
  }
  return { labelsPath, rest };
}

if (import.meta.main) {
  const { labelsPath, rest } = parseArgv(process.argv.slice(2));

  if (labelsPath) {
    const abs = resolve(labelsPath);
    if (rest[0] === "build") {
      await buildLabelsEmbeddingCache(abs, 10);
    } else {
      const queryText = rest.join(" ").trim();
      if (!queryText) {
        console.error('Usage:\n  bun run src/embed.ts --labels <labels.json> build\n  bun run src/embed.ts --labels <labels.json> "your search text"');
        process.exit(1);
      }
      const hits = await queryLabelsJson(abs, queryText, 5);
      console.log(JSON.stringify(hits, null, 2));
    }
  } else {
    await embedMemes(5);
  }
}
