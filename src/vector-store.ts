import type { Client } from "@libsql/client";
import db from "./db/index.ts";

interface SearchResult {
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
  score?: number;
}

interface SearchOptions {
  language?: string;
  region?: string;
  emotion?: string;
  limit?: number;
  minSimilarity?: number;
}

export class VectorStore {
  private db: Client;

  constructor(client: Client = db) {
    this.db = client;
  }

  async search(
    queryEmbedding: Float32Array,
    options: SearchOptions = {}
  ): Promise<SearchResult[]> {
    const {
      language,
      region,
      emotion,
      limit = 20,
      minSimilarity = 0.3,
    } = options;

    const vec = JSON.stringify(Array.from(queryEmbedding));
    const k = limit * 5;

    const { rows } = await this.db.execute({
      sql: `
        SELECT
          m.id            AS meme_id,
          m.image_path    AS image_path,
          m.primary_language,
          m.supported_languages,
          m.caption,
          m.emotion,
          m.regions,
          m.intent,
          m.popularity_score,
          vector_distance_cos(e.embedding, vector32(:vec)) AS distance
        FROM vector_top_k('embeddings_vec_idx', vector32(:vec), :k) v
        JOIN embeddings e ON e.rowid = v.id
        JOIN memes      m ON m.id    = e.meme_id
        ORDER BY distance ASC
      `,
      args: { vec, k },
    });

    const results: SearchResult[] = [];

    for (const row of rows as unknown as {
      meme_id: string;
      image_path: string;
      primary_language: string;
      supported_languages: string;
      caption: string;
      emotion: string;
      regions: string;
      intent: string;
      popularity_score: number | null;
      distance: number;
    }[]) {
      const supported_languages = JSON.parse(row.supported_languages) as string[];
      const regions_arr = JSON.parse(row.regions) as string[];
      const emotion_arr = JSON.parse(row.emotion) as string[];

      if (language) {
        if (!supported_languages.includes(language) && row.primary_language !== language) {
          continue;
        }
      }

      if (region && !regions_arr.includes(region) && !regions_arr.includes("pan_india")) {
        continue;
      }

      if (emotion && !emotion_arr.includes(emotion)) {
        continue;
      }

      const similarity = 1 - row.distance;
      if (similarity < minSimilarity) continue;

      results.push({
        meme_id: row.meme_id,
        similarity,
        image_path: row.image_path,
        caption: JSON.parse(row.caption),
        primary_language: row.primary_language,
        supported_languages,
        emotion: emotion_arr,
        regions: regions_arr,
        intent: row.intent,
        popularity_score: row.popularity_score ?? 0,
      });

      if (results.length >= limit) break;
    }

    return results;
  }

  rank(results: SearchResult[], options: SearchOptions = {}): SearchResult[] {
    const { language, region } = options;

    return results
      .map((result) => {
        let score = result.similarity * 100;

        if (language && result.primary_language === language) {
          score += 20;
        }

        if (region && result.regions.includes(region)) {
          score += 15;
        }

        if (result.regions.includes("pan_india")) {
          score += 5;
        }

        score += Math.min(result.popularity_score, 50) * 0.2;

        return { ...result, score };
      })
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  }

  async getStats() {
    const { rows } = await this.db.execute(
      `SELECT COUNT(*) AS count FROM embeddings`
    );
    const count = Number((rows[0] as unknown as { count: number | bigint }).count);
    return {
      total_embeddings: count,
      memory_mb: (count * 3072 * 4) / (1024 * 1024),
      ready: true,
    };
  }
}
