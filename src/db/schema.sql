CREATE TABLE IF NOT EXISTS memes (
  id TEXT PRIMARY KEY,
  image_path TEXT NOT NULL,
  primary_language TEXT,
  supported_languages TEXT,
  caption TEXT,
  meaning TEXT,
  tags TEXT,
  query_examples TEXT,
  emotion TEXT,
  intent TEXT,
  regions TEXT,
  safety TEXT,
  quality TEXT,
  multilingual_embedding_text TEXT,
  popularity_score INTEGER DEFAULT 0,
  labeled_at TIMESTAMP,
  reviewed BOOLEAN DEFAULT 0
);

CREATE TABLE IF NOT EXISTS embeddings (
  meme_id TEXT PRIMARY KEY,
  embedding F32_BLOB(3072) NOT NULL,
  model TEXT DEFAULT 'text-embedding-004',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(meme_id) REFERENCES memes(id)
);

CREATE INDEX IF NOT EXISTS idx_memes_language ON memes(primary_language);
CREATE INDEX IF NOT EXISTS idx_memes_reviewed ON memes(reviewed);
CREATE INDEX IF NOT EXISTS embeddings_vec_idx
  ON embeddings(libsql_vector_idx(embedding));
