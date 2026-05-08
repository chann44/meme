import { Hono } from "hono";
import { embed } from "ai";
import { VectorStore } from "./vector-store.ts";
import { z } from "zod";
import { labelFolder } from "./label.ts";
import { embedMemes } from "./embed.ts";
import { embeddingModel } from "./ai.ts";
import db from "./db/index.ts";

const app = new Hono();
const vectorStore = new VectorStore("memes.db");

const SearchRequest = z.object({
  query: z.string().min(1),
  language: z.string().optional(),
  region: z.string().optional(),
  emotion: z.string().optional(),
  limit: z.number().min(1).max(50).default(10),
});

app.post("/search", async (c) => {
  try {
    const body = await c.req.json();
    const { query, language, region, emotion, limit } = SearchRequest.parse(body);

    console.time("embed");
    const result = await embed({
      model: embeddingModel,
      value: query,
    });
    const queryEmbedding = new Float32Array(result.embedding);
    console.timeEnd("embed");

    console.time("vector-search");
    const rawResults = vectorStore.search(queryEmbedding, {
      language,
      region,
      emotion,
      limit: limit * 2,
      minSimilarity: 0.3,
    });
    console.timeEnd("vector-search");

    console.time("rank");
    const rankedResults = vectorStore.rank(rawResults, { language, region });
    console.timeEnd("rank");

    const memes = rankedResults.slice(0, limit).map((r) => ({
      id: r.meme_id,
      image_path: r.image_path,
      caption: r.caption,
      primary_language: r.primary_language,
      emotion: r.emotion,
      regions: r.regions,
      intent: r.intent,
      similarity: r.similarity,
      score: r.score,
    }));

    return c.json({
      memes,
      query,
      total_results: rankedResults.length,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: message }, 400);
  }
});

app.post("/batch-search", async (c) => {
  try {
    const { queries } = await c.req.json();

    if (!Array.isArray(queries) || queries.length === 0) {
      return c.json({ error: "queries must be a non-empty array" }, 400);
    }

    const results = await Promise.all(
      queries.map(async ({ query, language, region, limit = 5 }: { query: string; language?: string; region?: string; limit?: number }) => {
        const result = await embed({
          model: embeddingModel,
          value: query,
        });

        const queryEmbedding = new Float32Array(result.embedding);
        const rawResults = vectorStore.search(queryEmbedding, {
          language,
          region,
          limit: limit * 2,
        });

        const ranked = vectorStore.rank(rawResults, { language, region });

        return {
          query,
          memes: ranked.slice(0, limit).map((r) => ({
            id: r.meme_id,
            image_path: r.image_path,
            caption: r.caption,
            similarity: r.similarity,
          })),
        };
      })
    );

    return c.json({ results });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: message }, 400);
  }
});

app.get("/stats", (c) => {
  const vectorStats = vectorStore.getStats();
  const totalMemes = db.prepare("SELECT COUNT(*) as count FROM memes").get() as { count: number };
  const totalEmbedded = db.prepare("SELECT COUNT(*) as count FROM embeddings").get() as { count: number };

  return c.json({
    ...vectorStats,
    total_memes: totalMemes.count,
    total_labeled: totalEmbedded.count,
  });
});

app.post("/reload", (c) => {
  vectorStore.reload();
  return c.json({ status: "reloaded", stats: vectorStore.getStats() });
});

app.post("/label", async (c) => {
  const { folder = "./memes" } = await c.req.json().catch(() => ({}) as Record<string, unknown>);

  try {
    const result = await labelFolder(folder as string);
    return c.json({ success: true, ...result });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ success: false, error: message }, 500);
  }
});

app.post("/embed", async (c) => {
  const { batchSize = 10 } = await c.req.json().catch(() => ({}) as Record<string, unknown>);

  try {
    const result = await embedMemes(batchSize as number);
    vectorStore.reload();
    return c.json({ success: true, ...result });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ success: false, error: message }, 500);
  }
});

app.post("/pipeline", async (c) => {
  const { folder = "./memes", labelConcurrency = 4, embedBatchSize = 10 } = await c.req.json().catch(() => ({}) as Record<string, unknown>);

  try {
    console.log("=== Starting pipeline: label → embed ===");

    console.log("\nStep 1: Labeling memes...");
    const labelResult = await labelFolder(folder as string);
    console.log(`Labeled ${labelResult.succeeded}/${labelResult.total} memes`);

    console.log("\nStep 2: Generating embeddings...");
    const embedResult = await embedMemes(embedBatchSize as number);
    console.log(`Embedded ${embedResult.embedded} memes`);

    vectorStore.reload();

    return c.json({
      success: true,
      label: labelResult,
      embed: embedResult,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ success: false, error: message }, 500);
  }
});

export default app;