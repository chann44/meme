import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, test } from "bun:test";
import { getGoogleApiKey } from "./ai.ts";
import { queryLabelsJson, type LabelsQueryHit } from "./embed.ts";

/**
 * These tests use **only** `queryLabelsJson`: Gemini embedding for the query +
 * cosine similarity against `labels.json.embeddings.json`. There is no keyword,
 * full-text, or database fallback anywhere in that path.
 *
 * Golden + cross-lingual cases are derived from the **current** `labels.json`
 * (e.g. your `memes/0.jpg` … `memes/9.jpg` export), not hardcoded meme ids.
 *
 * Set `EMBED_TEST_VERBOSE=0` to silence per-query logs (e.g. CI).
 */
const REPO_ROOT = join(import.meta.dir, "..");
const LABELS_JSON = join(REPO_ROOT, "labels.json");
const CACHE_PATH = `${resolve(LABELS_JSON)}.embeddings.json`;

const TOP_RECALL = 10;
const TOP_CLUSTER = 8;
const CONCURRENCY = 8;

type LabelRow = {
  id: string;
  image_path?: string;
  query_examples?: Partial<Record<"english" | "hindi" | "hinglish", string[]>>;
};

const labels = JSON.parse(readFileSync(LABELS_JSON, "utf8")) as LabelRow[];

const LANGS = ["english", "hindi", "hinglish"] as const;

function buildGoldenCases(): { id: string; lang: (typeof LANGS)[number]; query: string }[] {
  const cases: { id: string; lang: (typeof LANGS)[number]; query: string }[] = [];
  for (const row of labels) {
    const qe = row.query_examples;
    if (!qe) continue;
    for (const lang of LANGS) {
      const arr = qe[lang];
      if (!Array.isArray(arr)) continue;
      for (const q of arr) {
        const s = String(q).trim();
        if (s) cases.push({ id: row.id, lang, query: s });
      }
    }
  }
  return cases;
}

/** One first query per language — only rows that have EN + HI + Hinglish examples (dataset-driven, no hardcoded meme ids). */
function buildCrossLingualClusters(rows: LabelRow[]): {
  id: string;
  theme: string;
  queries: { english: string; hindi: string; hinglish: string };
}[] {
  const out: {
    id: string;
    theme: string;
    queries: { english: string; hindi: string; hinglish: string };
  }[] = [];
  for (const row of rows) {
    const qe = row.query_examples;
    if (!qe) continue;
    const en = qe.english?.map((q) => String(q).trim()).find((s) => s.length > 0);
    const hi = qe.hindi?.map((q) => String(q).trim()).find((s) => s.length > 0);
    const hg = qe.hinglish?.map((q) => String(q).trim()).find((s) => s.length > 0);
    if (!en || !hi || !hg) continue;
    out.push({
      id: row.id,
      theme: row.image_path ?? row.id,
      queries: { english: en, hindi: hi, hinglish: hg },
    });
  }
  return out;
}

const hasGemini = !!getGoogleApiKey();
const hasCache = existsSync(CACHE_PATH);
const runLiveEmbeddingTests = hasGemini && hasCache;
const goldenCases = buildGoldenCases();
const crossLingualClusters = buildCrossLingualClusters(labels);

const logVerbose = process.env.EMBED_TEST_VERBOSE !== "0";

function logEmbeddingSearch(
  suite: string,
  query: string,
  hits: LabelsQueryHit[],
  meta?: Record<string, string | undefined>
) {
  if (!logVerbose) return;
  console.log(`\n━━ ${suite} ━━`);
  console.log("query:", query);
  if (meta && Object.keys(meta).length) console.log("meta:", meta);
  for (let i = 0; i < hits.length; i++) {
    const h = hits[i]!;
    console.log(
      `  ${i + 1}. ${h.id}  sim=${h.similarity.toFixed(4)}  ${h.image_path ?? ""}  ${h.caption_original ?? ""}`
    );
  }
}

async function mapPool<T, R>(items: T[], concurrency: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += concurrency) {
    const chunk = items.slice(i, i + concurrency);
    out.push(...(await Promise.all(chunk.map(fn))));
  }
  return out;
}

test("labels.json loads with query_examples for multilingual recall", () => {
  expect(Array.isArray(labels)).toBe(true);
  expect(labels.length).toBeGreaterThan(0);
  expect(goldenCases.length).toBeGreaterThan(0);
});

describe.skipIf(!runLiveEmbeddingTests)("labels embedding stress (English / Hindi / Hinglish)", () => {
  for (const lang of LANGS) {
    const langCases = goldenCases.filter((c) => c.lang === lang);
    test(
      `golden recall: ${lang} query_examples → own meme in top ${TOP_RECALL} (${langCases.length} queries)`,
      async () => {
        const failures: string[] = [];
        for (const { id, query } of langCases) {
          const hits = await queryLabelsJson(LABELS_JSON, query, TOP_RECALL);
          const rank = hits.findIndex((h) => h.id === id);
          logEmbeddingSearch(`golden:${lang}`, query, hits, {
            expect_id: id,
            hit_rank: rank >= 0 ? String(rank + 1) : `not in top ${TOP_RECALL}`,
          });
          if (!hits.some((h) => h.id === id)) {
            failures.push(
              `${id} ← "${query.slice(0, 70)}${query.length > 70 ? "…" : ""}" | got: ${hits.map((h) => h.id).join(", ")}`
            );
          }
        }
        expect(failures).toEqual([]);
      },
      { timeout: 400_000 }
    );
  }

  test.skipIf(crossLingualClusters.length === 0)(
    `cross-lingual: first EN/HI/Hinglish query_examples per meme in top ${TOP_CLUSTER} (${crossLingualClusters.length} memes)`,
    async () => {
      for (const { id, theme, queries } of crossLingualClusters) {
        for (const [qlang, q] of Object.entries(queries)) {
          const hits = await queryLabelsJson(LABELS_JSON, q, TOP_CLUSTER);
          const rank = hits.findIndex((h) => h.id === id);
          logEmbeddingSearch(`cross-lingual:${theme}`, q, hits, {
            expect_id: id,
            query_lang: qlang,
            hit_rank: rank >= 0 ? String(rank + 1) : `not in top ${TOP_CLUSTER}`,
          });
          expect(hits.some((h) => h.id === id)).toBe(true);
        }
      }
    },
    { timeout: 300_000 }
  );

  test(
    `stress: batched parallel searches (${CONCURRENCY}-wide) over all golden queries`,
    async () => {
      const results = await mapPool(goldenCases, CONCURRENCY, async ({ id: goldenId, lang, query }) => {
        const hits = await queryLabelsJson(LABELS_JSON, query, 5);
        logEmbeddingSearch(`stress[parallel k=${CONCURRENCY}]`, query, hits, {
          golden_id: goldenId,
          golden_lang: lang,
        });
        expect(hits.length).toBe(5);
        for (const h of hits) {
          expect(h.similarity).toBeGreaterThanOrEqual(-1.01);
          expect(h.similarity).toBeLessThanOrEqual(1.01);
        }
        return hits;
      });
      expect(results.length).toBe(goldenCases.length);
    },
    { timeout: 400_000 }
  );
});
