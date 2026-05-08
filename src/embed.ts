import { embed } from "ai";
import db from "./db/index.ts";
import { embeddingModel } from "./ai.ts";

export async function embedMemes(batchSize = 10) {
  const memes = db
    .prepare(
      `SELECT id, multilingual_embedding_text FROM memes WHERE id NOT IN (SELECT meme_id FROM embeddings)`
    )
    .all() as { id: string; multilingual_embedding_text: string }[];

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

    const insertStmt = db.prepare(
      `INSERT INTO embeddings (meme_id, embedding, model) VALUES (?, ?, ?)`
    );

    const transaction = db.transaction(() => {
      for (const { memeId, embedding } of results) {
        const embeddingBlob = Buffer.from(new Float32Array(embedding).buffer);
        insertStmt.run(memeId, embeddingBlob, "gemini-embedding-2");
      }
    });

    transaction();

    console.log(`Embedded batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(memes.length / batchSize)}`);
  }

  console.log("Done!");
  return { embedded: memes.length };
}

if (import.meta.main) {
  embedMemes(10);
}