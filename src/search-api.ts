import { Hono } from "hono";
import { embed } from "ai";
import { VectorStore } from "./vector-store.ts";
import { z } from "zod";
import { labelFolder } from "./label.ts";
import { embedMemes } from "./embed.ts";
import { embeddingModel } from "./ai.ts";
import { analyzeQuery } from "./query-analysis.ts";
import db from "./db/index.ts";
import {
  createPerfRecorder,
  getSearchPerfLogDir,
  summarizeSearchPerf,
  writeSearchPerfJson,
} from "./search-perf-log.ts";

const ANALYZE_QUERY_TIMEOUT_MS = 14_000;

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let to: ReturnType<typeof setTimeout>;
  const t = new Promise<never>((_, rej) => {
    to = setTimeout(() => rej(new Error(`${label}: timeout after ${ms}ms`)), ms);
  });
  return Promise.race([p, t]).finally(() => clearTimeout(to));
}

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
  /** Fast: weighted cosine across 4 aspect vectors (same ANN passes as default). Ignored when rerank:true. */
  facet_rescore: z.boolean().default(false),
  /** Single cheap LLM call for query intents/emotions/people; rank() overlaps with meme metadata. */
  analyze_query: z.boolean().default(false),
  /** LLM rerank (~15 Gemini calls). Default false — use for experiments only. */
  rerank: z.boolean().default(false),
});

app.post("/search", async (c) => {
  const requestWallT0 = performance.now();
  const perf = createPerfRecorder();
  let queryPreview = "";

  try {
    const { query, language, region, emotion, limit, rerank, facet_rescore, analyze_query } =
      await perf.timeAsync("searchApi", "parse_body", async () => {
        const body = await c.req.json();
        return SearchRequest.parse(body);
      });
    queryPreview = query.slice(0, 200);

    const embedPromise = perf.timeAsync("searchApi", "embed_query", async () =>
      embed({
        model: embeddingModel,
        value: query,
      })
    );
    const analyzePromise = analyze_query
      ? perf.timeAsync("searchApi", "query_signals_llm", async () => {
          try {
            return await withTimeout(
              analyzeQuery(query),
              ANALYZE_QUERY_TIMEOUT_MS,
              "analyzeQuery"
            );
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            console.error("[search] analyze_query failed (continuing without signal boost):", msg);
            return null;
          }
        })
      : Promise.resolve(null);
    const [embedResult, queryAnalysis] = await Promise.all([embedPromise, analyzePromise]);
    const queryEmbedding = new Float32Array(embedResult.embedding);

    const detectedPeople = queryAnalysis?.detected_people ?? [];
    const querySignals = queryAnalysis ?? undefined;

    const fusedResults = await perf.timeAsync("searchApi", "fused_search", async () =>
      vectorStore.fusedSearch(
        queryEmbedding,
        query,
        detectedPeople,
        {
          language,
          region,
          emotion,
          limit: limit * 3,
          minSimilarity: 0.30,
          facetRescore: rerank ? false : facet_rescore,
        },
        perf
      )
    );

    let finalResults = fusedResults;
    if (rerank && fusedResults.length > 0) {
      finalResults = await perf.timeAsync("searchApi", "cross_encode", async () =>
        vectorStore.crossEncode(fusedResults, query, Math.min(15, fusedResults.length), perf)
      );
    }

    const ranked = perf.timeSync("searchApi", "rank", () =>
      vectorStore.rank(finalResults, { language, region, querySignals })
    );

    const logLabel = (() => {
      if (rerank) return "rerank=ON(llm)";
      const bits: string[] = [];
      if (facet_rescore) bits.push("facet_rescore=ON");
      if (analyze_query) bits.push("analyze_query=ON(signals)");
      return bits.length ? bits.join("+") : "default(rrf)";
    })();
    const memes = perf.timeSync("searchApi", "build_response", () =>
      ranked.slice(0, limit).map((r) => {
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
          facet_blend: r.facet_blend,
          facet_sims: r.facet_sims,
          score: r.score,
          query_signal_boost: r.query_signal_boost,
        };
      })
    );

    console.log(
      `[search] ${logLabel} "${query}" → ${memes.length} results (from ${fusedResults.length} fused)`
    );
    memes.forEach((m, i) =>
      console.log(
        `  [${i + 1}] ${m.image_path} | score=${m.score?.toFixed(1)} rrf=${m.rrf_score?.toFixed(4)} facet=${m.facet_blend != null ? m.facet_blend.toFixed(3) : "—"} cross=${m.cross_score != null ? m.cross_score.toFixed(1) : "—"} | ${String(m.caption).slice(0, 60)}`
      )
    );

    const requestWallMs = performance.now() - requestWallT0;
    const records = perf.getRecords();
    const cumulativeSequential = (() => {
      let cum = 0;
      return records
        .filter((r) => r.scope === "searchApi")
        .map((r) => {
          cum += r.ms;
          return { phase: r.phase, ms: r.ms, cumulative_after_ms: cum };
        });
    })();

    try {
      const logPath = await writeSearchPerfJson({
        at: new Date().toISOString(),
        route: "POST /search",
        perf_log_directory: getSearchPerfLogDir(),
        query_preview: queryPreview,
        limit,
        rerank,
        facet_rescore: rerank ? false : facet_rescore,
        analyze_query,
        request_wall_ms: requestWallMs,
        cumulative_sequential_search_api: cumulativeSequential,
        records,
        summary: summarizeSearchPerf(records, requestWallMs),
      });
      console.log(`[perf] wrote ${logPath}`);
      c.header("X-Meme-Perf-Log", logPath);
    } catch (logErr: unknown) {
      const logMsg = logErr instanceof Error ? logErr.message : String(logErr);
      console.error("[perf] failed to write perf log:", logMsg);
      console.error("[perf] expected directory:", getSearchPerfLogDir());
      c.header("X-Meme-Perf-Log-Error", logMsg.slice(0, 200));
    }

    return c.json({
      memes,
      query,
      rerank,
      facet_rescore: rerank ? false : facet_rescore,
      analyze_query,
      total_results: ranked.length,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    const requestWallMs = performance.now() - requestWallT0;
    const records = perf.getRecords();
    let cum = 0;
    const cumulativeSequential = records
      .filter((r) => r.scope === "searchApi")
      .map((r) => {
        cum += r.ms;
        return { phase: r.phase, ms: r.ms, cumulative_after_ms: cum };
      });
    try {
      const logPath = await writeSearchPerfJson({
        at: new Date().toISOString(),
        route: "POST /search",
        perf_log_directory: getSearchPerfLogDir(),
        error: message,
        query_preview: queryPreview,
        request_wall_ms: requestWallMs,
        cumulative_sequential_search_api: cumulativeSequential,
        records,
        summary: summarizeSearchPerf(records, requestWallMs),
      });
      console.log(`[perf] wrote ${logPath} (handler error)`);
    } catch (logErr: unknown) {
      const logMsg = logErr instanceof Error ? logErr.message : String(logErr);
      console.error("[perf] failed to write perf log (handler error path):", logMsg);
      console.error("[perf] expected directory:", getSearchPerfLogDir());
    }
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
