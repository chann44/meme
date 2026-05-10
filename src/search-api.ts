import { Hono } from "hono";
import { embed } from "ai";
import { VectorStore } from "./vector-store.ts";
import { z } from "zod";
import { labelFolder } from "./label.ts";
import { embedMemes } from "./embed.ts";
import { embeddingModel } from "./ai.ts";
import db from "./db/index.ts";

const app = new Hono();
const vectorStore = new VectorStore();

app.get("/memes", (c) => {
  const allFiles = Array.from({ length: 200 }, (_, i) => `${i}.jpg`).filter((name) => {
    return Bun.file(`memes/${name}`).exists();
  });

  if (allFiles.length === 0) {
    return c.json({ error: "No memes found" }, 404);
  }

  const shuffled = allFiles.sort(() => Math.random() - 0.5);
  const selected = shuffled.slice(0, 4);

  const memes = selected.map((file) => ({
    id: file,
    image_path: file,
    image_url: `/memes/${file}`,
  }));

  return c.json({ memes });
});

app.use("/memes/*", async (c, next) => {
  const path = c.req.path.replace("/memes/", "");
  const file = Bun.file(`memes/${path}`);
  if (await file.exists()) {
    return new Response(file);
  }
  return c.json({ error: "File not found" }, 404);
});

const SearchRequest = z.object({
  query: z.string().min(1),
  language: z.string().optional(),
  region: z.string().optional(),
  emotion: z.string().optional(),
  limit: z.number().min(1).max(50).default(10),
  rerank: z.boolean().default(true),
});

app.post("/search", async (c) => {
  try {
    const body = await c.req.json();
    const { query, language, region, emotion, limit, rerank } = SearchRequest.parse(body);

    console.time("embed");
    const result = await embed({
      model: embeddingModel,
      value: query,
    });
    const queryEmbedding = new Float32Array(result.embedding);
    console.timeEnd("embed");

    console.time("fused-search");
    const fusedResults = await vectorStore.fusedSearch(
      queryEmbedding,
      query,
      [],
      {
        language,
        region,
        emotion,
        limit: limit * 3,
        minSimilarity: 0.30,
      }
    );
    console.timeEnd("fused-search");

    let finalResults = fusedResults;

    if (rerank && fusedResults.length > 0) {
      console.time("cross-encode");
      finalResults = await vectorStore.crossEncode(
        fusedResults,
        query,
        Math.min(15, fusedResults.length)
      );
      console.timeEnd("cross-encode");
    }

    const ranked = vectorStore.rank(finalResults, { language, region });

    const memes = ranked.slice(0, limit).map((r) => {
      const cap = r.caption as { original?: string; translations?: Record<string, string> } | null;
      const caption = cap?.translations?.english ?? cap?.original ?? "";
      return {
        id: r.meme_id,
        image_path: r.image_path,
        caption,
        primary_language: r.primary_language,
        emotion: r.emotion,
        regions: r.regions,
        intent: r.intent,
        people: r.people,
        source: r.source,
        similarity: r.similarity,
        rrf_score: r.rrf_score,
        cross_score: r.cross_score,
        score: r.score,
      };
    });

    console.log(`[search] "${query}" → ${memes.length} results (fused: ${fusedResults.length}, after rerank: ${finalResults.length})`);
    memes.forEach((m, i) =>
      console.log(`  [${i + 1}] ${m.image_path} | score=${m.score?.toFixed(1)} cross=${m.cross_score?.toFixed(1)} | ${String(m.caption).slice(0, 60)}`)
    );

    return c.json({
      memes,
      query,
      total_results: ranked.length,
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
        const rawResults = await vectorStore.search(queryEmbedding, {
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

app.get("/stats", async (c) => {
  const vectorStats = await vectorStore.getStats();
  const memesRes = await db.execute("SELECT COUNT(*) as count FROM memes");
  const embedRes = await db.execute("SELECT COUNT(*) as count FROM embeddings");
  const peopleRes = await db.execute("SELECT COUNT(DISTINCT meme_id) as count FROM meme_people");
  const ftsRes = await db.execute("SELECT COUNT(*) as count FROM memes_fts").catch(() => ({ rows: [{ count: 0 }] }));

  const totalMemes = Number((memesRes.rows[0] as any).count);
  const totalEmbedded = Number((embedRes.rows[0] as any).count);
  const memesWithPeople = Number((peopleRes.rows[0] as any).count);
  const ftsDocs = Number((ftsRes.rows[0] as any).count);

  return c.json({
    ...vectorStats,
    total_memes: totalMemes,
    total_labeled: totalEmbedded,
    memes_with_people_index: memesWithPeople,
    fts_documents: ftsDocs,
  });
});

app.post("/reload", async (c) => {
  return c.json({ status: "reloaded", stats: await vectorStore.getStats() });
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
  const { batchSize = 5 } = await c.req.json().catch(() => ({}) as Record<string, unknown>);
  try {
    const result = await embedMemes(batchSize as number);
    return c.json({ success: true, ...result });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ success: false, error: message }, 500);
  }
});

app.post("/pipeline", async (c) => {
  const { folder = "./memes", embedBatchSize = 5 } = await c.req.json().catch(() => ({}) as Record<string, unknown>);

  try {
    console.log("=== Starting pipeline: label → embed ===");

    console.log("\nStep 1: Labeling memes...");
    const labelResult = await labelFolder(folder as string);
    console.log(`Labeled ${labelResult.succeeded}/${labelResult.total} memes`);

    console.log("\nStep 2: Generating embeddings (4 aspects per meme)...");
    const embedResult = await embedMemes(embedBatchSize as number);
    console.log(`Embedded ${embedResult.embedded} memes`);

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
