/**
 * Step 4b — translate the English origin stories into another language with the
 * Google Gemini API (generous free tier: https://aistudio.google.com/apikey).
 *
 * SCRIPT ONLY. Not part of `npm run pipeline`. Writes to the `origin_stories`
 * table (one row per kanji per non-English language); the English text stays in
 * `kanji.origin_story`. Output is machine translation of machine-generated text
 * and is stored unreviewed.
 *
 * Usage:
 *   node pipeline/4b-translate-stories.js --lang fr --dry-run
 *   node pipeline/4b-translate-stories.js --lang fr --limit 40
 *   node pipeline/4b-translate-stories.js --lang fr            # everything missing
 *   node pipeline/4b-translate-stories.js --lang fr --force    # redo existing
 *
 * Flags:
 *   --lang xx          target language (fr | es | pt | de …)   [required]
 *   --dry-run          print the prompt for one batch, make no API calls
 *   --only a,b,c       restrict to these kanji
 *   --limit N          stop after N kanji
 *   --force            re-translate even if a row already exists
 *   --batch N          kanji per request (default 15)
 *   --rpm N            max requests/minute (default 12; free tier allows ~15)
 *   --model ID         Gemini model (default gemini-flash-lite-latest)
 *
 * API key: GEMINI_API_KEY env var, or pipeline/.gemini_key (git-ignored).
 */
import fs from "node:fs";
import { openDb } from "./lib/db.js";
import { DB_PATH } from "./lib/paths.js";
import {
  GEMINI_MODEL_DEFAULT as MODEL_DEFAULT,
  readGeminiKey,
  callGeminiJson,
  sleep,
} from "./lib/gemini.js";

const LANG_NAMES = { fr: "French", es: "Spanish", pt: "Portuguese", de: "German", ja: "Japanese" };

// Keep kanji-etymology jargon consistent with web/locales/<lang>.json.
const GLOSSARY = {
  fr: '"sound hint" → « indice phonétique » ; "radical" → « radical » ; "component" → « composant » ; "meaning part" → « élément de sens » ; "stroke(s)" → « trait(s) » ; "stroke order" → « ordre des traits » ; "pictograph" → « pictogramme »',
  es: '"sound hint" → «pista fonética»; "radical" → «radical»; "component" → «componente»; "meaning part" → «parte de significado»; "stroke(s)" → «trazo(s)»; "stroke order" → «orden de trazos»; "pictograph" → «pictograma»',
  pt: '"sound hint" → «pista fonética»; "radical" → «radical»; "component" → «componente»; "meaning part" → «parte de significado»; "stroke(s)" → «traço(s)»; "stroke order" → «ordem dos traços»; "pictograph" → «pictograma»',
  de: '"sound hint" → „Lauthinweis“; "radical" → „Radikal“; "component" → „Bestandteil“; "meaning part" → „Bedeutungsteil“; "stroke(s)" → „Strich(e)“; "stroke order" → „Strichreihenfolge“; "pictograph" → „Piktogramm“',
  ja: '"sound hint" → 「音符」; "radical" → 「部首」; "component" → 「構成要素」; "meaning part" → 「意符」; "stroke(s)" → 「画」; "stroke order" → 「筆順」; "pictograph" → 「象形文字」; "compound ideograph" → 「会意文字」; "phono-semantic" → 「形声文字」',
};

function parseArgs(argv) {
  const a = { batch: 15, rpm: 12, model: MODEL_DEFAULT };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--dry-run") a.dryRun = true;
    else if (arg === "--force") a.force = true;
    else if (arg === "--lang") a.lang = argv[++i];
    else if (arg === "--only") a.only = argv[++i]?.split(",").map((s) => s.trim()).filter(Boolean);
    else if (arg === "--limit") a.limit = Number(argv[++i]);
    else if (arg === "--batch") a.batch = Math.max(1, Number(argv[++i]) || 15);
    else if (arg === "--rpm") a.rpm = Math.max(1, Number(argv[++i]) || 12);
    else if (arg === "--model") a.model = argv[++i];
    else console.warn(`  ignoring unknown arg: ${arg}`);
  }
  return a;
}

function buildPrompt(langName, glossary, batch) {
  const obj = {};
  for (const r of batch) obj[r.literal] = r.origin_story;
  const jaNote =
    langName === "Japanese"
      ? `- Write in plain, neutral Japanese (です・ます調), the register of a school kanji reference. ` +
        `Do not add honorifics, filler, or commentary the English text doesn't have.\n`
      : "";
  return (
    `Translate each of the following English texts into natural, fluent ${langName}. ` +
    `They are short, plain-language explanations of the origins of Japanese kanji, ` +
    `written for learners with no background in linguistics.\n\n` +
    `Rules:\n` +
    `- Preserve meaning, tone and register. Plain and clear, not academic.\n` +
    `- Keep every Japanese character (kanji, kana) exactly as written.\n` +
    `- Use this terminology: ${glossary}.\n` +
    jaNote +
    `- Translate only — do not add, drop, or explain anything.\n` +
    `- Return ONLY a JSON object mapping each key to its ${langName} translation, ` +
    `with exactly the same keys as the input.\n\n` +
    `Input:\n${JSON.stringify(obj, null, 1)}`
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.lang || !LANG_NAMES[args.lang]) {
    console.error(`--lang is required, one of: ${Object.keys(LANG_NAMES).join(", ")}`);
    process.exit(1);
  }
  if (!fs.existsSync(DB_PATH)) {
    console.error(`Missing ${DB_PATH} — run: npm run pipeline:build`);
    process.exit(1);
  }
  const langName = LANG_NAMES[args.lang];
  const glossary = GLOSSARY[args.lang];

  const db = openDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS origin_stories (
      literal TEXT NOT NULL, lang TEXT NOT NULL, story TEXT NOT NULL,
      model TEXT, generated_at TEXT, PRIMARY KEY (literal, lang))`);

  const where = ["origin_story IS NOT NULL", "origin_story <> ''"];
  const params = [];
  if (args.only) {
    where.push(`literal IN (${args.only.map(() => "?").join(",")})`);
    params.push(...args.only);
  }
  if (!args.force) {
    where.push("literal NOT IN (SELECT literal FROM origin_stories WHERE lang = ?)");
    params.push(args.lang);
  }
  let sql = `SELECT literal, origin_story FROM kanji WHERE ${where.join(" AND ")} ORDER BY (freq IS NULL), freq, literal`;
  if (args.limit) sql += ` LIMIT ${args.limit}`;
  const rows = db.prepare(sql).all(...params);

  if (!rows.length) {
    console.log(`Nothing to do — every selected kanji already has a ${args.lang} story (use --force to redo).`);
    db.close();
    return;
  }

  const batches = [];
  for (let i = 0; i < rows.length; i += args.batch) batches.push(rows.slice(i, i + args.batch));
  console.log(`${rows.length} stories to translate → ${args.lang} (${langName})`);
  console.log(`Model: ${args.model} · ${batches.length} requests of ≤${args.batch} · ~${args.rpm} req/min`);

  if (args.dryRun) {
    console.log("\n--- DRY RUN: prompt for batch 1 ---\n");
    console.log(buildPrompt(langName, glossary, batches[0]));
    console.log("\n(no API calls made)");
    db.close();
    return;
  }

  const key = readGeminiKey();
  const upsert = db.prepare(`
    INSERT INTO origin_stories (literal, lang, story, model, generated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(literal, lang) DO UPDATE SET
      story = excluded.story, model = excluded.model, generated_at = excluded.generated_at`);

  const minGap = Math.ceil(60000 / args.rpm);
  let done = 0;
  let failed = 0;
  const now = new Date().toISOString();

  // Translate one list of rows; on a parse error, split and recurse once so a
  // single bad quote doesn't lose 20 stories.
  async function translateGroup(rows, depth = 0) {
    try {
      const out = await callGeminiJson(args.model, key, buildPrompt(langName, glossary, rows));
      const missing = [];
      for (const r of rows) {
        const s = out[r.literal];
        if (typeof s === "string" && s.trim()) {
          upsert.run(r.literal, args.lang, s.trim(), args.model, now);
          done++;
        } else {
          missing.push(r);
        }
      }
      if (missing.length && depth < 2 && missing.length < rows.length) {
        await translateGroup(missing, depth + 1);
      } else {
        for (const r of missing) { failed++; console.error(`  ! ${r.literal}: missing in response`); }
      }
    } catch (err) {
      if (depth < 2 && rows.length > 1) {
        const mid = Math.ceil(rows.length / 2);
        console.warn(`  retrying batch of ${rows.length} as 2 (${err.message.slice(0, 60)})`);
        await translateGroup(rows.slice(0, mid), depth + 1);
        await translateGroup(rows.slice(mid), depth + 1);
      } else {
        for (const r of rows) { failed++; console.error(`  ! ${r.literal}: ${err.message}`); }
      }
    }
  }

  for (let b = 0; b < batches.length; b++) {
    const started = Date.now();
    await translateGroup(batches[b]);
    if ((b + 1) % 5 === 0 || b === batches.length - 1) {
      console.log(`  ${b + 1}/${batches.length} requests · ${done} written, ${failed} failed`);
    }
    if (b < batches.length - 1) {
      const elapsed = Date.now() - started;
      if (elapsed < minGap) await sleep(minGap - elapsed);
    }
  }

  const total = db.prepare("SELECT COUNT(*) n FROM origin_stories WHERE lang = ?").get(args.lang).n;
  db.close();
  console.log(`\nDone. ${done} translated, ${failed} failed. ${total} ${args.lang} stories in origin_stories.`);
  console.log("Machine-translated + unreviewed. Restart the web server to see them.");
}

main().catch((err) => {
  console.error("\nFailed:", err.message);
  process.exit(1);
});
