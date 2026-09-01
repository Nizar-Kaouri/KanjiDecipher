/**
 * Step 3 — merge the intermediate JSON into data/kanji.db.
 *
 *   - kanji            one row per jōyō kanji (meanings, readings, SVG, formation)
 *   - components       component/radical decomposition (KanjiVG)
 *   - readings         reverse reading index (normalised kana -> kanji)
 *   - kanji_meanings   one row per meaning (+ FTS5 mirror when available)
 *   - meta             source versions, counts, build timestamp
 *
 * Rerunnable: drops and recreates every table from schema.sql.
 */
import fs from "node:fs";
import { openDb, hasFts5 } from "./lib/db.js";
import { classifyFormation } from "./lib/formation.js";
import { normalizeReading } from "./lib/kana.js";
import { SEED_STORIES } from "./lib/seed-stories.js";
import {
  DB_PATH,
  INTERMEDIATE_FILES,
  ensureDirs,
} from "./lib/paths.js";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = path.join(here, "schema.sql");

function loadJson(p, label) {
  if (!fs.existsSync(p)) {
    console.error(`Missing ${p} — run the ${label} step first.`);
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function main() {
  ensureDirs();

  const kd = loadJson(INTERMEDIATE_FILES.kanjidic2, "pipeline:kanjidic");
  const vg = loadJson(INTERMEDIATE_FILES.kanjivg, "pipeline:kanjivg");

  const vgByChar = new Map(vg.kanji.map((k) => [k.literal, k]));

  // Carry forward expensive, externally-generated content across a rebuild:
  // the Claude origin stories (4-generate-origin-stories.js) and the dictionary
  // enrichment (5-parse-dictionary.js). Everything else is regenerated from the
  // source files.
  const preservedStories = new Map();
  const preservedDict = {};
  if (fs.existsSync(DB_PATH)) {
    try {
      const old = openDb({ readonly: true });
      for (const r of old
        .prepare(
          "SELECT literal, origin_story, origin_story_model, origin_story_reviewed, origin_story_generated_at FROM kanji WHERE origin_story IS NOT NULL AND origin_story_model <> 'manual-seed'",
        )
        .all()) {
        preservedStories.set(r.literal, r);
      }
      for (const t of ["example_words", "kanji_parts", "radicals", "origin_stories"]) {
        try {
          preservedDict[t] = old.prepare(`SELECT * FROM ${t}`).all();
        } catch {
          /* table absent — nothing to carry */
        }
      }
      old.close();
      if (preservedStories.size)
        console.log(`  carrying forward ${preservedStories.size} generated origin stories`);
    } catch (err) {
      console.warn(`  could not read existing DB to preserve content: ${err.message}`);
    }
  }

  // Prefer a clean file; if it's locked (e.g. the web server is running) just
  // rebuild in place — schema.sql drops every table first.
  if (fs.existsSync(DB_PATH)) {
    try {
      fs.rmSync(DB_PATH);
    } catch (err) {
      console.warn(
        `  could not delete ${DB_PATH} (${err.code}); rebuilding in place. Stop the web server for a clean file.`,
      );
    }
  }
  const db = openDb();
  db.exec(fs.readFileSync(SCHEMA_PATH, "utf8")); // drops every table, then recreates

  const fts = hasFts5(db);
  if (fts) {
    db.exec(
      "CREATE VIRTUAL TABLE meanings_fts USING fts5(kanji_literal UNINDEXED, meaning)",
    );
  } else {
    console.warn("  FTS5 unavailable — meaning search will use LIKE fallback.");
  }

  const insKanji = db.prepare(`
    INSERT INTO kanji (literal, codepoint, stroke_count, grade, freq, jlpt, radical_number,
      meanings, on_readings, kun_readings, nanori, svg, svg_static,
      formation_type, formation_type_source,
      origin_story, origin_story_model, origin_story_reviewed, origin_story_generated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const insComp = db.prepare(`
    INSERT INTO components (kanji_literal, order_index, element, position, is_radical, is_phonetic)
    VALUES (?, ?, ?, ?, ?, ?)`);
  const insReading = db.prepare(`
    INSERT INTO readings (reading_kana, reading_type, kanji_literal) VALUES (?, ?, ?)`);
  const insMeaning = db.prepare(`
    INSERT INTO kanji_meanings (kanji_literal, meaning, meaning_lc) VALUES (?, ?, ?)`);
  const insMeaningL10n = db.prepare(`
    INSERT INTO kanji_meanings_l10n (literal, lang, meanings) VALUES (?, ?, ?)`);
  const insFts = fts
    ? db.prepare("INSERT INTO meanings_fts (kanji_literal, meaning) VALUES (?, ?)")
    : null;

  let noVg = 0;
  let seeded = 0;

  db.exec("BEGIN");
  for (const k of kd.kanji) {
    const v = vgByChar.get(k.literal);
    if (!v) noVg++;

    const components = (v?.components ?? []).filter((c) => c.element);
    const formation = classifyFormation(k.literal, components);

    // Preserved generated story wins; otherwise fall back to a hand-written seed.
    const kept = preservedStories.get(k.literal);
    const seed = SEED_STORIES[k.literal] ?? null;
    if (seed && !kept) seeded++;
    const story = kept?.origin_story ?? seed;
    const storyModel = kept?.origin_story_model ?? (seed ? "manual-seed" : null);
    const storyReviewed = kept ? kept.origin_story_reviewed : seed ? 1 : 0;
    const storyAt = kept?.origin_story_generated_at ?? (seed ? new Date().toISOString() : null);

    insKanji.run(
      k.literal,
      v?.codepoint ?? null,
      k.strokeCount ?? v?.strokeCount ?? null,
      k.grade ?? null,
      k.freq ?? null,
      k.jlpt ?? null,
      k.radicalNumber ?? null,
      JSON.stringify(k.meanings ?? []),
      JSON.stringify(k.onReadings ?? []),
      JSON.stringify(k.kunReadings ?? []),
      JSON.stringify(k.nanori ?? []),
      v?.svg ?? null,
      v?.svgStatic ?? null,
      formation.type,
      formation.source,
      story,
      storyModel,
      storyReviewed,
      storyAt,
    );

    components.forEach((c, i) => {
      insComp.run(
        k.literal,
        i,
        c.element,
        c.position ?? null,
        c.isRadical ? 1 : 0,
        c.isPhonetic ? 1 : 0,
      );
    });

    const seen = new Set();
    for (const r of k.onReadings ?? []) {
      const norm = normalizeReading(r);
      const key = `on:${norm}`;
      if (norm && !seen.has(key)) {
        seen.add(key);
        insReading.run(norm, "on", k.literal);
      }
    }
    for (const r of k.kunReadings ?? []) {
      const norm = normalizeReading(r);
      const key = `kun:${norm}`;
      if (norm && !seen.has(key)) {
        seen.add(key);
        insReading.run(norm, "kun", k.literal);
      }
    }

    for (const m of k.meanings ?? []) {
      insMeaning.run(k.literal, m, m.toLowerCase());
      if (insFts) insFts.run(k.literal, m);
    }

    for (const [lang, list] of Object.entries(k.meaningsByLang ?? {})) {
      if (list?.length) insMeaningL10n.run(k.literal, lang, JSON.stringify(list));
    }
  }
  db.exec("COMMIT");

  // Restore carried-forward dictionary enrichment (5-parse-dictionary.js output).
  // schema.sql already re-created these tables (empty) above.
  let restoredDict = 0;
  for (const [table, rows] of Object.entries(preservedDict)) {
    if (!rows?.length) continue;
    const cols = Object.keys(rows[0]).filter((c) => c !== "id");
    const ins = db.prepare(
      `INSERT INTO ${table} (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`,
    );
    db.exec("BEGIN");
    for (const r of rows) ins.run(...cols.map((c) => r[c]));
    db.exec("COMMIT");
    restoredDict += rows.length;
  }
  if (restoredDict) console.log(`  restored ${restoredDict} dictionary rows`);

  const metaRows = [
    ["build_timestamp", new Date().toISOString()],
    ["kanji_count", String(kd.kanji.length)],
    ["kanjidic2_license", kd.meta.license],
    ["kanjidic2_attribution", kd.meta.attribution],
    ["kanjidic2_file_version", kd.meta.fileVersion ?? ""],
    ["kanjidic2_database_version", kd.meta.databaseVersion ?? ""],
    ["kanjivg_license", vg.meta.license],
    ["kanjivg_attribution", vg.meta.attribution],
    ["kanjivg_base_kanji", String(vg.meta.count)],
    ["fts5_enabled", String(fts)],
    ["seed_stories", String(seeded)],
  ];
  const insMeta = db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)");
  for (const [key, value] of metaRows) insMeta.run(key, value);

  const count = db.prepare("SELECT COUNT(*) n FROM kanji").get().n;
  const compCount = db.prepare("SELECT COUNT(*) n FROM components").get().n;
  const readCount = db.prepare("SELECT COUNT(*) n FROM readings").get().n;
  db.close();

  console.log(`\nBuilt ${DB_PATH}`);
  console.log(`  kanji:      ${count}`);
  console.log(`  components: ${compCount}`);
  console.log(`  readings:   ${readCount}`);
  console.log(`  seed origin stories: ${seeded}`);
  if (noVg) console.log(`  ${noVg} kanji had no KanjiVG entry (no stroke diagram)`);
  console.log(`\nNext: npm run web   (or: node pipeline/4-generate-origin-stories.js --dry-run --only 水)`);
}

main();
