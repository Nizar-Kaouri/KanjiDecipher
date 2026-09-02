/**
 * Step 6 — generate a one-line "why do these characters combine to this meaning"
 * note for each multi-kanji jukugo, with the Claude API.
 *
 * SCRIPT ONLY. Not part of `npm run pipeline`. Every non-dry run spends real API
 * credit (Haiku, ~US$6 for the full ~9,000-word set). Output is LLM-generated,
 * stored unreviewed, in word_origins(word, lang='en', note, notable, …).
 *
 * Each note is tagged `notable`: 0 when the compound is just the obvious sum of
 * its parts (the note is kept but the site doesn't show it), 1 when a character
 * is used in a non-obvious sense or the combination needs explaining. The site
 * shows only notable = 1.
 *
 * Usage:
 *   node pipeline/6-generate-word-origins.js --dry-run --limit 50
 *   node pipeline/6-generate-word-origins.js --only 背信,矛盾
 *   node pipeline/6-generate-word-origins.js --limit 200
 *   node pipeline/6-generate-word-origins.js               # everything missing
 *
 * Flags: --dry-run · --only a,b · --limit N · --force · --batch N (default 10)
 *        --concurrency N (default 4) · --model ID (default claude-haiku-4-5)
 */
import fs from "node:fs";
import path from "node:path";
import { openDb } from "./lib/db.js";
import { DB_PATH, ROOT } from "./lib/paths.js";

const MODEL_DEFAULT = "claude-haiku-4-5";
const MAX_TOKENS = 1500;
const PRICE_IN = 1.0;
const PRICE_OUT = 5.0;
const HAN = /\p{Script=Han}/u;

function parseArgs(argv) {
  const a = { batch: 10, concurrency: 4, model: MODEL_DEFAULT };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--dry-run") a.dryRun = true;
    else if (arg === "--force") a.force = true;
    else if (arg === "--only") a.only = argv[++i]?.split(",").map((s) => s.trim()).filter(Boolean);
    else if (arg === "--limit") a.limit = Number(argv[++i]);
    else if (arg === "--batch") a.batch = Math.max(1, Number(argv[++i]) || 10);
    else if (arg === "--concurrency") a.concurrency = Number(argv[++i]);
    else if (arg === "--model") a.model = argv[++i];
    else console.warn(`  ignoring unknown arg: ${arg}`);
  }
  return a;
}

function readApiKey() {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY.trim();
  const keyFile = path.join(ROOT, "..", "arbitrage-bot", "api_key.txt");
  if (fs.existsSync(keyFile)) return fs.readFileSync(keyFile, "utf8").trim();
  throw new Error("No API key: set ANTHROPIC_API_KEY or provide ../arbitrage-bot/api_key.txt");
}

const SYSTEM_PROMPT = `You explain why Japanese compound words (jukugo) mean what they mean, to learners with no background in Chinese characters.

For each word you are given the reading, its English meaning, and the meanings of each kanji in it. Write ONE plain-language sentence (occasionally two) explaining how the characters combine to produce the meaning — especially when a character is used in a sense that isn't its most common one.

Return ONLY a JSON object mapping each word to an object:
  { "note": "<the sentence>", "notable": <true|false> }

- "notable": true when the note tells the reader something they wouldn't guess from a quick glance at the kanji — a character used figuratively or in a secondary sense, an idiom, a historical image, a non-obvious pairing. false when the word is simply the transparent sum of its parts (電話 = electric + talk = telephone) and the note would be filler.
- Keep "note" concrete and short. No preamble, no "This word...", no markdown. Name the characters by their glyph.
- Do not invent specific historical facts. Hedge naturally ("literally", "the image is", "here X means").
- Every input word must appear as a key.`;

function buildUserPrompt(batch) {
  const items = batch.map((w) => ({
    word: w.word,
    reading: w.reading,
    meaning: w.gloss,
    kanji: [...w.word].filter((c) => HAN.test(c)).map((c) => ({
      c,
      means: (w.kanjiMeanings.get(c) || []).slice(0, 4).join(", ") || "(not in the jōyō set)",
    })),
  }));
  return JSON.stringify(items, null, 1);
}

const commas = (n) => Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
const estTokens = (s) => Math.ceil(s.length / 3.5);

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(DB_PATH)) {
    console.error(`Missing ${DB_PATH} — run: npm run pipeline`);
    process.exit(1);
  }

  const db = openDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS word_origins (
      word TEXT NOT NULL, lang TEXT NOT NULL, note TEXT NOT NULL,
      notable INTEGER NOT NULL DEFAULT 0, model TEXT, generated_at TEXT,
      PRIMARY KEY (word, lang))`);

  const kanjiMeanings = new Map(
    db.prepare("SELECT literal, meanings FROM kanji").all().map((r) => {
      try { return [r.literal, JSON.parse(r.meanings)]; } catch { return [r.literal, []]; }
    }),
  );

  const where = ["lang = 'en'"];
  const params = [];
  if (args.only) {
    where.push(`word IN (${args.only.map(() => "?").join(",")})`);
    params.push(...args.only);
  }
  if (!args.force) where.push("word NOT IN (SELECT word FROM word_origins WHERE lang = 'en')");
  let sql = `SELECT word, MIN(reading) reading, MIN(gloss) gloss
             FROM example_words WHERE ${where.join(" AND ")}
             GROUP BY word ORDER BY word`;
  let rows = db.prepare(sql).all(...params);

  // Only multi-kanji compounds — a single kanji + kana suffix has no "why".
  rows = rows.filter((r) => [...r.word].filter((c) => HAN.test(c)).length >= 2);
  if (args.limit) rows = rows.slice(0, args.limit);

  if (!rows.length) {
    console.log("Nothing to do — every multi-kanji word already has a note (use --force to redo).");
    db.close();
    return;
  }
  for (const r of rows) r.kanjiMeanings = kanjiMeanings;

  const batches = [];
  for (let i = 0; i < rows.length; i += args.batch) batches.push(rows.slice(i, i + args.batch));

  const estIn = batches.reduce((n, b) => n + estTokens(SYSTEM_PROMPT + buildUserPrompt(b)), 0);
  const estOut = rows.length * 70;
  const estCost = (estIn / 1e6) * PRICE_IN + (estOut / 1e6) * PRICE_OUT;
  console.log(`Words to process: ${rows.length}  ·  ${batches.length} requests of ≤${args.batch}`);
  console.log(`Model: ${args.model}`);
  console.log(`Rough estimate: ~${commas(estIn)} in + ~${commas(estOut)} out tokens ≈ US$${estCost.toFixed(2)}`);

  if (args.dryRun) {
    console.log("\n--- DRY RUN: sample request (batch 1) ---\n");
    console.log("[system]\n" + SYSTEM_PROMPT);
    console.log("\n[user]\n" + buildUserPrompt(batches[0]));
    console.log("\n(no API calls made)");
    db.close();
    return;
  }

  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const client = new Anthropic({ apiKey: readApiKey() });
  const upsert = db.prepare(`
    INSERT INTO word_origins (word, lang, note, notable, model, generated_at)
    VALUES (?, 'en', ?, ?, ?, ?)
    ON CONFLICT(word, lang) DO UPDATE SET
      note = excluded.note, notable = excluded.notable,
      model = excluded.model, generated_at = excluded.generated_at`);

  let done = 0;
  let failed = 0;
  let notable = 0;
  let tokIn = 0;
  let tokOut = 0;
  const queue = [...batches];
  const now = () => new Date().toISOString();

  function parseJson(text) {
    const s = text.indexOf("{");
    const e = text.lastIndexOf("}");
    return JSON.parse(s >= 0 && e > s ? text.slice(s, e + 1) : text);
  }

  async function worker() {
    while (queue.length) {
      const batch = queue.shift();
      try {
        const res = await client.messages.create({
          model: args.model,
          max_tokens: MAX_TOKENS,
          system: SYSTEM_PROMPT,
          messages: [{ role: "user", content: buildUserPrompt(batch) }],
        });
        tokIn += res.usage?.input_tokens ?? 0;
        tokOut += res.usage?.output_tokens ?? 0;
        const out = parseJson(res.content.filter((b) => b.type === "text").map((b) => b.text).join(""));
        for (const w of batch) {
          const o = out[w.word];
          if (o && typeof o.note === "string" && o.note.trim()) {
            const isNotable = o.notable === true || o.notable === "true" ? 1 : 0;
            upsert.run(w.word, o.note.trim(), isNotable, args.model, now());
            done++;
            notable += isNotable;
          } else {
            failed++;
            console.error(`  ! ${w.word}: missing/invalid in response`);
          }
        }
      } catch (err) {
        failed += batch.length;
        console.error(`  ! batch (${batch[0].word}…): ${err.message}`);
      }
      if ((done + failed) % 200 < args.batch || !queue.length) {
        const cost = (tokIn / 1e6) * PRICE_IN + (tokOut / 1e6) * PRICE_OUT;
        console.log(`  ${done + failed}/${rows.length}  (ok ${done}, notable ${notable}, failed ${failed})  ≈ US$${cost.toFixed(3)}`);
      }
    }
  }

  const n = Math.max(1, Math.min(args.concurrency || 4, 10));
  await Promise.all(Array.from({ length: n }, () => worker()));

  const cost = (tokIn / 1e6) * PRICE_IN + (tokOut / 1e6) * PRICE_OUT;
  const total = db.prepare("SELECT COUNT(*) n, SUM(notable) s FROM word_origins WHERE lang='en'").get();
  db.close();
  console.log(`\nDone. ${done} notes written (${notable} notable), ${failed} failed.`);
  console.log(`word_origins(en): ${total.n} rows, ${total.s} shown on the site.`);
  console.log(`Tokens: ${commas(tokIn)} in / ${commas(tokOut)} out ≈ US$${cost.toFixed(3)}`);
  console.log("Unreviewed. Restart the web server to see them.");
}

main().catch((err) => {
  console.error("\nFailed:", err.message);
  process.exit(1);
});
