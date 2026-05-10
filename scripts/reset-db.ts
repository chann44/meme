import Database from "bun:sqlite";

/**
 * Remove all rows from `memes` and `embeddings` (keeps schema).
 * Run from repo root: `bun run scripts/reset-db.ts`
 */
const db = new Database("memes.db");
db.exec("DELETE FROM embeddings");
db.exec("DELETE FROM memes");
db.exec("VACUUM");
console.log("SQLite cleared: embeddings + memes.");
