import Database from "bun:sqlite";

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
  private db: Database;
  private memoryIndex: Map<string, Float32Array>;
  private metadata: Map<string, Record<string, unknown>>;
  private ready: boolean = false;

  constructor(dbPath: string = "memes.db") {
    this.db = new Database(dbPath);
    this.memoryIndex = new Map();
    this.metadata = new Map();

    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA synchronous = NORMAL");
    this.db.exec("PRAGMA cache_size = 10000");

    this.loadToMemory();
  }

  private loadToMemory() {
    console.time("Loading embeddings to memory");

    const rows = this.db.prepare(`
      SELECT
        e.meme_id,
        e.embedding,
        m.image_path,
        m.primary_language,
        m.supported_languages,
        m.caption,
        m.emotion,
        m.regions,
        m.intent,
        m.popularity_score
      FROM embeddings e
      JOIN memes m ON m.id = e.meme_id
      WHERE m.reviewed = 1
    `).all() as {
      meme_id: string;
      embedding: ArrayBuffer;
      image_path: string;
      primary_language: string;
      supported_languages: string;
      caption: string;
      emotion: string;
      regions: string;
      intent: string;
      popularity_score: number;
    }[];

    for (const row of rows) {
      const embedding = new Float32Array(row.embedding);
      this.memoryIndex.set(row.meme_id, embedding);
      this.metadata.set(row.meme_id, {
        image_path: row.image_path,
        primary_language: row.primary_language,
        supported_languages: JSON.parse(row.supported_languages),
        caption: JSON.parse(row.caption),
        emotion: JSON.parse(row.emotion),
        regions: JSON.parse(row.regions),
        intent: row.intent,
        popularity_score: row.popularity_score || 0,
      });
    }

    this.ready = true;
    console.timeEnd("Loading embeddings to memory");
    console.log(`Loaded ${this.memoryIndex.size} embeddings into memory`);
  }

  private cosineSimilarity(a: Float32Array, b: Float32Array): number {
    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i]! * b[i]!;
      normA += a[i]! * a[i]!;
      normB += b[i]! * b[i]!;
    }

    if (normA === 0 || normB === 0) return 0;
    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
  }

  search(queryEmbedding: Float32Array, options: SearchOptions = {}): SearchResult[] {
    if (!this.ready) {
      throw new Error("VectorStore not ready");
    }

    const {
      language,
      region,
      emotion,
      limit = 20,
      minSimilarity = 0.3,
    } = options;

    const results: SearchResult[] = [];

    for (const [memeId, embedding] of this.memoryIndex) {
      const meta = this.metadata.get(memeId)!;

      if (language) {
        const isSupported = (meta.supported_languages as string[]).includes(language);
        if (!isSupported && meta.primary_language !== language) {
          continue;
        }
      }

      if (region && !(meta.regions as string[]).includes(region) && !(meta.regions as string[]).includes("pan_india")) {
        continue;
      }

      if (emotion && !(meta.emotion as string[]).includes(emotion)) {
        continue;
      }

      const similarity = this.cosineSimilarity(queryEmbedding, embedding);

      if (similarity < minSimilarity) continue;

      results.push({
        meme_id: memeId,
        similarity,
        image_path: meta.image_path as string,
        caption: meta.caption as Record<string, unknown>,
        primary_language: meta.primary_language as string,
        supported_languages: meta.supported_languages as string[],
        emotion: meta.emotion as string[],
        regions: meta.regions as string[],
        intent: meta.intent as string,
        popularity_score: meta.popularity_score as number,
      });
    }

    results.sort((a, b) => b.similarity - a.similarity);

    return results.slice(0, limit);
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

  reload() {
    this.memoryIndex.clear();
    this.metadata.clear();
    this.loadToMemory();
  }

  getStats() {
    return {
      total_embeddings: this.memoryIndex.size,
      memory_mb: (this.memoryIndex.size * 768 * 4) / (1024 * 1024),
      ready: this.ready,
    };
  }
}