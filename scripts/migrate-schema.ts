/**
 * Drops and recreates the embeddings table + vector index in Turso.
 * Run once after changing the embedding dimension in the schema.
 *
 *   bun run scripts/migrate-schema.ts
 */
import db from "../src/db/index.ts";

await db.execute("DROP INDEX IF EXISTS embeddings_vec_idx");
await db.execute("DROP TABLE IF EXISTS embeddings");

await db.execute(`
  CREATE TABLE embeddings (
    meme_id TEXT PRIMARY KEY,
    embedding F32_BLOB(3072) NOT NULL,
    model TEXT DEFAULT 'text-embedding-004',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(meme_id) REFERENCES memes(id)
  )
`);

await db.execute(
  `CREATE INDEX embeddings_vec_idx ON embeddings(libsql_vector_idx(embedding))`
);

console.log("Done — embeddings table recreated with F32_BLOB(3072).");
