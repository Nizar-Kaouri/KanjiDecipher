-- Kanji Decipher — database schema. Rebuilt from scratch by 3-build-db.js.

DROP TABLE IF EXISTS kanji;
DROP TABLE IF EXISTS components;
DROP TABLE IF EXISTS readings;
DROP TABLE IF EXISTS kanji_meanings;
DROP TABLE IF EXISTS kanji_meanings_l10n;
DROP TABLE IF EXISTS meanings_fts;
DROP TABLE IF EXISTS meta;
DROP TABLE IF EXISTS example_words;
DROP TABLE IF EXISTS kanji_parts;
DROP TABLE IF EXISTS radicals;
DROP TABLE IF EXISTS origin_stories;

CREATE TABLE kanji (
  literal                   TEXT PRIMARY KEY,
  codepoint                 TEXT,
  stroke_count              INTEGER,
  grade                     INTEGER,
  freq                      INTEGER,
  jlpt                      INTEGER,
  radical_number            INTEGER,
  meanings                  TEXT NOT NULL DEFAULT '[]',   -- JSON array (English)
  on_readings               TEXT NOT NULL DEFAULT '[]',   -- JSON array (katakana)
  kun_readings              TEXT NOT NULL DEFAULT '[]',   -- JSON array (hiragana, with . / - markers)
  nanori                    TEXT NOT NULL DEFAULT '[]',   -- JSON array (name readings)
  svg                       TEXT,                         -- animatable stroke-order SVG
  svg_static                TEXT,                         -- numbered static SVG (no-JS fallback)
  formation_type            TEXT,                         -- phono-semantic | compound-ideographic | pictographic-or-simple | unknown
  formation_type_source     TEXT,                         -- 'heuristic'
  origin_story              TEXT,
  origin_story_model        TEXT,                         -- model id, or 'manual-seed'
  origin_story_reviewed     INTEGER NOT NULL DEFAULT 0,
  origin_story_generated_at TEXT
);

CREATE TABLE components (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  kanji_literal TEXT NOT NULL REFERENCES kanji(literal),
  order_index   INTEGER NOT NULL,
  element       TEXT NOT NULL,
  position      TEXT,
  is_radical    INTEGER NOT NULL DEFAULT 0,
  is_phonetic   INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_components_kanji ON components(kanji_literal);

-- Reverse reading index: one row per (kanji, normalised reading).
CREATE TABLE readings (
  reading_kana  TEXT NOT NULL,   -- normalised: hiragana, okurigana/position markers stripped
  reading_type  TEXT NOT NULL,   -- 'on' | 'kun'
  kanji_literal TEXT NOT NULL REFERENCES kanji(literal)
);
CREATE INDEX idx_readings_kana ON readings(reading_kana);

-- One row per (kanji, meaning) — powers LIKE fallback + result snippets.
CREATE TABLE kanji_meanings (
  kanji_literal TEXT NOT NULL REFERENCES kanji(literal),
  meaning       TEXT NOT NULL,
  meaning_lc    TEXT NOT NULL
);
CREATE INDEX idx_km_meaning_lc ON kanji_meanings(meaning_lc);

CREATE TABLE meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);

-- ---- localisation (populated by 1-parse-kanjidic2 -> 3-build-db, and by
--      4-generate-origin-stories --lang; empty for an English-only build) ----

-- Per-language meaning arrays. English lives in kanji.meanings; this holds the
-- other languages KANJIDIC2 ships (fr, es, pt). One row per (kanji, lang).
CREATE TABLE kanji_meanings_l10n (
  literal  TEXT NOT NULL REFERENCES kanji(literal),
  lang     TEXT NOT NULL,          -- 'fr' | 'es' | 'pt' | ...
  meanings TEXT NOT NULL,          -- JSON array of strings
  PRIMARY KEY (literal, lang)
);

-- Translated / re-generated origin stories. English lives in kanji.origin_story;
-- this holds one row per (kanji, non-English lang).
CREATE TABLE origin_stories (
  literal      TEXT NOT NULL REFERENCES kanji(literal),
  lang         TEXT NOT NULL,
  story        TEXT NOT NULL,
  model        TEXT,
  generated_at TEXT,
  PRIMARY KEY (literal, lang)
);

-- ---- dictionary enrichment (populated by 5-parse-dictionary.js; empty otherwise) ----

-- Common words that use a kanji (JMdict / jmdict-simplified).
-- One row per (kanji, word, lang): the word/reading repeat across languages,
-- only `gloss` differs. `lang` = 'en' for an English-only build.
CREATE TABLE example_words (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  kanji_literal TEXT NOT NULL REFERENCES kanji(literal),
  lang          TEXT NOT NULL DEFAULT 'en',
  word          TEXT NOT NULL,
  reading       TEXT NOT NULL,   -- kana
  gloss         TEXT NOT NULL,   -- first 1-2 senses, in `lang`
  priority      INTEGER,         -- lower = more common
  order_index   INTEGER NOT NULL
);
CREATE INDEX idx_example_words_kanji ON example_words(kanji_literal, lang);
CREATE INDEX idx_example_words_word ON example_words(word, lang);

-- Flat kanji -> visible components (KRADFILE). Parts may be non-kanji radicals.
CREATE TABLE kanji_parts (
  kanji_literal TEXT NOT NULL REFERENCES kanji(literal),
  part          TEXT NOT NULL
);
CREATE INDEX idx_kanji_parts_kanji ON kanji_parts(kanji_literal);
CREATE INDEX idx_kanji_parts_part  ON kanji_parts(part);

-- Radical-picker inventory (RADKFILE), limited to parts used by a jōyō kanji.
CREATE TABLE radicals (
  part       TEXT PRIMARY KEY,
  strokes    INTEGER,
  joyo_count INTEGER DEFAULT 0,
  display    TEXT            -- form shown in the picker (RADKFILE stand-ins mapped)
);
