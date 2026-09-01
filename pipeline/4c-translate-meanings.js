/**
 * Step 4c — translate the English per-kanji meaning glosses into another
 * language with Google Gemini (free tier), for languages KANJIDIC2 doesn't
 * ship (i.e. German). Writes JSON arrays to kanji_meanings_l10n.
 *
 * SCRIPT ONLY. Not part of `npm run pipeline`. Re-runnable; skips kanji that
 * already have a row for the language unless --force. Output is machine
 * translation, stored unreviewed.
 *
 * Usage:
 *   node pipeline/4c-translate-meanings.js --lang de --dry-run
 *   node pipeline/4c-translate-meanings.js --lang de
 *   node pipeline/4c-translate-meanings.js --lang de --force
 *
 * Flags: --lang xx (required) · --dry-run · --only a,b · --limit N · --force
 *        --batch N (default 40) · --rpm N (default 12) · --model ID
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

const LANG_NAMES = { fr: "French", es: "Spanish", pt: "Portuguese", de: "German" };

function parseArgs(argv) {
  const a = { batch: 40, rpm: 12, model: MODEL_DEFAULT };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--dry-run") a.dryRun = true;
    else if (arg === "--force") a.force = true;
    else if (arg === "--lang") a.lang = argv[++i];
    else if (arg === "--only") a.only = argv[++i]?.split(",").map((s) => s.trim()).filter(Boolean);
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
  for (const r of batch) obj[r.literal] = r.meanings;
  return (
    `Translate these English kanji meaning glosses into ${langName}. Each kanji ` +
    `maps to a list of short English glosses (dictionary style, usually 1–4 words each).\n\n` +
    `Rules:\n` +
    `- Return ONLY a JSON object: the same kanji keys, each mapped to an array of ` +
    `${langName} glosses — one per input gloss, in the same order and the same count.\n` +
    `- Keep them short and idiomatic for a ${langName} dictionary (in German, ` +
    `capitalise nouns).\n` +
    `- Keep parenthetical notes such as "(no. 61)", "(kokuji)", "(counter)".\n` +
    `- If a gloss is a proper noun or has no good ${langName} equivalent, keep it as is.\n` +
    `- Do not add explanations.\n\n` +
    `Input:\n${JSON.stringify(obj, null, 0)}`
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

  const db = openDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS kanji_meanings_l10n (
      literal TEXT NOT NULL, lang TEXT NOT NULL, meanings TEXT NOT NULL,
      PRIMARY KEY (literal, lang))`);

  const where = ["meanings IS NOT NULL", "meanings <> '[]'"];
  const params = [];
  if (args.only) {
    where.push(`literal IN (${args.only.map(() => "?").join(",")})`);
    params.push(...args.only);
  }
  if (!args.force) {
    where.push("literal NOT IN (SELECT literal FROM kanji_meanings_l10n WHERE lang = ?)");
    params.push(args.lang);
  }
  let sql = `SELECT literal, meanings FROM kanji WHERE ${where.join(" AND ")} ORDER BY (freq IS NULL), freq, literal`;
  if (args.limit) sql += ` LIMIT ${args.limit}`;
  const rows = db
    .prepare(sql)
    .all(...params)
    .map((r) => ({ literal: r.literal, meanings: JSON.parse(r.meanings) }))
    .filter((r) => Array.isArray(r.meanings) && r.meanings.length);

  if (!rows.length) {
    console.log(`Nothing to do — every selected kanji already has ${args.lang} meanings (use --force to redo).`);
    db.close();
    return;
  }

  const batches = [];
  for (let i = 0; i < rows.length; i += args.batch) batches.push(rows.slice(i, i + args.batch));
  console.log(`${rows.length} kanji to translate meanings → ${args.lang} (${langName})`);
  console.log(`Model: ${args.model} · ${batches.length} requests of ≤${args.batch} · ~${args.rpm} req/min`);

  if (args.dryRun) {
    console.log("\n--- DRY RUN: prompt for batch 1 ---\n");
    console.log(buildPrompt(langName, batches[0].slice(0, 6)));
    console.log("\n(no API calls made)");
    db.close();
    return;
  }

  const key = readGeminiKey();
  const upsert = db.prepare(`
    INSERT INTO kanji_meanings_l10n (literal, lang, meanings) VALUES (?, ?, ?)
    ON CONFLICT(literal, lang) DO UPDATE SET meanings = excluded.meanings`);

  const minGap = Math.ceil(60000 / args.rpm);
  let done = 0;
  let failed = 0;

  async function translateGroup(group, depth = 0) {
    try {
      const out = await callGeminiJson(args.model, key, buildPrompt(langName, group));
      const missing = [];
      for (const r of group) {
        const arr = out[r.literal];
        if (Array.isArray(arr) && arr.length && arr.every((x) => typeof x === "string" && x.trim())) {
          upsert.run(r.literal, args.lang, JSON.stringify(arr.map((x) => x.trim())));
          done++;
        } else {
          missing.push(r);
        }
      }
      if (missing.length && depth < 2 && missing.length < group.length) {
        await translateGroup(missing, depth + 1);
      } else {
        for (const r of missing) { failed++; console.error(`  ! ${r.literal}: missing/invalid in response`); }
      }
    } catch (err) {
      if (depth < 2 && group.length > 1) {
        const mid = Math.ceil(group.length / 2);
        console.warn(`  retrying batch of ${group.length} as 2 (${err.message.slice(0, 60)})`);
        await translateGroup(group.slice(0, mid), depth + 1);
        await translateGroup(group.slice(mid), depth + 1);
      } else {
        for (const r of group) { failed++; console.error(`  ! ${r.literal}: ${err.message}`); }
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

  const total = db.prepare("SELECT COUNT(*) n FROM kanji_meanings_l10n WHERE lang = ?").get(args.lang).n;
  db.close();
  console.log(`\nDone. ${done} translated, ${failed} failed. ${total} ${args.lang} kanji have meanings.`);
  console.log("Machine-translated + unreviewed. Rebuild is NOT needed; restart the web server.");
}

main().catch((err) => {
  console.error("\nFailed:", err.message);
  process.exit(1);
});
