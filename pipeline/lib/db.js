import { DatabaseSync } from "node:sqlite";
import { DB_PATH } from "./paths.js";

/**
 * Open the kanji database. Defaults to the canonical data/kanji.db path.
 * @param {object} [opts]
 * @param {boolean} [opts.readonly=false]
 * @param {string} [opts.path]
 * @returns {DatabaseSync}
 */
export function openDb({ readonly = false, path = DB_PATH } = {}) {
  const db = new DatabaseSync(path, { readOnly: readonly });
  db.exec("PRAGMA foreign_keys = ON");
  return db;
}

/** Detect whether this SQLite build supports FTS5. */
export function hasFts5(db) {
  try {
    db.exec("CREATE VIRTUAL TABLE __fts5_probe USING fts5(x)");
    db.exec("DROP TABLE __fts5_probe");
    return true;
  } catch {
    return false;
  }
}
