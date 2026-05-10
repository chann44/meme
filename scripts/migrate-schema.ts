/**
 * Incremental schema migration — adds new columns, tables, and indexes.
 * Safe to run multiple times (uses IF NOT EXISTS / try-catch).
 *
 *   bun run scripts/migrate-schema.ts
 */
import db from "../src/db/index.ts";

async function tryExec(sql: string, label: string) {
  try {
    await db.execute(sql);
    console.log(`✓ ${label}`);
  } catch (e: any) {
    if (
      e?.message?.includes("duplicate column") ||
      e?.message?.includes("already exists") ||
      e?.message?.includes("UNIQUE constraint")
    ) {
      console.log(`  (already exists) ${label}`);
    } else {
      console.warn(`  WARN ${label}: ${e?.message}`);
    }
  }
}

// ── 1. New columns on memes ────────────────────────────────────────────────
await tryExec(`ALTER TABLE memes ADD COLUMN ocr_text TEXT DEFAULT ''`, "memes.ocr_text");
await tryExec(`ALTER TABLE memes ADD COLUMN image_description TEXT DEFAULT ''`, "memes.image_description");
await tryExec(`ALTER TABLE memes ADD COLUMN people TEXT DEFAULT '[]'`, "memes.people");
await tryExec(`ALTER TABLE memes ADD COLUMN source TEXT DEFAULT ''`, "memes.source");
await tryExec(`ALTER TABLE memes ADD COLUMN cultural_references TEXT DEFAULT '[]'`, "memes.cultural_references");
await tryExec(`ALTER TABLE memes ADD COLUMN scene_description TEXT DEFAULT ''`, "memes.scene_description");

// ── 2. New embedding tables ────────────────────────────────────────────────
await tryExec(`
  CREATE TABLE IF NOT EXISTS embeddings_people (
    meme_id TEXT PRIMARY KEY,
    embedding F32_BLOB(3072) NOT NULL,
    model TEXT DEFAULT 'gemini-embedding-2',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(meme_id) REFERENCES memes(id)
  )
`, "table: embeddings_people");

await tryExec(
  `CREATE INDEX IF NOT EXISTS embeddings_people_vec_idx ON embeddings_people(libsql_vector_idx(embedding))`,
  "index: embeddings_people_vec_idx"
);

await tryExec(`
  CREATE TABLE IF NOT EXISTS embeddings_context (
    meme_id TEXT PRIMARY KEY,
    embedding F32_BLOB(3072) NOT NULL,
    model TEXT DEFAULT 'gemini-embedding-2',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(meme_id) REFERENCES memes(id)
  )
`, "table: embeddings_context");

await tryExec(
  `CREATE INDEX IF NOT EXISTS embeddings_context_vec_idx ON embeddings_context(libsql_vector_idx(embedding))`,
  "index: embeddings_context_vec_idx"
);

await tryExec(`
  CREATE TABLE IF NOT EXISTS embeddings_use_case (
    meme_id TEXT PRIMARY KEY,
    embedding F32_BLOB(3072) NOT NULL,
    model TEXT DEFAULT 'gemini-embedding-2',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(meme_id) REFERENCES memes(id)
  )
`, "table: embeddings_use_case");

await tryExec(
  `CREATE INDEX IF NOT EXISTS embeddings_use_case_vec_idx ON embeddings_use_case(libsql_vector_idx(embedding))`,
  "index: embeddings_use_case_vec_idx"
);

// ── 3. People inverted index ───────────────────────────────────────────────
await tryExec(`
  CREATE TABLE IF NOT EXISTS meme_people (
    person_name TEXT NOT NULL,
    meme_id TEXT NOT NULL,
    PRIMARY KEY(person_name, meme_id),
    FOREIGN KEY(meme_id) REFERENCES memes(id)
  )
`, "table: meme_people");

await tryExec(
  `CREATE INDEX IF NOT EXISTS idx_meme_people_name ON meme_people(person_name)`,
  "index: idx_meme_people_name"
);

// ── 4. FTS5 virtual table ──────────────────────────────────────────────────
await tryExec(`
  CREATE VIRTUAL TABLE IF NOT EXISTS memes_fts USING fts5(
    meme_id UNINDEXED,
    search_text,
    tokenize='unicode61 remove_diacritics 2'
  )
`, "table: memes_fts (FTS5)");

// ── 5. Backfill FTS from existing memes ──────────────────────────────────
console.log("\nBackfilling FTS from existing memes...");
const { rows: existing } = await db.execute(`
  SELECT m.id, m.caption, m.meaning, m.tags, m.query_examples,
         m.people, m.source, m.cultural_references, m.scene_description,
         m.ocr_text, m.image_description
  FROM memes m
  WHERE m.id NOT IN (SELECT meme_id FROM memes_fts)
`);

if (existing.length === 0) {
  console.log("  (FTS already up to date)");
} else {
  function safeParse(v: unknown): any {
    if (v == null || v === '') return null;
    if (typeof v === 'object') return v;
    try { return JSON.parse(v as string); } catch { return null; }
  }

  function buildSearchText(row: any): string {
    const parts: string[] = [];
    const cap = safeParse(row.caption);
    if (cap?.original) parts.push(cap.original);
    if (cap?.translations?.english) parts.push(cap.translations.english);

    const meaning = safeParse(row.meaning);
    if (meaning?.english) parts.push(meaning.english);
    if (meaning?.hinglish) parts.push(meaning.hinglish);

    const tags = safeParse(row.tags);
    if (tags?.english) parts.push(...(tags.english as string[]));
    if (tags?.hinglish) parts.push(...(tags.hinglish as string[]));

    const qe = safeParse(row.query_examples);
    if (qe?.english) parts.push(...(qe.english as string[]));
    if (qe?.hinglish) parts.push(...(qe.hinglish as string[]));

    const people = safeParse(row.people);
    if (Array.isArray(people)) parts.push(...people);

    if (row.source) parts.push(String(row.source));

    const cref = safeParse(row.cultural_references);
    if (Array.isArray(cref)) parts.push(...cref);

    if (row.scene_description) parts.push(String(row.scene_description));
    if (row.ocr_text) parts.push(String(row.ocr_text));
    if (row.image_description) parts.push(String(row.image_description));

    return parts.filter(Boolean).join(' ');
  }

  for (const row of existing as any[]) {
    const text = buildSearchText(row);
    try {
      await db.execute({
        sql: `INSERT OR IGNORE INTO memes_fts(meme_id, search_text) VALUES (?, ?)`,
        args: [row.id, text],
      });
    } catch {}
  }
  console.log(`  Inserted ${existing.length} rows into memes_fts`);
}

console.log("\nMigration complete.");
