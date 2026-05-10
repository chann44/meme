import { embed } from "ai";
import { resolve } from "node:path";
import db from "./db/index.ts";
import { embeddingModel } from "./ai.ts";

const EMBED_MODEL_ID = "gemini-embedding-2";

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

function cachePathForLabels(labelsPath: string): string {
  return `${resolve(labelsPath)}.embeddings.json`;
}

export async function embedMemes(batchSize = 10) {
  const { rows } = await db.execute(
    `SELECT id, multilingual_embedding_text FROM memes WHERE id NOT IN (SELECT meme_id FROM embeddings)`
  );
  const memes = rows as unknown as {
    id: string;
    multilingual_embedding_text: string;
  }[];

  console.log(`Found ${memes.length} memes to embed`);

  if (memes.length === 0) {
    console.log("Nothing to embed.");
    return { embedded: 0 };
  }

  for (let i = 0; i < memes.length; i += batchSize) {
    const batch = memes.slice(i, i + batchSize);

    const results = await Promise.all(
      batch.map(async (meme) => {
        const result = await embed({
          model: embeddingModel,
          value: meme.multilingual_embedding_text,
        });
        return { memeId: meme.id, embedding: result.embedding };
      })
    );

    await db.batch(
      results.map(({ memeId, embedding }) => ({
        sql: `INSERT INTO embeddings (meme_id, embedding, model) VALUES (?, vector32(?), ?)`,
        args: [memeId, JSON.stringify(Array.from(embedding)), EMBED_MODEL_ID],
      })),
      "write"
    );

    console.log(`Embedded batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(memes.length / batchSize)}`);
  }

  console.log("Done!");
  return { embedded: memes.length };
}

/** Embed every row in `labelsPath` (JSON array) and write `${labelsPath}.embeddings.json`. */
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
        if (!text) {
          throw new Error(`Missing multilingual_embedding_text for id ${row.id}`);
        }
        const result = await embed({
          model: embeddingModel,
          value: text,
        });
        return { id: row.id, embedding: [...result.embedding] };
      })
    );
    entries.push(...results);
    console.log(
      `Labels embedded ${Math.min(i + batchSize, labels.length)}/${labels.length}`
    );
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

/**
 * Pure embedding retrieval: embed `query` with Gemini, rank cached label vectors by cosine
 * similarity. No lexical/BM25/SQL fallback.
 */
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
  if (cache.model !== EMBED_MODEL_ID) {
    console.warn(
      `Cache model "${cache.model}" differs from ${EMBED_MODEL_ID}; rebuild recommended.`
    );
  }

  const labelsFile = Bun.file(abs);
  const labels = JSON.parse(await labelsFile.text()) as LabelRow[];
  const byId = new Map(labels.map((r) => [r.id, r]));

  const q = query.trim();
  if (!q) {
    throw new Error("Query text is empty");
  }

  const { embedding: queryVecRaw } = await embed({
    model: embeddingModel,
    value: q,
  });
  const queryVec = new Float32Array(queryVecRaw);

  const scored: LabelsQueryHit[] = [];
  for (const { id, embedding } of cache.entries) {
    const row = byId.get(id);
    const sim = cosineSimilarity(queryVec, new Float32Array(embedding));
    scored.push({
      id,
      similarity: sim,
      image_path: row?.image_path,
      caption_original: row?.caption?.original,
    });
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
        console.error(
          'Usage:\n  bun run src/embed.ts --labels <labels.json> build\n  bun run src/embed.ts --labels <labels.json> "your search text"'
        );
        process.exit(1);
      }
      const hits = await queryLabelsJson(abs, queryText, 5);
      console.log(JSON.stringify(hits, null, 2));
    }
  } else {
    await embedMemes(10);
  }
}
