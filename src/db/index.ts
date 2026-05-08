import Database from "bun:sqlite";

const db = new Database("memes.db");

db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA synchronous = NORMAL");
db.exec("PRAGMA cache_size = 10000");

const schema = await Bun.file("src/db/schema.sql").text();
db.exec(schema);

export default db;