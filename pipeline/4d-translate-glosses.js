/**
 * Step 4d — translate the English example-word (jukugo) glosses into another
 * language with Google Gemini (free tier), for languages JMdict has no gloss
 * edition for (i.e. Japanese — jmdict has fre/spa/ger but no jpn/por).
 *
 * SCRIPT ONLY. Not part of `npm run pipeline`. Writes hand-off glosses into
 * pipeline/data/gloss-supplements.json (the committed, reproducible source that
 * 5-parse-dictionary.js applies after the JMdict pass) AND inserts matching
 * `lang` rows straight into data/kanji.db so a rebuild isn't required to see
 * them. Re-runnable and resumable: a word already present in the supplements
 * file for the language is skipped unless --force.
 *
 * Usage:
 *   node pipeline/4d-translate-glosses.js --lang ja --dry-run
 *   node pipeline/4d-translate-glosses.js --lang ja --limit 200
 *   node pipeline/4d-translate-glosses.js --lang ja            # everything missing
 *   node pipeline/4d-translate-glosses.js --lang ja --force    # redo existing
 *
 * Flags: --lang xx (required) · --dry-run · --limit N · --force
 *        --batch N (default 40) · --rpm N (default 12) · --model ID
 *
 * API key: GEMINI_API_KEY env var, or pipeline/.gemini_key (git-ignored).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openDb } from "./lib/db.js";
import { DB_PATH } from "./lib/paths.js";
import {
  GEMINI_MODEL_DEFAULT as MODEL_DEFAULT,
  readGeminiKey,
  callGeminiJson,
  sleep,
} from "./lib/gemini.js";

const LANG_NAMES = { ja: "Japanese", pt: "Portuguese" };
const here = path.dirname(fileURLToPath(import.meta.url));
const SUP_PATH = path.join(here, "data", "gloss-supplements.json");

function parseArgs(argv) {
  const a = { batch: 40, rpm: 12, model: MODEL_DEFAULT };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--dry-run") a.dryRun = true;
    else if (arg === "--force") a.force = true;
    else if (arg === "--lang") a.lang = argv[++i];
    else if (arg === "--limit") a.limit = Number(argv[++i]);
    else if (arg === "--batch") a.batch = Math.max(1, Number(argv[++i]) || 40);
    else if (arg === "--rpm") a.rpm = Math.max(1, Number(argv[++i]) || 12);
    else if (arg === "--model") a.model = argv[++i];
    else console.warn(`  ignoring unknown arg: ${arg}`);
  }
  return a;
}

function buildPrompt(langName, batch) {
  const obj = {};
  for (const r of batch) obj[r.word] = r.gloss;
  const jaNote =
    langName === "Japanese"
      ? `- Give a concise Japanese definition of the word — the register of a 国語辞典 entry, ` +
        `not a word-for-word gloss. Keep the ";" sense separator and parenthetical notes. ` +
        `It is fine if the definition restates the word.\n`
      : `- Keep it short and idiomatic; preserve the ";" sense separator and parenthetical notes.\n`;
  return (
    `Translate each of these Japanese dictionary words' English glosses into ${langName}. ` +
    `The key is the Japanese headword; the value is its short English gloss.\n\n` +
    `Rules:\n` +
    `- Return ONLY a JSON object with exactly the same keys, each mapped to the ${langName} text.\n` +
    jaNote +
    `- Correct an obviously wrong English gloss rather than translating the error.\n` +
    `- Do not add explanations or romaji.\n\n` +
    `Input:\n${JSON.stringify(obj, null, 0)}`
  );
}

function loadSup() {
  return JSON.parse(fs.readFileSync(SUP_PATH, "utf8"));
}

/** Rewrite gloss-supplements.json with `_note` first, then language keys A→Z, keys sorted. */
function writeSup(sup) {
  const ordered = { _note: sup._note };
  for (const lang of Object.keys(sup).filter((k) => k !== "_note").sort()) {
    const entries = sup[lang];
    const sorted = {};
    for (const k of Object.keys(entries).sort()) sorted[k] = entries[k];
    ordered[lang] = sorted;
  }
  fs.writeFileSync(SUP_PATH, JSON.stringify(ordered, null, 2) + "\n");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.lang || !LANG_NAMES[args.lang]) {
    console.error(`--lang is required, one of: ${Object.keys(LANG_NAMES).join(", ")}`);
    process.exit(1);
  }
  if (!fs.existsSync(DB_PATH)) {
    console.error(`Missing ${DB_PATH} — run: npm run pipeline`);
    process.exit(1);
  }
  const langName = LANG_NAMES[args.lang];

  const db = openDb();
  const hasEx = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='example_words'")
    .get();
  if (!hasEx) {
    console.error("No example_words table — run: npm run pipeline:dictionary");
    process.exit(1);
  }

  const sup = loadSup();
  if (!sup[args.lang]) sup[args.lang] = {};
  const have = new Set(args.force ? [] : Object.keys(sup[args.lang]));

  // The distinct English-selected words + their gloss (one gloss per word).
  const allWords = db
    .prepare("SELECT word, gloss FROM example_words WHERE lang='en' GROUP BY word ORDER BY word")
    .all();
  let rows = allWords.filter((r) => !have.has(r.word));
  if (args.limit) rows = rows.slice(0, args.limit);

  if (!rows.length) {
    console.log(`Nothing to do — all ${allWords.length} words already have ${args.lang} glosses (use --force to redo).`);
    db.close();
    return;
  }

  const batches = [];
  for (let i = 0; i < rows.length; i += args.batch) batches.push(rows.slice(i, i + args.batch));
  console.log(`${rows.length} / ${allWords.length} glosses to translate → ${args.lang} (${langName})`);
  console.log(`Model: ${args.model} · ${batches.length} requests of ≤${args.batch} · ~${args.rpm} req/min`);

  if (args.dryRun) {
    console.log("\n--- DRY RUN: prompt for batch 1 ---\n");
    console.log(buildPrompt(langName, batches[0].slice(0, 12)));
    console.log("\n(no API calls made)");
    db.close();
    return;
  }

  const key = readGeminiKey();

  // Insert lang rows mirroring the English slots for one word.
  const enSlots = db.prepare(
    "SELECT kanji_literal, reading, priority, order_index FROM example_words WHERE lang='en' AND word=?",
  );
  const exists = db.prepare(
    "SELECT 1 FROM example_words WHERE lang=? AND word=? AND kanji_literal=? LIMIT 1",
  );
  const insRow = db.prepare(
    "INSERT INTO example_words (kanji_literal, lang, word, reading, gloss, priority, order_index) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  const applyWord = (word, gloss) => {
    sup[args.lang][word] = gloss;
    db.exec("BEGIN");
    for (const s of enSlots.all(word)) {
      if (exists.get(args.lang, word, s.kanji_literal)) continue;
      insRow.run(s.kanji_literal, args.lang, word, s.reading, gloss, s.priority, s.order_index);
    }
    db.exec("COMMIT");
  };

  const minGap = Math.ceil(60000 / args.rpm);
  let done = 0;
  let failed = 0;

  async function translateGroup(group, depth = 0) {
    try {
      const out = await callGeminiJson(args.model, key, buildPrompt(langName, group));
      const missing = [];
      for (const r of group) {
        const g = out[r.word];
        if (typeof g === "string" && g.trim()) {
          applyWord(r.word, g.trim());
          done++;
        } else {
          missing.push(r);
        }
      }
      if (missing.length && depth < 2 && missing.length < group.length) {
        await translateGroup(missing, depth + 1);
      } else {
        for (const r of missing) { failed++; console.error(`  ! ${r.word}: missing in response`); }
      }
    } catch (err) {
      if (depth < 2 && group.length > 1) {
        const mid = Math.ceil(group.length / 2);
        console.warn(`  retrying batch of ${group.length} as 2 (${err.message.slice(0, 60)})`);
        await translateGroup(group.slice(0, mid), depth + 1);
        await translateGroup(group.slice(mid), depth + 1);
      } else {
        for (const r of group) { failed++; console.error(`  ! ${r.word}: ${err.message}`); }
      }
    }
  }

  for (let b = 0; b < batches.length; b++) {
    const started = Date.now();
    await translateGroup(batches[b]);
    writeSup(sup); // persist progress after every request-group
    if ((b + 1) % 5 === 0 || b === batches.length - 1) {
      console.log(`  ${b + 1}/${batches.length} requests · ${done} written, ${failed} failed`);
    }
    if (b < batches.length - 1) {
      const elapsed = Date.now() - started;
      if (elapsed < minGap) await sleep(minGap - elapsed);
    }
  }

  const total = Object.keys(sup[args.lang]).length;
  const dbRows = db.prepare("SELECT COUNT(*) n FROM example_words WHERE lang=?").get(args.lang).n;
  db.close();
  console.log(`\nDone. ${done} translated, ${failed} failed.`);
  console.log(`gloss-supplements.json[${args.lang}]: ${total} words · example_words(${args.lang}): ${dbRows} rows.`);
  console.log("Machine-translated + unreviewed. Restart the web server to see them.");
}

main().catch((err) => {
  console.error("\nFailed:", err.message);
  process.exit(1);
});
