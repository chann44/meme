import { generateObject } from "ai";
import { z } from "zod";
import type { Client } from "@libsql/client";
import db from "./db/index.ts";
import { analysisChatModel } from "./ai.ts";
import { CROSS_ENCODER_SYSTEM_PROMPT } from "./prompts.ts";

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

  private async searchTable(
    queryVec: Float32Array,
    table: 'embeddings' | 'embeddings_people' | 'embeddings_context' | 'embeddings_use_case',
    indexName: string,
    k: number,
    minSimilarity: number
  ): Promise<string[]> {
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

      return (rows as unknown as { meme_id: string; distance: number }[])
        .filter(r => (1 - r.distance) >= minSimilarity)
        .map(r => r.meme_id);
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
    options: SearchOptions = {}
  ): Promise<SearchResult[]> {
    const {
      language,
      region,
      emotion,
      limit = 10,
      minSimilarity = 0.35,
    } = options;

    const k = Math.max(limit * 8, 80);

    // Run all searches concurrently
    const [
      mainRanking,
      peopleVecRanking,
      contextRanking,
      useCaseRanking,
      bm25Ranking,
      exactPeopleIds,
    ] = await Promise.all([
      this.searchTable(queryEmbedding, 'embeddings', 'embeddings_vec_idx', k, minSimilarity),
      this.searchTable(queryEmbedding, 'embeddings_people', 'embeddings_people_vec_idx', k, minSimilarity),
      this.searchTable(queryEmbedding, 'embeddings_context', 'embeddings_context_vec_idx', k, minSimilarity),
      this.searchTable(queryEmbedding, 'embeddings_use_case', 'embeddings_use_case_vec_idx', k, minSimilarity),
      this.searchBM25(queryText, k),
      this.searchPeopleExact(detectedPeople),
    ]);

    // Exact people matches get top rank (rank 0 equivalent)
    const exactPeopleRanking = [...new Set(exactPeopleIds)];

    // RRF fusion — weight exact people matches extra heavily by prepending them 3x
    const rrfScores = rrfFuse([
      exactPeopleRanking,
      exactPeopleRanking, // double-weight exact name matches
      mainRanking,
      peopleVecRanking,
      contextRanking,
      useCaseRanking,
      bm25Ranking,
    ]);

    // Sort by RRF score
    const sortedIds = [...rrfScores.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit * 4)
      .map(([id]) => id);

    if (!sortedIds.length) return [];

    // Fetch full meme data
    const resultMap = await this.fetchResults(sortedIds);

    // Apply metadata filters and attach RRF scores
    const results: SearchResult[] = [];
    for (const id of sortedIds) {
      const r = resultMap.get(id);
      if (!r) continue;

      if (language && !r.supported_languages.includes(language) && r.primary_language !== language) continue;
      if (region && !r.regions.includes(region) && !r.regions.includes('pan_india')) continue;
      if (emotion && !r.emotion.includes(emotion)) continue;

      results.push({ ...r, rrf_score: rrfScores.get(id) ?? 0 });
    }

    return results;
  }

  async crossEncode(
    results: SearchResult[],
    query: string,
    topK: number
  ): Promise<SearchResult[]> {
    if (!results.length) return [];

    const candidates = results.slice(0, Math.min(topK, 15));

    const scored = await Promise.all(
      candidates.map(async (r) => {
        try {
          const cap = r.caption as { original?: string; translations?: Record<string, string> } | null;
          const caption = cap?.translations?.english ?? cap?.original ?? '';
          const meanEn = (r.meaning as any)?.english ?? '';
          const desc = [
            r.scene_description ? `Scene: ${r.scene_description}` : '',
            r.source ? `Source: ${r.source}` : '',
            r.people?.length ? `People: ${r.people.join(', ')}` : '',
            meanEn ? `Meaning: ${meanEn}` : '',
            caption ? `Caption: ${caption}` : '',
            r.emotion?.length ? `Emotion: ${r.emotion.join(', ')}` : '',
          ].filter(Boolean).join('. ');

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
    );

    // Remaining results (beyond topK for cross-encoding) keep RRF score
    const rest = results.slice(candidates.length).map(r => ({
      ...r,
      cross_score: (r.rrf_score ?? 0) * 50,
    }));

    return [...scored, ...rest]
      .filter(r => (r.cross_score ?? 0) >= 3)
      .sort((a, b) => (b.cross_score ?? 0) - (a.cross_score ?? 0));
  }

  rank(results: SearchResult[], options: SearchOptions = {}): SearchResult[] {
    const { language, region } = options;

    return results
      .map((r) => {
        let score = (r.cross_score ?? 0) * 10;

        // Fallback to RRF if no cross score
        if (!r.cross_score) {
          score = (r.rrf_score ?? r.similarity) * 100;
        }

        if (language && r.primary_language === language) score += 20;
        if (region && r.regions.includes(region)) score += 15;
        if (r.regions.includes('pan_india')) score += 5;
        score += Math.min(r.popularity_score, 50) * 0.2;

        return { ...r, score };
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
