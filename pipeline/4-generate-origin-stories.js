/**
 * Step 4 — generate a short origin story for each kanji with the Claude API.
 *
 * SCRIPT ONLY. Nothing else runs this. It is not part of `npm run pipeline`.
 * Every run that isn't --dry-run spends real API credit (Haiku, ~US$2–3 for the
 * full ~2,136-kanji set). Output is LLM-generated and stored unreviewed
 * (origin_story_reviewed = 0) — spot-check before trusting it.
 *
 * Usage:
 *   node pipeline/4-generate-origin-stories.js --dry-run --only 水,清
 *   node pipeline/4-generate-origin-stories.js --only 水,木,人,清,晴
 *   node pipeline/4-generate-origin-stories.js --limit 50
 *   node pipeline/4-generate-origin-stories.js                 # everything missing
 *   node pipeline/4-generate-origin-stories.js --force --only 水 # regenerate
 *
 * Flags:
 *   --dry-run          build prompts + print a cost estimate, make no API calls
 *   --only a,b,c       restrict to these kanji
 *   --limit N          stop after N kanji
 *   --concurrency N    parallel requests (default 4)
 *   --force            regenerate even if a story already exists
 *   --model ID         override the model (default claude-haiku-4-5)
 */
import fs from "node:fs";
import path from "node:path";
import { openDb } from "./lib/db.js";
import { DB_PATH, ROOT } from "./lib/paths.js";
import { FORMATION_LABELS } from "./lib/formation.js";

const MODEL_DEFAULT = "claude-haiku-4-5";
const MAX_TOKENS = 400;
// Haiku 4.5 list price, US$ per 1M tokens.
const PRICE_IN = 1.0;
const PRICE_OUT = 5.0;

function parseArgs(argv) {
  const a = { concurrency: 4, model: MODEL_DEFAULT };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--dry-run") a.dryRun = true;
    else if (arg === "--force") a.force = true;
    else if (arg === "--only") a.only = argv[++i]?.split(",").map((s) => s.trim()).filter(Boolean);
    else if (arg === "--limit") a.limit = Number(argv[++i]);
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
  throw new Error(
    "No API key: set ANTHROPIC_API_KEY or provide ../arbitrage-bot/api_key.txt",
  );
}

const SYSTEM_PROMPT = `You explain the origins of Japanese kanji to people with no background in linguistics or Chinese characters.

Given a kanji with its visual components, its meanings, and a (rough, automatically guessed) formation type, write a SHORT explanation — 3 to 5 sentences — of how the character's shape came to carry its meaning.

Rules:
- Plain, concrete language. No jargon ("logograph", "phonophoric", "radical" are fine only if you immediately explain them). Do not use markdown.
- If the formation type is "phono-semantic": say clearly which component is a SOUND hint — it tells you roughly how the character is pronounced, not what it means. Do not invent a meaning-based story for that component.
- If the formation type is "compound-ideographic": explain how the meanings of the parts combine.
- If "pictographic-or-simple": describe what object or idea the strokes are a picture of.
- The formation type is an automated guess and may be wrong. Hedge where appropriate ("appears to", "most likely"). Do not state invented historical facts as certain.
- Output only the explanation. No preamble, no title, no bullet points.`;

function buildUserPrompt(k, components) {
  const lines = [];
  lines.push(`Kanji: ${k.literal}`);
  lines.push(`Meanings: ${JSON.parse(k.meanings).slice(0, 6).join(", ") || "(none recorded)"}`);
  const on = JSON.parse(k.on_readings);
  const kun = JSON.parse(k.kun_readings);
  if (on.length) lines.push(`On'yomi (Chinese-derived readings): ${on.join(", ")}`);
  if (kun.length) lines.push(`Kun'yomi (native Japanese readings): ${kun.join(", ")}`);
  lines.push(`Stroke count: ${k.stroke_count ?? "?"}`);
  lines.push(`Formation type (automated guess): ${FORMATION_LABELS[k.formation_type] ?? k.formation_type}`);
  if (components.length) {
    lines.push("Components:");
    for (const c of components) {
      const tags = [];
      if (c.is_phonetic) tags.push("SOUND HINT — indicates pronunciation, not meaning");
      if (c.is_radical) tags.push("classifying radical");
      if (c.position) tags.push(`position: ${c.position}`);
      lines.push(`  - ${c.element}${tags.length ? ` (${tags.join("; ")})` : ""}`);
    }
  } else {
    lines.push("Components: none recorded (treat as a single indivisible shape)");
  }
  return lines.join("\n");
}

function estimateTokens(str) {
  return Math.ceil(str.length / 3.5); // rough; kanji/kana cost more per char
}

const commas = (n) => Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!fs.existsSync(DB_PATH)) {
    console.error(`Missing ${DB_PATH} — run: npm run pipeline:build`);
    process.exit(1);
  }

  const db = openDb();
  let sql = "SELECT * FROM kanji";
  const where = [];
  if (!args.force) where.push("(origin_story IS NULL OR origin_story = '')");
  if (args.only) where.push(`literal IN (${args.only.map(() => "?").join(",")})`);
  if (where.length) sql += " WHERE " + where.join(" AND ");
  sql += " ORDER BY (freq IS NULL), freq, literal";
  if (args.limit) sql += ` LIMIT ${args.limit}`;

  const rows = db.prepare(sql).all(...(args.only ?? []));
  const compStmt = db.prepare(
    "SELECT element, position, is_radical, is_phonetic FROM components WHERE kanji_literal = ? ORDER BY order_index",
  );

  if (rows.length === 0) {
    console.log("Nothing to do — every selected kanji already has a story (use --force to redo).");
    db.close();
    return;
  }

  const jobs = rows.map((k) => {
    const components = compStmt.all(k.literal);
    return { k, components, user: buildUserPrompt(k, components) };
  });

  const estIn = jobs.reduce((n, j) => n + estimateTokens(SYSTEM_PROMPT + j.user), 0);
  const estOut = jobs.length * 170;
  const estCost = (estIn / 1e6) * PRICE_IN + (estOut / 1e6) * PRICE_OUT;
  console.log(`Kanji to process: ${jobs.length}`);
  console.log(`Model: ${args.model}`);
  console.log(
    `Rough estimate: ~${commas(estIn)} input + ~${commas(estOut)} output tokens ≈ US$${estCost.toFixed(2)}`,
  );

  if (args.dryRun) {
    console.log("\n--- DRY RUN: sample prompt for", jobs[0].k.literal, "---\n");
    console.log("[system]\n" + SYSTEM_PROMPT);
    console.log("\n[user]\n" + jobs[0].user);
    console.log("\n(no API calls made)");
    db.close();
    return;
  }

  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const client = new Anthropic({ apiKey: readApiKey() });

  const update = db.prepare(`
    UPDATE kanji SET origin_story = ?, origin_story_model = ?,
      origin_story_reviewed = 0, origin_story_generated_at = ?
    WHERE literal = ?`);

  let done = 0;
  let failed = 0;
  let tokIn = 0;
  let tokOut = 0;
  const queue = [...jobs];

  async function worker(id) {
    while (queue.length) {
      const job = queue.shift();
      try {
        const res = await client.messages.create({
          model: args.model,
          max_tokens: MAX_TOKENS,
          system: SYSTEM_PROMPT,
          messages: [{ role: "user", content: job.user }],
        });
        const text = res.content
          .filter((b) => b.type === "text")
          .map((b) => b.text)
          .join("")
          .trim();
        if (!text) throw new Error("empty response");
        tokIn += res.usage?.input_tokens ?? 0;
        tokOut += res.usage?.output_tokens ?? 0;
        update.run(text, args.model, new Date().toISOString(), job.k.literal);
        done++;
      } catch (err) {
        failed++;
        console.error(`  ! ${job.k.literal}: ${err.message}`);
      }
      if ((done + failed) % 25 === 0 || queue.length === 0) {
        const cost = (tokIn / 1e6) * PRICE_IN + (tokOut / 1e6) * PRICE_OUT;
        console.log(
          `  ${done + failed}/${jobs.length}  (ok ${done}, failed ${failed})  spent ≈ US$${cost.toFixed(3)}`,
        );
      }
    }
  }

  const n = Math.max(1, Math.min(args.concurrency || 4, 12));
  await Promise.all(Array.from({ length: n }, (_, i) => worker(i)));

  const cost = (tokIn / 1e6) * PRICE_IN + (tokOut / 1e6) * PRICE_OUT;
  console.log(`\nDone. ${done} stories written, ${failed} failed.`);
  console.log(`Tokens: ${commas(tokIn)} in / ${commas(tokOut)} out ≈ US$${cost.toFixed(3)}`);
  console.log("All new stories are unreviewed (origin_story_reviewed = 0). Spot-check them.");
  db.close();
}

main().catch((err) => {
  console.error("\nFailed:", err.message);
  process.exit(1);
});
