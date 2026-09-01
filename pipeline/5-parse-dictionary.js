/**
 * Step 5 — dictionary enrichment. Adds three tables to data/kanji.db:
 *
 *   example_words   common words that use each kanji        (JMdict / jmdict-simplified)
 *   kanji_parts     flat kanji -> visible components         (KRADFILE)
 *   radicals        the radical-picker inventory + counts    (RADKFILE)
 *
 * This is an enrichment step (like 4-generate-origin-stories.js): it opens the
 * existing DB read-write and refills these tables. It does NOT rebuild the DB.
 * Safe to re-run. Skips cleanly if a source file is missing.
 *
 *   node pipeline/5-parse-dictionary.js
 */
import fs from "node:fs";
import { openDb } from "./lib/db.js";
import {
  DB_PATH,
  SOURCE_FILES,
  JMDICT_GLOSS_LANGS,
  GLOSS_LANG_TO_SITE,
} from "./lib/paths.js";
import { unzipSingleJson } from "./lib/unzip.js";
import { radicalDisplay } from "./lib/radicals.js";

const SKIP_FORM_TAGS = new Set(["rK", "sK", "sk", "iK", "oK", "io", "ok"]);

/** First 1-2 senses of `w` in `glossLang` ("eng" | "fre" | "spa" | "ger"). */
function glossOf(w, glossLang, form) {
  const sense =
    w.sense.find((s) => (s.appliesToKanji || []).some((a) => a === form || a === "*")) ||
    w.sense[0];
  return (sense?.gloss || [])
    .filter((g) => g.lang === glossLang)
    .slice(0, 2)
    .map((g) => g.text)
    .join("; ");
}

/** id -> translated gloss, for the words we already picked for `example_words`. */
async function loadGlossMap(file, glossLang, wantedIds) {
  const jm = await unzipSingleJson(file);
  const map = new Map();
  for (const w of jm.words) {
    const id = Number(w.id);
    if (!wantedIds.has(id) || !w.kanji.length) continue;
    const primary = w.kanji.find((k) => k.common) || w.kanji[0];
    const g = glossOf(w, glossLang, primary.text);
    if (g) map.set(id, g);
  }
  return { map, date: jm.dictDate ?? "" };
}

async function main() {
  if (!fs.existsSync(DB_PATH)) {
    console.error(`Missing ${DB_PATH} — run: npm run pipeline:build`);
    process.exit(1);
  }
  for (const f of [SOURCE_FILES.jmdict, SOURCE_FILES.kradfile, SOURCE_FILES.radkfile]) {
    if (!fs.existsSync(f)) {
      console.error(`Missing ${f} — run: npm run pipeline:download`);
      process.exit(1);
    }
  }

  const [jm, kradDoc, radkDoc] = await Promise.all([
    unzipSingleJson(SOURCE_FILES.jmdict),
    unzipSingleJson(SOURCE_FILES.kradfile),
    unzipSingleJson(SOURCE_FILES.radkfile),
  ]);

  const db = openDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS example_words (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kanji_literal TEXT NOT NULL, lang TEXT NOT NULL DEFAULT 'en',
      word TEXT NOT NULL, reading TEXT NOT NULL,
      gloss TEXT NOT NULL, priority INTEGER, order_index INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_example_words_kanji ON example_words(kanji_literal, lang);
    CREATE INDEX IF NOT EXISTS idx_example_words_word ON example_words(word, lang);
    CREATE TABLE IF NOT EXISTS kanji_parts (kanji_literal TEXT NOT NULL, part TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_kanji_parts_kanji ON kanji_parts(kanji_literal);
    CREATE INDEX IF NOT EXISTS idx_kanji_parts_part ON kanji_parts(part);
    CREATE TABLE IF NOT EXISTS radicals (part TEXT PRIMARY KEY, strokes INTEGER, joyo_count INTEGER DEFAULT 0, display TEXT);
  `);
  db.exec("DELETE FROM example_words; DELETE FROM kanji_parts; DELETE FROM radicals");

  const kanjiSet = new Set(db.prepare("SELECT literal FROM kanji").all().map((r) => r.literal));
  console.log(`${kanjiSet.size} jōyō kanji in DB`);

  // ---- example words -----------------------------------------------------
  console.log(`JMdict (eng-common): ${jm.words.length} entries, ${jm.dictDate ?? "?"}`);

  /** @type {Map<string, Array<{word,reading,gloss,priority,len,id}>>} */
  const byKanji = new Map();
  for (const w of jm.words) {
    if (!w.kanji.length) continue;
    const primary = w.kanji.find((k) => k.common) || w.kanji[0];
    const form = primary.text;
    if ([...form].length < 2) continue; // single char isn't an "example"
    if ((primary.tags || []).some((t) => SKIP_FORM_TAGS.has(t))) continue;
    if (/[Ａ-Ｚａ-ｚ]/.test(form)) continue; // skip fullwidth-latin headwords (ＣＤ…)

    const kana =
      w.kana.find((k) => (k.appliesToKanji || []).some((a) => a === form || a === "*")) ||
      w.kana[0];
    if (!kana) continue;

    const gloss = glossOf(w, "eng", form);
    if (!gloss) continue;

    const len = [...form].length;
    const priority =
      (primary.common ? 0 : 30) + (len === 2 ? 0 : len === 3 ? 3 : 12);

    for (const ch of form) {
      if (!kanjiSet.has(ch)) continue;
      if (!byKanji.has(ch)) byKanji.set(ch, []);
      byKanji.get(ch).push({ word: form, reading: kana.text, gloss, priority, len, id: Number(w.id) });
    }
  }

  const insWord = db.prepare(
    "INSERT INTO example_words (kanji_literal, lang, word, reading, gloss, priority, order_index) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  let wordRows = 0;
  // The (kanji, order_index, word, id) tuples we actually kept — reused to place
  // translated rows in the same slots.
  const picked = [];
  db.exec("BEGIN");
  for (const [ch, list] of byKanji) {
    list.sort((a, b) => a.priority - b.priority || a.len - b.len || a.id - b.id);
    const seen = new Set();
    let i = 0;
    for (const e of list) {
      if (seen.has(e.word)) continue;
      seen.add(e.word);
      insWord.run(ch, "en", e.word, e.reading, e.gloss, e.priority, i);
      picked.push({ ch, order: i, word: e.word, reading: e.reading, priority: e.priority, id: e.id });
      wordRows++;
      i++;
      if (i >= 10) break;
    }
  }
  db.exec("COMMIT");
  console.log(`  example_words (en): ${wordRows} rows for ${byKanji.size} kanji`);

  // ---- translated glosses (jmdict fr / es / de editions) ---------------
  const wantedIds = new Set(picked.map((p) => p.id));
  const glossLangDates = {};
  for (const [key, glossLang] of Object.entries(JMDICT_GLOSS_LANGS)) {
    const file = SOURCE_FILES[key];
    const site = GLOSS_LANG_TO_SITE[glossLang];
    if (!fs.existsSync(file)) {
      console.log(`  ${site}: ${key} not downloaded — skipping (English fallback)`);
      continue;
    }
    const { map, date } = await loadGlossMap(file, glossLang, wantedIds);
    glossLangDates[site] = date;
    let n = 0;
    db.exec("BEGIN");
    for (const p of picked) {
      const g = map.get(p.id);
      if (!g) continue;
      insWord.run(p.ch, site, p.word, p.reading, g, p.priority, p.order);
      n++;
    }
    db.exec("COMMIT");
    console.log(`  example_words (${site}): ${n} translated rows (${map.size} words matched)`);
  }

  // ---- kanji_parts (KRADFILE) ------------------------------------------
  const krad = kradDoc.kanji;
  const insPart = db.prepare("INSERT INTO kanji_parts (kanji_literal, part) VALUES (?, ?)");
  let partRows = 0;
  db.exec("BEGIN");
  for (const [ch, parts] of Object.entries(krad)) {
    if (!kanjiSet.has(ch)) continue;
    for (const p of new Set(parts)) {
      insPart.run(ch, p);
      partRows++;
    }
  }
  db.exec("COMMIT");
  console.log(`  kanji_parts: ${partRows} rows`);

  // ---- radicals (RADKFILE) --------------------------------------------
  const radk = radkDoc.radicals;
  const insRad = db.prepare("INSERT INTO radicals (part, strokes, joyo_count, display) VALUES (?, ?, 0, ?)");
  db.exec("BEGIN");
  for (const [part, info] of Object.entries(radk)) {
    insRad.run(part, info.strokeCount ?? null, radicalDisplay(part));
  }
  db.exec("COMMIT");
  db.exec(`
    UPDATE radicals SET joyo_count =
      (SELECT COUNT(DISTINCT kanji_literal) FROM kanji_parts WHERE part = radicals.part)
  `);
  const removed = db.prepare("DELETE FROM radicals WHERE joyo_count = 0").run().changes;
  const radCount = db.prepare("SELECT COUNT(*) n FROM radicals").get().n;
  console.log(`  radicals: ${radCount} kept (${removed} unused by jōyō kanji, dropped)`);

  // ---- meta ----------------------------------------------------------
  const setMeta = db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)");
  for (const [k, v] of [
    ["jmdict_version", String(jm.version ?? "")],
    ["jmdict_date", String(jm.dictDate ?? "")],
    ["jmdict_license", "CC BY-SA 4.0"],
    ["jmdict_attribution", "EDRDG / Jim Breen"],
    ["krad_license", "CC BY-SA 3.0"],
    ["krad_attribution", "James Breen / EDRDG"],
    ["dict_conversion", "jmdict-simplified (scriptin)"],
    ["example_word_count", String(wordRows)],
    ["example_word_langs", ["en", ...Object.keys(glossLangDates)].join(",")],
    ["radical_count", String(radCount)],
    ["dict_built_at", new Date().toISOString()],
  ]) {
    setMeta.run(k, v);
  }

  db.close();
  console.log("\nDone. Restart the web server to pick up the new data.");
}

main().catch((err) => {
  console.error("\nFailed:", err.message);
  process.exit(1);
});
