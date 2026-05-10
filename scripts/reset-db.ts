import db from "../src/db/index.ts";

/**
 * Remove all rows from all tables (keeps schema).
 * Run from repo root: `bun run scripts/reset-db.ts`
 */
await db.execute("DELETE FROM embeddings_use_case");
await db.execute("DELETE FROM embeddings_context");
await db.execute("DELETE FROM embeddings_people");
await db.execute("DELETE FROM embeddings");
await db.execute("DELETE FROM meme_people");
await db.execute("DELETE FROM memes_fts");
await db.execute("DELETE FROM memes");

console.log("DB cleared: all memes, embeddings, people index, and FTS data removed.");
