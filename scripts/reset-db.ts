import db from "../src/db/index.ts";

/**
 * Remove all rows from `memes` and `embeddings` (keeps schema).
 * Run from repo root: `bun run scripts/reset-db.ts`
 */
await db.execute("DELETE FROM embeddings");
await db.execute("DELETE FROM memes");
console.log("Turso cleared: embeddings + memes.");
