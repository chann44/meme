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
  ocr_text TEXT DEFAULT '',
  image_description TEXT DEFAULT '',
  people TEXT DEFAULT '[]',
  source TEXT DEFAULT '',
  cultural_references TEXT DEFAULT '[]',
  scene_description TEXT DEFAULT '',
  popularity_score INTEGER DEFAULT 0,
  labeled_at TIMESTAMP,
  reviewed BOOLEAN DEFAULT 0
);

-- Main semantic embedding (all 5 languages + full context)
CREATE TABLE IF NOT EXISTS embeddings (
  meme_id TEXT PRIMARY KEY,
  embedding F32_BLOB(3072) NOT NULL,
  model TEXT DEFAULT 'gemini-embedding-2',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(meme_id) REFERENCES memes(id)
);
CREATE INDEX IF NOT EXISTS embeddings_vec_idx
  ON embeddings(libsql_vector_idx(embedding));

-- People/names/characters aspect embedding
CREATE TABLE IF NOT EXISTS embeddings_people (
  meme_id TEXT PRIMARY KEY,
  embedding F32_BLOB(3072) NOT NULL,
  model TEXT DEFAULT 'gemini-embedding-2',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(meme_id) REFERENCES memes(id)
);
CREATE INDEX IF NOT EXISTS embeddings_people_vec_idx
  ON embeddings_people(libsql_vector_idx(embedding));

-- Visual/cultural context aspect embedding
CREATE TABLE IF NOT EXISTS embeddings_context (
  meme_id TEXT PRIMARY KEY,
  embedding F32_BLOB(3072) NOT NULL,
  model TEXT DEFAULT 'gemini-embedding-2',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(meme_id) REFERENCES memes(id)
);
CREATE INDEX IF NOT EXISTS embeddings_context_vec_idx
  ON embeddings_context(libsql_vector_idx(embedding));

-- Emotion/use-case aspect embedding
CREATE TABLE IF NOT EXISTS embeddings_use_case (
  meme_id TEXT PRIMARY KEY,
  embedding F32_BLOB(3072) NOT NULL,
  model TEXT DEFAULT 'gemini-embedding-2',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(meme_id) REFERENCES memes(id)
);
CREATE INDEX IF NOT EXISTS embeddings_use_case_vec_idx
  ON embeddings_use_case(libsql_vector_idx(embedding));

-- Inverted index: person name → meme ids (exact lookup)
CREATE TABLE IF NOT EXISTS meme_people (
  person_name TEXT NOT NULL,
  meme_id TEXT NOT NULL,
  PRIMARY KEY(person_name, meme_id),
  FOREIGN KEY(meme_id) REFERENCES memes(id)
);
CREATE INDEX IF NOT EXISTS idx_meme_people_name ON meme_people(person_name);

-- FTS5 full-text search table for BM25 keyword matching
CREATE VIRTUAL TABLE IF NOT EXISTS memes_fts USING fts5(
  meme_id UNINDEXED,
  search_text,
  tokenize='unicode61 remove_diacritics 2'
);

CREATE INDEX IF NOT EXISTS idx_memes_language ON memes(primary_language);
CREATE INDEX IF NOT EXISTS idx_memes_reviewed ON memes(reviewed);
