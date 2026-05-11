import { generateObject } from "ai";
import { z } from "zod";
import type { Client } from "@libsql/client";
import db from "./db/index.ts";
import { analysisChatModel } from "./ai.ts";
import { CROSS_ENCODER_SYSTEM_PROMPT } from "./prompts.ts";
import type { PerfRecorderLike } from "./search-perf-log.ts";
import type { QueryAnalysis } from "./query-analysis.ts";

export interface SearchResult {
  meme_id: string;
  similarity: number;
  image_path: string;
  caption: Record<string, unknown>;
  primary_language: string;
  supported_languages: string[];
  emotion: string[];
  regions: string[];
  intent: string;
  popularity_score: number;
  people: string[];
  source: string;
  scene_description: string;
  meaning: Record<string, unknown>;
  score?: number;
  rrf_score?: number;
  cross_score?: number;
  /** Weighted cosine blend across aspect embeddings (~0–1). Set when facet rescore enabled. */
  facet_blend?: number;
  facet_sims?: FacetSimilarities;
  /** Set when POST /search uses analyze_query (metadata overlap boost). */
  query_signal_boost?: number;
}

/** Per-branch cosine similarities (missing branch = 0). */
export interface FacetSimilarities {
  main: number;
  people: number;
  context: number;
  use_case: number;
}

interface VectorRow {
  meme_id: string;
  image_path: string;
  primary_language: string;
  supported_languages: string;
  caption: string;
  emotion: string;
  regions: string;
  intent: string;
  popularity_score: number | null;
  people: string | null;
  source: string | null;
  scene_description: string | null;
  meaning: string | null;
  distance: number;
}

export interface SearchOptions {
  language?: string;
  region?: string;
  emotion?: string;
  limit?: number;
  minSimilarity?: number;
  /** Merge 4-vector cosine similarities into facet_blend (~no extra latency vs plain fused). */
  facetRescore?: boolean;
  /** Structured query understanding — rank() adds overlaps with meme intent/emotion/region/people. */
  querySignals?: QueryAnalysis;
}

const INTENT_MATCH_PT = 18;
const EMOTION_MATCH_PT = 14;
const REGION_MATCH_PT = 10;
const PEOPLE_MATCH_PT = 12;
/** Cap so signals never drown retrieval entirely. */
const QUERY_SIGNAL_BOOST_CAP = 48;

/** Normalize sloppy DB intent strings (`exam_stress` or `["show_disappointment,exam_stress"]`). */
export function parseMemeIntentTokens(rawIntent: string): string[] {
  const s = (rawIntent ?? "").trim();
  if (!s) return [];
  try {
    const j = JSON.parse(s);
    if (Array.isArray(j)) return j.flatMap(parseMemeIntentTokens);
    if (typeof j === "string") return parseMemeIntentTokens(j);
  } catch {}
  const flat = s
    .replace(/^\[+|\]+$/g, "")
    .replace(/"/g, "")
    .split(/[,|;]/)
    .map((t) =>
      t
        .trim()
        .toLowerCase()
        .replace(/^["'+]+|["']+$/g, "")
    )
    .filter(Boolean);
  return [...new Set(flat)];
}

function memeIntentSlugSet(intentField: string): Set<string> {
  return new Set(parseMemeIntentTokens(intentField));
}

function intersectSize<T>(as: Iterable<T>, bs: Iterable<T>): number {
  const b = new Set(bs);
  let n = 0;
  for (const x of as) if (b.has(x)) n++;
  return n;
}

/** Generic overlap boost: intents, emotions, regions, substring people (no keyword special-cases). */
export function computeQuerySignalBoost(result: SearchResult, signals: QueryAnalysis): number {
  let b = 0;

  const memeIntents = memeIntentSlugSet(result.intent);
  const qIntents = new Set(signals.intents.map((i) => i.toLowerCase()));
  const ih = intersectSize(qIntents, memeIntents);
  if (ih > 0) b += INTENT_MATCH_PT * Math.min(ih, 2);

  const memeEmotions = new Set(result.emotion.map((e) => String(e).toLowerCase()));
  const qEmotions = new Set(signals.emotions.map((e) => e.toLowerCase()));
  const eh = intersectSize(qEmotions, memeEmotions);
  if (eh > 0) b += EMOTION_MATCH_PT * Math.min(eh, 2);

  const memeRegions = new Set(result.regions.map((r) => String(r).toLowerCase()));
  const qRegions = new Set(signals.regions.map((r) => r.toLowerCase()));
  const rh = intersectSize(qRegions, memeRegions);
  if (rh > 0) b += REGION_MATCH_PT * rh;

  if (signals.detected_people.length > 0 && result.people.length > 0) {
    const hay = result.people.join(" ").toLowerCase();
    for (const p of signals.detected_people) {
      const normalized = p
        .toLowerCase()
        .replace(/\s*\([^)]*\)/g, "")
        .trim()
        .split(/\s+/)
        .find((tok) => tok.length >= 3);
      if (!normalized) continue;
      if (hay.includes(normalized) || normalized.split(/\s/).some((w) => w.length >= 3 && hay.includes(w))) {
        b += PEOPLE_MATCH_PT;
      }
      if (b >= QUERY_SIGNAL_BOOST_CAP) break;
    }
  }

  return Math.min(QUERY_SIGNAL_BOOST_CAP, b);
}
const FACET_W = { main: 0.35, people: 0.2, context: 0.25, use_case: 0.2 } as const;
const FACET_BM25_BONUS = 0.04;

function emptyFacet(): FacetSimilarities {
  return { main: 0, people: 0, context: 0, use_case: 0 };
}

/** Merge facet ANN hits; keep best cosine per meme per branch. */
function mergeFacetMaps(
  main: FacetSimHit[],
  people: FacetSimHit[],
  context: FacetSimHit[],
  useCase: FacetSimHit[]
): Map<string, FacetSimilarities> {
  const m = new Map<string, FacetSimilarities>();
  const touch = (id: string, patch: Partial<FacetSimilarities>) => {
    const cur = m.get(id) ?? emptyFacet();
    m.set(id, { ...cur, ...patch });
  };
  for (const h of main) touch(h.meme_id, { main: h.similarity });
  for (const h of people) touch(h.meme_id, { people: h.similarity });
  for (const h of context) touch(h.meme_id, { context: h.similarity });
  for (const h of useCase) touch(h.meme_id, { use_case: h.similarity });
  return m;
}

interface FacetSimHit {
  meme_id: string;
  similarity: number;
}

function facetLinearScore(fs: FacetSimilarities): number {
  return (
    FACET_W.main * fs.main +
    FACET_W.people * fs.people +
    FACET_W.context * fs.context +
    FACET_W.use_case * fs.use_case
  );
}

function rrfFuse(rankings: string[][], k = 60): Map<string, number> {
  const scores = new Map<string, number>();
  for (const ranking of rankings) {
    ranking.forEach((id, i) => {
      scores.set(id, (scores.get(id) ?? 0) + 1 / (k + i + 1));
    });
  }
  return scores;
}

function parseJsonField<T>(v: string | null, fallback: T): T {
  if (!v) return fallback;
  try { return JSON.parse(v) as T; } catch { return fallback; }
}

function rowToResult(row: VectorRow, similarity: number): SearchResult {
  return {
    meme_id: row.meme_id,
    similarity,
    image_path: row.image_path,
    caption: parseJsonField(row.caption, {}),
    primary_language: row.primary_language,
    supported_languages: parseJsonField(row.supported_languages, []),
    emotion: parseJsonField(row.emotion, []),
    regions: parseJsonField(row.regions, []),
    intent: row.intent ?? '',
    popularity_score: row.popularity_score ?? 0,
    people: parseJsonField(row.people, []),
    source: row.source ?? '',
    scene_description: row.scene_description ?? '',
    meaning: parseJsonField(row.meaning, {}),
  };
}

const SELECT_FIELDS = `
  m.id            AS meme_id,
  m.image_path    AS image_path,
  m.primary_language,
  m.supported_languages,
  m.caption,
  m.emotion,
  m.regions,
  m.intent,
  m.popularity_score,
  m.people,
  m.source,
  m.scene_description,
  m.meaning
`;

export class VectorStore {
  private db: Client;

  constructor(client: Client = db) {
    this.db = client;
  }

  private async _timed<T>(
    perf: PerfRecorderLike | undefined,
    scope: string,
    phase: string,
    fn: () => Promise<T>
  ): Promise<T> {
    if (!perf) return fn();
    const t0 = performance.now();
    try {
      return await fn();
    } finally {
      perf.record(scope, phase, performance.now() - t0);
    }
  }

  private async searchTableScored(
    queryVec: Float32Array,
    table: "embeddings" | "embeddings_people" | "embeddings_context" | "embeddings_use_case",
    indexName: string,
    k: number,
    minSimilarity: number
  ): Promise<FacetSimHit[]> {
    const vec = JSON.stringify(Array.from(queryVec));
    try {
      const { rows } = await this.db.execute({
        sql: `
          SELECT m.id AS meme_id,
                 vector_distance_cos(e.embedding, vector32(:vec)) AS distance
          FROM vector_top_k('${indexName}', vector32(:vec), :k) v
          JOIN ${table} e ON e.rowid = v.id
          JOIN memes m ON m.id = e.meme_id
          ORDER BY distance ASC
        `,
        args: { vec, k },
      });

      const out: FacetSimHit[] = [];
      for (const r of rows as unknown as { meme_id: string; distance: number }[]) {
        const similarity = Math.max(0, 1 - r.distance);
        if (similarity >= minSimilarity) {
          out.push({ meme_id: r.meme_id, similarity });
        }
      }
      return out;
    } catch {
      return [];
    }
  }

  private async searchBM25(queryText: string, limit: number): Promise<string[]> {
    try {
      const { rows } = await this.db.execute({
        sql: `
          SELECT meme_id, rank
          FROM memes_fts
          WHERE search_text MATCH :q
          ORDER BY rank
          LIMIT :limit
        `,
        args: { q: queryText, limit },
      });
      return (rows as unknown as { meme_id: string }[]).map(r => r.meme_id);
    } catch {
      return [];
    }
  }

  private async searchPeopleExact(names: string[]): Promise<string[]> {
    if (!names.length) return [];
    try {
      const results = new Set<string>();
      for (const rawName of names) {
        const normalized = rawName.toLowerCase().replace(/\s*\(.*?\)/g, '').trim();
        const { rows } = await this.db.execute({
          sql: `SELECT meme_id FROM meme_people WHERE person_name LIKE :name LIMIT 50`,
          args: { name: `%${normalized}%` },
        });
        (rows as unknown as { meme_id: string }[]).forEach(r => results.add(r.meme_id));
      }
      return [...results];
    } catch {
      return [];
    }
  }

  private async fetchResults(memeIds: string[]): Promise<Map<string, SearchResult>> {
    if (!memeIds.length) return new Map();

    const placeholders = memeIds.map(() => '?').join(',');
    const { rows } = await this.db.execute({
      sql: `
        SELECT ${SELECT_FIELDS},
               COALESCE(
                 (SELECT 1 - vector_distance_cos(e.embedding, e.embedding) FROM embeddings e WHERE e.meme_id = m.id LIMIT 1),
                 0
               ) AS distance
        FROM memes m
        WHERE m.id IN (${placeholders})
      `,
      args: memeIds,
    });

    const map = new Map<string, SearchResult>();
    for (const row of rows as unknown as (VectorRow & { distance: number })[]) {
      map.set(row.meme_id, rowToResult(row, 1.0));
    }
    return map;
  }

  async fusedSearch(
    queryEmbedding: Float32Array,
    queryText: string,
    detectedPeople: string[],
    options: SearchOptions = {},
    perf?: PerfRecorderLike
  ): Promise<SearchResult[]> {
    const {
      language,
      region,
      emotion,
      limit = 10,
      minSimilarity = 0.35,
      facetRescore = false,
    } = options;

    const k = Math.max(limit * 8, 80);

    const tParallel = performance.now();
    const [
      mainHits,
      peopleHits,
      contextHits,
      useCaseHits,
      bm25Ranking,
      exactPeopleIds,
    ] = await Promise.all([
      this._timed(perf, "fusedSearch", "parallel.vec_main", () =>
        this.searchTableScored(queryEmbedding, "embeddings", "embeddings_vec_idx", k, minSimilarity)),
      this._timed(perf, "fusedSearch", "parallel.vec_people", () =>
        this.searchTableScored(queryEmbedding, "embeddings_people", "embeddings_people_vec_idx", k, minSimilarity)),
      this._timed(perf, "fusedSearch", "parallel.vec_context", () =>
        this.searchTableScored(queryEmbedding, "embeddings_context", "embeddings_context_vec_idx", k, minSimilarity)),
      this._timed(perf, "fusedSearch", "parallel.vec_use_case", () =>
        this.searchTableScored(queryEmbedding, "embeddings_use_case", "embeddings_use_case_vec_idx", k, minSimilarity)),
      this._timed(perf, "fusedSearch", "parallel.bm25_fts", () => this.searchBM25(queryText, k)),
      this._timed(perf, "fusedSearch", "parallel.people_exact_sql", () =>
        this.searchPeopleExact(detectedPeople)),
    ]);
    perf?.record("fusedSearch", "parallel_promise_all_wall", performance.now() - tParallel);

    const mainRanking = mainHits.map((h) => h.meme_id);
    const peopleVecRanking = peopleHits.map((h) => h.meme_id);
    const contextRanking = contextHits.map((h) => h.meme_id);
    const useCaseRanking = useCaseHits.map((h) => h.meme_id);

    let facetByMeme: Map<string, FacetSimilarities> | undefined;
    if (facetRescore) {
      facetByMeme = mergeFacetMaps(mainHits, peopleHits, contextHits, useCaseHits);
    }

    const exactPeopleRanking = [...new Set(exactPeopleIds)];

    const tRrf = performance.now();
    const rrfScores = rrfFuse([
      exactPeopleRanking,
      exactPeopleRanking,
      mainRanking,
      peopleVecRanking,
      contextRanking,
      useCaseRanking,
      bm25Ranking,
    ]);
    perf?.record("fusedSearch", "rrf_fuse_and_sort_slice", performance.now() - tRrf);

    const sortedIds = [...rrfScores.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit * 4)
      .map(([id]) => id);

    if (!sortedIds.length) return [];

    const resultMap = await this._timed(perf, "fusedSearch", "hydrate_fetch_memes", () =>
      this.fetchResults(sortedIds));

    const tFilter = performance.now();
    const results: SearchResult[] = [];
    for (const id of sortedIds) {
      const r = resultMap.get(id);
      if (!r) continue;

      if (language && !r.supported_languages.includes(language) && r.primary_language !== language) continue;
      if (region && !r.regions.includes(region) && !r.regions.includes('pan_india')) continue;
      if (emotion && !r.emotion.includes(emotion)) continue;

      results.push({ ...r, rrf_score: rrfScores.get(id) ?? 0 });
    }
    perf?.record("fusedSearch", "metadata_filter", performance.now() - tFilter);

    if (facetByMeme) {
      const tFacetAttach = performance.now();
      const bm25Boost = new Set(bm25Ranking.slice(0, 40));
      for (let i = 0; i < results.length; i++) {
        const r = results[i]!;
        const fs = facetByMeme.get(r.meme_id) ?? emptyFacet();
        let blend = facetLinearScore(fs);
        if (bm25Boost.has(r.meme_id)) blend += FACET_BM25_BONUS;
        blend = Math.min(1, blend);
        if (blend < 1e-8) blend = Math.min(1, (r.rrf_score ?? 0) * 12);
        results[i] = { ...r, facet_sims: fs, facet_blend: blend };
      }
      perf?.record("fusedSearch", "facet_blend_attach", performance.now() - tFacetAttach, {
        memes_scored: results.length,
      });
    }

    return results;
  }

  async crossEncode(
    results: SearchResult[],
    query: string,
    topK: number,
    perf?: PerfRecorderLike
  ): Promise<SearchResult[]> {
    if (!results.length) return [];

    const candidates = results.slice(0, Math.min(topK, 15));

    const tAll = performance.now();
    const scored = await Promise.all(
      candidates.map(async (r, i) =>
        this._timed(perf, "crossEncode", `llm_candidate_${i}`, async () => {
          try {
            const cap = r.caption as { original?: string; translations?: Record<string, string> } | null;
            const caption = cap?.translations?.english ?? cap?.original ?? "";
            const meanEn = (r.meaning as { english?: string })?.english ?? "";
            const desc = [
              r.scene_description ? `Scene: ${r.scene_description}` : "",
              r.source ? `Source: ${r.source}` : "",
              r.people?.length ? `People: ${r.people.join(", ")}` : "",
              meanEn ? `Meaning: ${meanEn}` : "",
              caption ? `Caption: ${caption}` : "",
              r.emotion?.length ? `Emotion: ${r.emotion.join(", ")}` : "",
            ]
              .filter(Boolean)
              .join(". ");

            const { object } = await generateObject({
              model: analysisChatModel,
              schema: z.object({ score: z.number().min(0).max(10) }),
              system: CROSS_ENCODER_SYSTEM_PROMPT,
              prompt: `Query: "${query}"\n\nMeme: ${desc}`,
            });

            return { ...r, cross_score: object.score };
          } catch {
            return { ...r, cross_score: (r.rrf_score ?? 0) * 100 };
          }
        })
      )
    );
    perf?.record("crossEncode", "parallel_all_wall", performance.now() - tAll, {
      candidate_count: candidates.length,
    });

    const tRest = performance.now();
    const rest = results.slice(candidates.length).map((r) => ({
      ...r,
      cross_score: (r.rrf_score ?? 0) * 50,
    }));

    const merged = [...scored, ...rest]
      .filter((r) => (r.cross_score ?? 0) >= 2)
      .sort((a, b) => (b.cross_score ?? 0) - (a.cross_score ?? 0));
    perf?.record("crossEncode", "rest_filter_sort", performance.now() - tRest);

    return merged;
  }

  rank(results: SearchResult[], options: SearchOptions = {}): SearchResult[] {
    const { language, region, querySignals } = options;

    return results
      .map((r) => {
        let score: number;

        if (r.cross_score) {
          score = r.cross_score * 10;
        } else if (r.facet_blend != null) {
          score = r.facet_blend * 100;
        } else {
          score = (r.rrf_score ?? r.similarity) * 100;
        }

        if (language && r.primary_language === language) score += 20;
        if (region && r.regions.includes(region)) score += 15;
        if (r.regions.includes("pan_india")) score += 5;
        score += Math.min(r.popularity_score, 50) * 0.2;

        const query_signal_boost =
          querySignals != null ? computeQuerySignalBoost(r, querySignals) : 0;
        if (query_signal_boost !== 0) score += query_signal_boost;

        return querySignals != null ? { ...r, score, query_signal_boost } : { ...r, score };
      })
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  }

  // Legacy single-vector search (kept for batch-search endpoint)
  async search(
    queryEmbedding: Float32Array,
    options: SearchOptions = {}
  ): Promise<SearchResult[]> {
    const {
      language,
      region,
      emotion,
      limit = 20,
      minSimilarity = 0.35,
    } = options;

    const vec = JSON.stringify(Array.from(queryEmbedding));
    const k = limit * 5;

    try {
      const { rows } = await this.db.execute({
        sql: `
          SELECT ${SELECT_FIELDS},
                 vector_distance_cos(e.embedding, vector32(:vec)) AS distance
          FROM vector_top_k('embeddings_vec_idx', vector32(:vec), :k) v
          JOIN embeddings e ON e.rowid = v.id
          JOIN memes      m ON m.id    = e.meme_id
          ORDER BY distance ASC
        `,
        args: { vec, k },
      });

      const results: SearchResult[] = [];

      for (const row of rows as unknown as (VectorRow & { distance: number })[]) {
        const supported_languages = parseJsonField(row.supported_languages, [] as string[]);
        const regions_arr = parseJsonField(row.regions, [] as string[]);
        const emotion_arr = parseJsonField(row.emotion, [] as string[]);

        if (language && !supported_languages.includes(language) && row.primary_language !== language) continue;
        if (region && !regions_arr.includes(region) && !regions_arr.includes('pan_india')) continue;
        if (emotion && !emotion_arr.includes(emotion)) continue;

        const similarity = 1 - row.distance;
        if (similarity < minSimilarity) continue;

        results.push(rowToResult(row, similarity));
        if (results.length >= limit) break;
      }

      return results;
    } catch {
      return [];
    }
  }

  async getStats() {
    const { rows } = await this.db.execute(`SELECT COUNT(*) AS count FROM embeddings`);
    const { rows: pr } = await this.db.execute(`SELECT COUNT(*) AS count FROM embeddings_people`);
    const { rows: cr } = await this.db.execute(`SELECT COUNT(*) AS count FROM embeddings_context`);
    const { rows: ur } = await this.db.execute(`SELECT COUNT(*) AS count FROM embeddings_use_case`);
    const count = Number((rows[0] as any).count);
    return {
      total_embeddings: count,
      embeddings_people: Number((pr[0] as any).count),
      embeddings_context: Number((cr[0] as any).count),
      embeddings_use_case: Number((ur[0] as any).count),
      memory_mb: (count * 3072 * 4) / (1024 * 1024),
      ready: true,
    };
  }
}
