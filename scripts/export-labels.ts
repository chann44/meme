import db from "../src/db/index.ts";

/**
 * Export labeled memes from Turso to JSON (same shape as labels.json).
 *
 * Usage:
 *   bun run scripts/export-labels.ts [output.json] [image_path_prefix]
 *
 * Examples:
 *   bun run scripts/export-labels.ts labels.json
 *   bun run scripts/export-labels.ts labels.json memes/
 */
const outputPath = process.argv[2] || "./labels.json";
const pathPrefix = process.argv[3]?.trim();

const baseSql = `
  SELECT
    id, image_path, primary_language, supported_languages,
    caption, meaning, tags, query_examples, emotion, intent,
    regions, safety, quality, multilingual_embedding_text,
    labeled_at, reviewed
  FROM memes
  WHERE labeled_at IS NOT NULL
`;

const { rows } = pathPrefix
  ? await db.execute({
      sql: `${baseSql} AND image_path LIKE ?`,
      args: [`${pathPrefix}%`],
    })
  : await db.execute(baseSql);

const labels = (rows as unknown as any[]).map((row) => ({
  id: row.id,
  image_path: row.image_path,
  primary_language: row.primary_language,
  supported_languages: row.supported_languages ? JSON.parse(row.supported_languages) : [],
  caption: row.caption ? JSON.parse(row.caption) : null,
  meaning: row.meaning ? JSON.parse(row.meaning) : null,
  tags: row.tags ? JSON.parse(row.tags) : null,
  query_examples: row.query_examples ? JSON.parse(row.query_examples) : null,
  emotion: row.emotion ? JSON.parse(row.emotion) : null,
  intent: row.intent ? JSON.parse(row.intent) : null,
  regions: row.regions ? JSON.parse(row.regions) : null,
  safety: row.safety ? JSON.parse(row.safety) : null,
  quality: row.quality ? JSON.parse(row.quality) : null,
  multilingual_embedding_text: row.multilingual_embedding_text,
  labeled_at: row.labeled_at,
  reviewed: Boolean(row.reviewed),
}));

const json = JSON.stringify(labels, null, 2);
await Bun.write(outputPath, json);

console.log(
  `Exported ${labels.length} label(s) to ${outputPath}` +
    (pathPrefix ? ` (image_path LIKE ${JSON.stringify(pathPrefix + "%")})` : "")
);
