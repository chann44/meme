import { createClient, type Client } from "@libsql/client";

const url = process.env.TURSO_DATABASE_URL;
const authToken = process.env.TURSO_AUTH_TOKEN;

if (!url) {
  throw new Error("TURSO_DATABASE_URL is not set (add it to .env)");
}

const db: Client = createClient({ url, authToken });

const schema = await Bun.file("src/db/schema.sql").text();
const statements = schema
  .split(/;\s*(?:\r?\n|$)/)
  .map((s) => s.trim())
  .filter((s) => s.length > 0);

for (const stmt of statements) {
  await db.execute(stmt);
}

export default db;
