import express from "express";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import * as wanakana from "wanakana";
import { openDb } from "../pipeline/lib/db.js";
import { normalizeReading } from "../pipeline/lib/kana.js";
import { FORMATION_LABELS } from "../pipeline/lib/formation.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(here, "..", "data", "kanji.db");

if (!fs.existsSync(DB_PATH)) {
  console.error(
    `\nNo database at ${DB_PATH}.\nRun the pipeline first:\n  npm run pipeline\n`,
  );
  process.exit(1);
}

const db = openDb({ readonly: true, path: DB_PATH });
const FTS = db.prepare("SELECT value FROM meta WHERE key='fts5_enabled'").get()?.value === "true";

const META = Object.fromEntries(
  db.prepare("SELECT key, value FROM meta").all().map((r) => [r.key, r.value]),
);

const POSITION_LABELS = {
  left: "left", right: "right", top: "top", bottom: "bottom",
  "tare": "top-left wrap", "nyo": "bottom-left wrap", "kamae": "enclosure",
  "kamae1": "enclosure", "kamae2": "enclosure",
};

// ---------- queries ----------

const stmts = {
  kanji: db.prepare("SELECT * FROM kanji WHERE literal = ?"),
  components: db.prepare(
    "SELECT element, position, is_radical, is_phonetic FROM components WHERE kanji_literal = ? ORDER BY order_index",
  ),
  readingExact: db.prepare(`
    SELECT DISTINCT k.literal, k.meanings, k.freq
    FROM readings r JOIN kanji k ON k.literal = r.kanji_literal
    WHERE r.reading_kana = ?
    ORDER BY (k.freq IS NULL), k.freq LIMIT 120`),
  readingPrefix: db.prepare(`
    SELECT DISTINCT k.literal, k.meanings, k.freq
    FROM readings r JOIN kanji k ON k.literal = r.kanji_literal
    WHERE r.reading_kana LIKE ? AND r.reading_kana <> ?
    ORDER BY (k.freq IS NULL), k.freq LIMIT 120`),
  meaningLike: db.prepare(`
    SELECT k.literal, k.meanings, k.freq
    FROM kanji k
    WHERE k.literal IN (SELECT kanji_literal FROM kanji_meanings WHERE meaning_lc LIKE ?)
    ORDER BY (k.freq IS NULL), k.freq LIMIT 120`),
};

const meaningFtsStmt = FTS
  ? db.prepare(`
      SELECT k.literal, k.meanings, k.freq, bm25(meanings_fts) AS rank
      FROM meanings_fts f JOIN kanji k ON k.literal = f.kanji_literal
      WHERE meanings_fts MATCH ?
      GROUP BY k.literal
      ORDER BY rank LIMIT 120`)
  : null;

const randomStmt = db.prepare(
  "SELECT literal, meanings FROM kanji ORDER BY RANDOM() LIMIT ?",
);
const oneKanjiStmt = db.prepare("SELECT literal FROM kanji WHERE literal = ?");

// Dictionary enrichment (5-parse-dictionary.js). Features that need it degrade
// cleanly when it's absent.
const HAS_DICT = !!db
  .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='example_words'")
  .get();

const KANJI_SET = new Set(
  db.prepare("SELECT literal FROM kanji").all().map((r) => r.literal),
);

const dictStmts = HAS_DICT
  ? {
      exampleWords: db.prepare(
        "SELECT word, reading, gloss FROM example_words WHERE kanji_literal = ? ORDER BY order_index LIMIT 8",
      ),
      radicalsAll: db.prepare(
        "SELECT part, display, strokes, joyo_count FROM radicals ORDER BY strokes, joyo_count DESC",
      ),
      // Whole-word lookup (a word appears once per constituent kanji, so DISTINCT).
      wordEntries: db.prepare(
        "SELECT DISTINCT reading, gloss FROM example_words WHERE word = ? ORDER BY reading",
      ),
      wordExists: db.prepare("SELECT 1 FROM example_words WHERE word = ? LIMIT 1"),
      // Find words by their exact kana reading (for kana / romaji searches).
      // Single-character "words" are skipped — they're just kanji, already
      // covered by the reading index.
      wordsByReading: db.prepare(`
        SELECT word, gloss, MIN(priority) AS priority
        FROM example_words WHERE reading = ? AND length(word) >= 2
        GROUP BY word ORDER BY priority, length(word) LIMIT 20`),
    }
  : null;

const relStmts = {
  samePhonetic: db.prepare(`
    SELECT DISTINCT c.kanji_literal AS literal, k.meanings, k.freq
    FROM components c JOIN kanji k ON k.literal = c.kanji_literal
    WHERE c.element = ? AND c.kanji_literal <> ?
    ORDER BY (k.freq IS NULL), k.freq LIMIT 16`),
  sameRadical: db.prepare(`
    SELECT literal, meanings, freq FROM kanji
    WHERE radical_number = ? AND literal <> ?
    ORDER BY (freq IS NULL), freq LIMIT 16`),
  kanjiComponents: db.prepare(
    "SELECT DISTINCT element FROM components WHERE kanji_literal = ?",
  ),
};

const HTML_ESCAPE = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => HTML_ESCAPE[c]);

/** HTML-escape text, then turn each jōyō-kanji character into a link to its page. */
function linkifyKanji(text) {
  if (!text) return "";
  return escapeHtml(text).replace(/[㐀-鿿]/g, (ch) =>
    KANJI_SET.has(ch)
      ? `<a class="kref" href="/kanji/${encodeURIComponent(ch)}">${ch}</a>`
      : ch,
  );
}

// Hand-picked kanji with clear, visual etymologies — the home-page starting points.
const FEATURED = [..."水火木山川日月人雨花森明"];
const featuredCards = () =>
  FEATURED.filter((c) => oneKanjiStmt.get(c)).map((c) => {
    const row = stmts.kanji.get(c);
    return { literal: c, meaning: snippet(row.meanings, 2) };
  });

function parseKanjiRow(row) {
  if (!row) return null;
  return {
    ...row,
    meanings: JSON.parse(row.meanings),
    on_readings: JSON.parse(row.on_readings),
    kun_readings: JSON.parse(row.kun_readings),
    nanori: JSON.parse(row.nanori),
    formation_label: FORMATION_LABELS[row.formation_type] ?? row.formation_type,
  };
}

/** The reading to show for a kanji in compact contexts (cards, SEO). */
function primaryReading(k) {
  // A clean, standalone kun reading (みず, やま) reads best; if the first kun is
  // tied to okurigana (明かり, 語る) fall back to the on reading (メイ, ゴ).
  const kun0 = k.kun_readings[0] || "";
  if (kun0 && !/[.\-]/.test(kun0)) return kun0;
  return k.on_readings[0] || kun0 || "";
}

/** Compact card data for one kanji — used in the word-breakdown view. */
function kanjiCard(literal) {
  const row = parseKanjiRow(stmts.kanji.get(literal));
  if (!row) return null;
  return {
    literal: row.literal,
    meaning: row.meanings.slice(0, 3).join(", "),
    reading: primaryReading(row),
  };
}

function snippet(meaningsJson, n = 4) {
  try {
    return JSON.parse(meaningsJson).slice(0, n).join(", ");
  } catch {
    return "";
  }
}

function toResultList(rows) {
  return rows.map((r) => ({
    literal: r.literal,
    meaning: snippet(r.meanings),
  }));
}

function searchMeaning(q) {
  const clean = q.trim().toLowerCase();
  if (!clean) return [];
  if (meaningFtsStmt) {
    const tokens = clean.split(/[^a-z0-9]+/i).filter(Boolean);
    if (tokens.length) {
      const match = tokens.map((t) => `"${t}"`).join(" ") + (tokens.length === 1 ? ` OR "${tokens[0]}"*` : "");
      try {
        const rows = meaningFtsStmt.all(match);
        if (rows.length) return toResultList(rows);
      } catch {
        /* fall through to LIKE */
      }
    }
  }
  return toResultList(stmts.meaningLike.all(`%${clean}%`));
}

function searchReading(input) {
  // Accept kana directly, or romaji (convert with wanakana).
  let kana = input.trim();
  if (/[a-z]/i.test(kana)) kana = wanakana.toKana(kana, { IMEMode: false });
  const norm = normalizeReading(kana);
  if (!norm) return { kana, results: [] };
  const exact = stmts.readingExact.all(norm);
  const seen = new Set(exact.map((r) => r.literal));
  const prefix = stmts.readingPrefix
    .all(`${norm}%`, norm)
    .filter((r) => !seen.has(r.literal));
  // Exact reading first, then longer readings that start with it.
  return { kana: norm, results: toResultList([...exact, ...prefix].slice(0, 150)) };
}

/**
 * One query, everything related: any kanji characters typed directly, kanji
 * whose English meaning matches, and kanji with a matching reading (kana typed
 * directly, or romaji converted to kana). No search-type switch.
 */
function unifiedSearch(q) {
  const raw = q.trim();
  const directSet = new Set();
  const direct = [];
  for (const ch of raw) {
    if (wanakana.isKanji(ch) && !directSet.has(ch)) {
      const k = lookupKanji(ch);
      if (k) {
        directSet.add(ch);
        direct.push({ literal: k.literal, meaning: k.meanings.slice(0, 4).join(", ") });
      }
    }
  }

  let meaning = [];
  if (/[a-z]/i.test(raw)) meaning = searchMeaning(raw);

  let reading = [];
  let readingKana = null;
  let kana = null;
  if (raw && wanakana.isKana(raw)) {
    kana = raw;
  } else if (/^[a-z][a-z'\- ]*$/i.test(raw)) {
    const converted = wanakana.toKana(raw.toLowerCase(), { IMEMode: false });
    if (wanakana.isKana(converted)) kana = converted;
  }
  let words = [];
  if (kana) {
    const r = searchReading(kana);
    readingKana = r.kana;
    reading = r.results;
    words = searchWordsByReading(readingKana || kana);
  }

  meaning = meaning.filter((c) => !directSet.has(c.literal));
  reading = reading.filter((c) => !directSet.has(c.literal));

  return { query: raw, direct, meaning, reading, words, readingKana };
}

/** Multi-character words (jukugo) whose exact kana reading matches the query. */
function searchWordsByReading(kana) {
  if (!dictStmts) return [];
  const norm = (kana || "").trim();
  if (!norm) return [];
  return dictStmts.wordsByReading.all(norm).map((r) => ({ word: r.word, gloss: r.gloss }));
}

/**
 * If `s` (a trimmed query or URL segment) should be handled as a whole word,
 * return its `/word/` path; otherwise null. A word here is a run of 2+ kanji
 * (no kana / romaji / English) that is either a real JMdict headword or a
 * sequence of jōyō kanji we can at least break down.
 */
function wordRedirectPath(s) {
  const chars = [...s];
  if (chars.length < 2 || !chars.every((c) => wanakana.isKanji(c))) return null;
  const isWord = !!(dictStmts && dictStmts.wordExists.get(s));
  if (isWord || chars.every((c) => KANJI_SET.has(c))) {
    return `/word/${encodeURIComponent(s)}`;
  }
  return null;
}

function toChips(rows, exclude = new Set()) {
  return rows
    .filter((r) => !exclude.has(r.literal))
    .map((r) => ({ literal: r.literal, meaning: snippet(r.meanings, 2) }));
}

function lookupKanji(literal) {
  const row = parseKanjiRow(stmts.kanji.get(literal));
  if (!row) return null;
  const components = stmts.components.all(literal).map((c) => ({
    element: c.element,
    position: c.position,
    positionLabel: c.position ? POSITION_LABELS[c.position] ?? c.position : null,
    isRadical: !!c.is_radical,
    isPhonetic: !!c.is_phonetic,
    role: c.is_phonetic ? "sound hint" : c.is_radical ? "radical" : "meaning part",
  }));

  // Example words + related-kanji rails.
  const exampleWords = dictStmts ? dictStmts.exampleWords.all(literal) : [];

  const exclude = new Set([literal]);
  const phoneticEls = [...new Set(components.filter((c) => c.isPhonetic).map((c) => c.element))];
  const samePhonetic = [];
  for (const el of phoneticEls) {
    for (const r of relStmts.samePhonetic.all(el, literal)) samePhonetic.push(r);
  }
  const samePhoneticChips = toChips(dedupeByLiteral(samePhonetic), exclude);
  samePhoneticChips.forEach((c) => exclude.add(c.literal));

  const sameRadical = row.radical_number
    ? toChips(relStmts.sameRadical.all(row.radical_number, literal), exclude)
    : [];
  sameRadical.forEach((c) => exclude.add(c.literal));

  // "shares components" — kanji sharing a meaningful component that ISN'T this
  // kanji's radical or sound hint (those already have their own rails above).
  const skipEls = new Set([
    literal,
    ...components.filter((c) => c.isRadical).map((c) => c.element),
    ...phoneticEls,
  ]);
  const myEls = relStmts.kanjiComponents
    .all(literal)
    .map((r) => r.element)
    .filter((e) => e && !skipEls.has(e) && !GENERIC_ELEMENTS.has(e));
  let sharesComponents = [];
  if (myEls.length) {
    const placeholders = myEls.map(() => "?").join(",");
    const rows = db
      .prepare(`
        SELECT c.kanji_literal AS literal, k.meanings, k.freq, COUNT(DISTINCT c.element) AS shared
        FROM components c JOIN kanji k ON k.literal = c.kanji_literal
        WHERE c.element IN (${placeholders}) AND c.kanji_literal <> ?
        GROUP BY c.kanji_literal
        ORDER BY shared DESC, (k.freq IS NULL), k.freq
        LIMIT 20`)
      .all(...myEls, literal);
    sharesComponents = toChips(rows, exclude).slice(0, 12);
  }

  return {
    ...row,
    components,
    exampleWords,
    samePhonetic: samePhoneticChips.slice(0, 14),
    samePhoneticLabels: phoneticEls,
    sameRadical: sameRadical.slice(0, 14),
    sharesComponents,
  };
}

function dedupeByLiteral(rows) {
  const seen = new Set();
  const out = [];
  for (const r of rows) {
    if (seen.has(r.literal)) continue;
    seen.add(r.literal);
    out.push(r);
  }
  return out;
}

// KanjiVG component elements too structural/common to be a useful "shares
// components" signal on their own (single strokes, generic enclosures, …).
const GENERIC_ELEMENTS = new Set([..."一丨丶丿乀乁乚亅乙二亠八丷冂冖冫凵勹匚厂厶マノ"]);

// ---------- app ----------

const app = express();
app.set("view engine", "ejs");
app.set("views", path.join(here, "views"));
app.locals.linkifyKanji = linkifyKanji;
app.locals.SITE_NAME = "Kanji Decipher";
app.locals.CONTACT_EMAIL = "p.kaouri@gmail.com";

// The service worker must be revalidated on every load (so updates ship) and be
// allowed to control the whole origin. Add those headers, then let express.static
// serve the file itself.
app.use("/sw.js", (req, res, next) => {
  res.set("Cache-Control", "no-cache");
  res.set("Service-Worker-Allowed", "/");
  next();
});

app.use(express.static(path.join(here, "public")));

// Absolute-URL helpers for canonical tags, Open Graph, sitemap, robots.
// Prefer SITE_URL in production; otherwise derive from the request Host.
function siteBase(req) {
  if (process.env.SITE_URL) return process.env.SITE_URL.replace(/\/$/, "");
  return `${req.protocol}://${req.get("host")}`;
}
app.use((req, res, next) => {
  const base = siteBase(req);
  res.locals.siteUrl = base;
  res.locals.canonical = base + req.path;
  next();
});

// ---------- per-page SEO (title + meta description) ----------

const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

/** { title, description } for a kanji detail page, built from its data. */
function kanjiSeo(k) {
  const primary = k.meanings[0] || "";
  const reading = primaryReading(k);
  const romaji = reading ? wanakana.toRomaji(reading.replace(/[.\-]/g, "")) : "";
  const paren = romaji || reading;
  const meaningList = k.meanings.slice(0, 3).join(", ");
  return {
    title: `${k.literal}${primary ? ` (${cap(primary)})` : ""}`,
    description:
      `${k.literal}${paren ? ` (${paren})` : ""} means ${meaningList || "—"} — ` +
      `see its origin story, stroke order, readings, and related kanji on Kanji Decipher.`,
  };
}

/** { title, description } for a /word/ page. `entry` = the dictionary hit or null. */
function wordSeo(word, entry, parts) {
  const reading = entry?.reading || "";
  const romaji = reading ? wanakana.toRomaji(reading) : "";
  const paren = romaji || reading;
  const list = parts.length === 2 ? parts.join(" and ") : parts.join(", ");
  return {
    title: `${word}${paren ? ` (${paren})` : ""}`,
    description: entry
      ? `${word}${paren ? ` (${paren})` : ""} means ${entry.gloss || "—"} — ` +
        `see how it breaks down into ${list || "its characters"} on Kanji Decipher.`
      : `“${word}” isn't a dictionary entry, but here's what each of its characters ` +
        `(${parts.join(", ") || "—"}) means, with stroke order and origins on Kanji Decipher.`,
  };
}

const KANJI_COUNT_FMT = Number(META.kanji_count).toLocaleString("en-US");
const PAGE_SEO = {
  browse: {
    title: `Browse all ${KANJI_COUNT_FMT} jōyō kanji`,
    description:
      "Browse and filter every jōyō kanji by grade, former JLPT level, stroke count, or formation type.",
  },
  radicals: {
    title: "Radical & component search",
    description:
      "Find a kanji by picking its visual components. Select one or more radicals to narrow the list.",
  },
  credits: {
    title: "Credits & licences",
    description:
      "The freely-licensed data sources behind Kanji Decipher: KanjiVG, KANJIDIC2, JMdict and KRADFILE.",
  },
  about: {
    title: "About",
    description:
      "What Kanji Decipher is — a free lookup tool for the origins, components, readings and stroke order of the jōyō kanji — and why it exists.",
  },
  privacy: {
    title: "Privacy policy",
    description:
      "How Kanji Decipher handles data: no accounts, no personal data collected today, and how advertising cookies will work once ads are enabled.",
  },
};

app.get("/", (req, res) => {
  res.render("home", { meta: META, featured: featuredCards() });
});

app.get("/about", (req, res) => {
  res.render("about", { ...PAGE_SEO.about });
});

app.get("/privacy", (req, res) => {
  res.render("privacy", { ...PAGE_SEO.privacy });
});

// A random kanji page — the "surprise me" link.
app.get("/random", (req, res) => {
  const row = randomStmt.get(1);
  res.redirect(row ? `/kanji/${encodeURIComponent(row.literal)}` : "/");
});

// A handful of random kanji cards (home-page "explore" refresh).
app.get("/api/random", (req, res) => {
  const n = Math.min(24, Math.max(1, Number(req.query.n) || 12));
  res.set("Cache-Control", "no-store");
  const items = randomStmt.all(n).map((r) => ({
    literal: r.literal,
    meaning: snippet(r.meanings, 2),
  }));
  res.json({ items });
});

app.get("/search", (req, res) => {
  const q = (req.query.q ?? "").toString();
  if (!q.trim()) return res.redirect("/");

  const t = q.trim();

  // A single kanji character: go straight to its page.
  if ([...t].length === 1 && wanakana.isKanji(t)) {
    return res.redirect(`/kanji/${encodeURIComponent(t)}`);
  }

  // A run of 2+ kanji (no kana, no romaji, no English): try it as a whole word.
  const wordPath = wordRedirectPath(t);
  if (wordPath) return res.redirect(wordPath);

  const search = unifiedSearch(q);
  const kanjiTotal = search.direct.length + search.meaning.length + search.reading.length;
  const total = kanjiTotal + search.words.length;

  // Exactly one hit overall: jump straight to it.
  if (total === 1 && search.words.length === 1) {
    return res.redirect(`/word/${encodeURIComponent(search.words[0].word)}`);
  }
  if (total === 1 && kanjiTotal === 1) {
    const only = search.direct[0] || search.meaning[0] || search.reading[0];
    return res.redirect(`/kanji/${encodeURIComponent(only.literal)}`);
  }

  res.render("results", {
    search,
    total,
    title: `Search: “${search.query}”`,
    description: `Kanji related to “${search.query}” on Kanji Decipher.`,
    noindex: true,
  });
});

app.get("/api/search", (req, res) => {
  const q = (req.query.q ?? "").toString();
  if (!q.trim())
    return res.json({ query: "", direct: [], meaning: [], reading: [], words: [], readingKana: null });
  res.json(unifiedSearch(q));
});

// Typeahead: a short, flat, ranked list for the search-bar dropdown.
app.get("/api/suggest", (req, res) => {
  const q = (req.query.q ?? "").toString().trim();
  res.set("Cache-Control", "no-store");
  if (!q) return res.json({ q, kana: null, items: [] });

  const s = unifiedSearch(q);
  const items = [];
  const seen = new Set();
  const add = (it) => {
    const href = it.href || `/kanji/${encodeURIComponent(it.literal)}`;
    if (seen.has(href) || items.length >= 8) return;
    seen.add(href);
    items.push({ literal: it.literal, meaning: it.meaning, reason: it.reason, href });
  };

  s.direct.forEach((r) => add({ ...r, reason: "you typed this" }));
  if (s.readingKana) {
    // Kana / romaji query: whole words and single-kanji readings are the intent.
    s.words.forEach((w) =>
      add({ literal: w.word, meaning: w.gloss, reason: `read ${s.readingKana}`, href: `/word/${encodeURIComponent(w.word)}` }),
    );
    s.reading.forEach((r) => add({ ...r, reason: `read ${s.readingKana}` }));
  } else {
    s.meaning.forEach((r) => add({ ...r, reason: "meaning" }));
  }

  res.json({ q, kana: s.readingKana, items });
});

app.get("/kanji/:char", (req, res) => {
  const char = decodeURIComponent(req.params.char);
  const kanji = lookupKanji(char);
  if (!kanji) {
    // A multi-kanji string landed here (old link, hand-typed URL) — it belongs
    // on the word page.
    const wordPath = wordRedirectPath(char.trim());
    if (wordPath) return res.redirect(301, wordPath);
    return res
      .status(404)
      .render("404", { message: `No jōyō kanji “${char}” in the database.`, title: "Not found", noindex: true });
  }
  res.render("kanji", { kanji, meta: META, ...kanjiSeo(kanji) });
});

// ---------- whole-word lookup ----------

app.get("/word/:word", (req, res) => {
  const word = decodeURIComponent(req.params.word).trim();
  const chars = [...word];

  if (!word) return res.redirect("/");

  // A bare single kanji belongs on the kanji page.
  if (chars.length === 1 && KANJI_SET.has(word)) {
    return res.redirect(`/kanji/${encodeURIComponent(word)}`);
  }

  const entries = dictStmts ? dictStmts.wordEntries.all(word) : [];
  const isExact = entries.length > 0;

  const kanjiChars = chars.filter((c) => wanakana.isKanji(c));
  const isJoyoRun = kanjiChars.length >= 2 && chars.every((c) => KANJI_SET.has(c));

  if (!isExact && !isJoyoRun) {
    return res.status(404).render("404", {
      message: `“${word}” isn't a dictionary word, and it isn't a run of jōyō kanji to break down.`,
      title: "Not found",
      noindex: true,
    });
  }

  // One breakdown card per kanji character, in order, de-duplicated.
  const seen = new Set();
  const breakdown = [];
  for (const c of kanjiChars) {
    if (seen.has(c)) continue;
    seen.add(c);
    const card = kanjiCard(c);
    if (card) breakdown.push(card);
  }

  const parts = breakdown.map((b) => b.literal);
  res.render("word", {
    word,
    entries,
    isExact,
    breakdown,
    meta: META,
    ...wordSeo(word, entries[0] || null, parts),
    // Don't invite crawlers to index unverified kanji combinations.
    noindex: !isExact,
  });
});

// ---------- browse & radical picker ----------

const BROWSE_SORTS = {
  freq: "(freq IS NULL), freq, literal",
  strokes: "stroke_count, (freq IS NULL), freq",
  radical: "radical_number, stroke_count",
};
const BROWSE_PER_PAGE = 60;

app.get("/browse", (req, res) => {
  const where = [];
  const params = [];
  const num = (v) => (v != null && v !== "" && Number.isFinite(Number(v)) ? Number(v) : null);

  const grade = num(req.query.grade);
  const jlpt = num(req.query.jlpt);
  const strokes = num(req.query.strokes);
  const formation = (req.query.formation ?? "").toString();
  const sort = BROWSE_SORTS[req.query.sort] ? req.query.sort : "freq";
  const page = Math.max(1, num(req.query.page) || 1);

  if (grade != null) { where.push("grade = ?"); params.push(grade); }
  if (jlpt != null) { where.push("jlpt = ?"); params.push(jlpt); }
  if (strokes != null) { where.push("stroke_count = ?"); params.push(strokes); }
  if (["phono-semantic", "compound-ideographic", "pictographic-or-simple", "unknown"].includes(formation)) {
    where.push("formation_type = ?");
    params.push(formation);
  }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const total = db.prepare(`SELECT COUNT(*) n FROM kanji ${whereSql}`).get(...params).n;
  const pages = Math.max(1, Math.ceil(total / BROWSE_PER_PAGE));
  const clampedPage = Math.min(page, pages);
  const rows = db
    .prepare(`
      SELECT literal, meanings FROM kanji ${whereSql}
      ORDER BY ${BROWSE_SORTS[sort]}
      LIMIT ? OFFSET ?`)
    .all(...params, BROWSE_PER_PAGE, (clampedPage - 1) * BROWSE_PER_PAGE);

  const strokeCounts = db
    .prepare("SELECT DISTINCT stroke_count s FROM kanji WHERE stroke_count IS NOT NULL ORDER BY s")
    .all()
    .map((r) => r.s);

  res.render("browse", {
    meta: META,
    results: rows.map((r) => ({ literal: r.literal, meaning: snippet(r.meanings, 3) })),
    filters: { grade, jlpt, strokes, formation, sort },
    strokeCounts,
    total,
    page: clampedPage,
    pages,
    query: req.query,
    ...PAGE_SEO.browse,
    noindex: Object.keys(req.query).length > 0,
  });
});

app.get("/radicals", (req, res) => {
  if (!HAS_DICT) {
    return res.render("radicals", { meta: META, groups: null, ...PAGE_SEO.radicals });
  }
  const rows = dictStmts.radicalsAll.all();
  const groups = [];
  let cur = null;
  for (const r of rows) {
    if (!cur || cur.strokes !== r.strokes) {
      cur = { strokes: r.strokes, parts: [] };
      groups.push(cur);
    }
    cur.parts.push({ part: r.part, display: r.display || r.part, count: r.joyo_count });
  }
  res.render("radicals", { meta: META, groups, ...PAGE_SEO.radicals });
});

app.get("/api/by-radicals", (req, res) => {
  res.set("Cache-Control", "no-store");
  const parts = (req.query.parts ?? "")
    .toString()
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!HAS_DICT || !parts.length) return res.json({ parts, items: [] });

  const placeholders = parts.map(() => "?").join(",");
  const rows = db
    .prepare(`
      SELECT kp.kanji_literal AS literal, k.meanings, k.freq
      FROM kanji_parts kp JOIN kanji k ON k.literal = kp.kanji_literal
      WHERE kp.part IN (${placeholders})
      GROUP BY kp.kanji_literal
      HAVING COUNT(DISTINCT kp.part) = ?
      ORDER BY (k.freq IS NULL), k.freq
      LIMIT 400`)
    .all(...parts, parts.length);

  res.json({
    parts,
    items: rows.map((r) => ({ literal: r.literal, meaning: snippet(r.meanings, 3) })),
  });
});

app.get("/credits", (req, res) => {
  res.render("credits", { meta: META, ...PAGE_SEO.credits });
});

// ---------- sitemap + robots ----------

let sitemapCache = null;
app.get("/sitemap.xml", (req, res) => {
  const base = res.locals.siteUrl;
  if (!sitemapCache || sitemapCache.base !== base) {
    const staticPaths = ["/", "/browse", "/radicals", "/about", "/privacy", "/credits"];
    const kanji = db.prepare("SELECT literal FROM kanji ORDER BY (freq IS NULL), freq").all();
    // Only real dictionary headwords — skip unverified kanji combinations.
    const words = HAS_DICT
      ? db.prepare("SELECT DISTINCT word FROM example_words ORDER BY word").all()
      : [];
    const urls = [
      ...staticPaths.map((p) => `${base}${p}`),
      ...kanji.map((k) => `${base}/kanji/${encodeURIComponent(k.literal)}`),
      ...words.map((w) => `${base}/word/${encodeURIComponent(w.word)}`),
    ];
    const xml =
      '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
      urls.map((u) => `  <url><loc>${u}</loc></url>`).join("\n") +
      "\n</urlset>\n";
    sitemapCache = { base, xml };
  }
  res.type("application/xml").send(sitemapCache.xml);
});

app.get("/robots.txt", (req, res) => {
  res.type("text/plain").send(
    `User-agent: *\nAllow: /\nDisallow: /api/\nDisallow: /search\n\nSitemap: ${res.locals.siteUrl}/sitemap.xml\n`,
  );
});

app.use((req, res) => {
  res.status(404).render("404", { message: "Page not found.", title: "Not found", noindex: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Kanji Decipher — http://localhost:${PORT}`);
  console.log(`  ${META.kanji_count} kanji · FTS5 ${FTS ? "on" : "off (LIKE fallback)"}`);
});
