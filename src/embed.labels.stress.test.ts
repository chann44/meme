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

const hasGemini = !!getGoogleApiKey();
const hasCache = existsSync(CACHE_PATH);
const runLiveEmbeddingTests = hasGemini && hasCache;
const goldenCases = buildGoldenCases();

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

/** Same meme, semantically aligned queries across EN / HI / Roman Hinglish (themes from labels.json). */
const CROSS_LINGUAL_CLUSTERS: {
  id: string;
  theme: string;
  queries: { english: string; hindi: string; hinglish: string };
}[] = [
  {
    id: "meme_1778322288650",
    theme: "exams, corona, plans before vs after",
    queries: {
      english:
        "Things were happy and optimistic until exams and coronavirus hit and everything became disappointing",
      hindi: "कोरोना के कारण पढ़ाई का मूड खराब होना",
      hinglish: "Jab sab set tha aur suddenly rules badal gaye",
    },
  },
  {
    id: "meme_1778332163900",
    theme: "Netflix / streaming — can't afford while friends hype shows",
    queries: {
      english: "My friends keep talking about the new Netflix series but I cannot afford a subscription",
      hindi:
        "जब आपके दोस्त नेटफ्लिक्स पर नए शो के बारे में बात कर रहे हैं लेकिन आप इसे वहन नहीं कर सकते",
      hinglish: "Jab dost Netflix pe naye show ki baat kar rahe hon aur aapko paisa na ho",
    },
  },
  {
    id: "meme_1778332094290",
    theme: "STEM / maths / science difficulty",
    queries: {
      english: "Maths physics chemistry syllabus feels impossible as a science student",
      hindi: "विज्ञान के विषय बहुत मुश्किल लग रहे हैं और परीक्षा की तैयारी मुश्किल है",
      hinglish: "Maths Science ke subjects kitne tough hain padhai mein stress",
    },
  },
  {
    id: "meme_1778332022271",
    theme: "low Instagram / social engagement",
    queries: {
      english: "when my Instagram post gets almost no likes and low engagement",
      hindi: "सोशल मीडिया पर मेरी पोस्ट को बहुत कम लाइक्स और एंगेजमेंट मिला",
      hinglish: "mere post pe sirf 3 likes aaye instagram pe",
    },
  },
  {
    id: "meme_1778331864323",
    theme: "Bollywood-style overreaction / dramatic insaan",
    queries: {
      english: "My dramatic reaction when someone shares my photo as a joke like a movie scene",
      hindi: "छोटी सी बात पर बहुत ज़्यादा नाटक और इमोशन दिखाना जैसे बॉलीवुड परफॉर्मेंस",
      hinglish: "main choti si baat par zyada overreact kar raha hun coke studio wali vibe",
    },
  },
];

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

  test(
    `cross-lingual themes: same meme in top ${TOP_CLUSTER} for EN, HI, Hinglish paraphrases`,
    async () => {
      for (const { id, theme, queries } of CROSS_LINGUAL_CLUSTERS) {
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
