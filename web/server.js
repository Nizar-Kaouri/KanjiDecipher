import express from "express";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import * as wanakana from "wanakana";
import { openDb } from "../pipeline/lib/db.js";
import { normalizeReading } from "../pipeline/lib/kana.js";
import {
  LANGS,
  PREFIXED_LANGS,
  PREFIX_RE,
  isSupported,
  langName,
  langDir,
  coverage,
  translator,
} from "./i18n.js";

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

// ---------- multilingual content (meanings / glosses / origin stories) ----------
// Present only after the pipeline's localisation steps have run. Until then the
// site serves English everywhere and every `lang` argument falls back to it.

const hasTable = (name) =>
  !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
const hasColumn = (table, col) =>
  hasTable(table) &&
  db.prepare(`SELECT 1 FROM pragma_table_info('${table}') WHERE name=?`).get(col);

const safeParse = (s) => {
  try { return JSON.parse(s); } catch { return []; }
};

const EN_MEANINGS = new Map(
  db.prepare("SELECT literal, meanings FROM kanji").all().map((r) => [r.literal, safeParse(r.meanings)]),
);

const HAS_MEANINGS_L10N = hasTable("kanji_meanings_l10n");
const L10N_MEANINGS = new Map(); // lang -> Map(literal -> [string])
if (HAS_MEANINGS_L10N) {
  for (const r of db.prepare("SELECT literal, lang, meanings FROM kanji_meanings_l10n").all()) {
    if (!L10N_MEANINGS.has(r.lang)) L10N_MEANINGS.set(r.lang, new Map());
    L10N_MEANINGS.get(r.lang).set(r.literal, safeParse(r.meanings));
  }
}

// Newspaper-frequency rank per kanji (lower = more common) — the meaning-search
// tie-breaker, mirroring the English FTS ordering.
const FREQ = new Map(db.prepare("SELECT literal, freq FROM kanji").all().map((r) => [r.literal, r.freq]));
const freqRank = (lit) => FREQ.get(lit) ?? 1e9;

/** Meanings array for a kanji in `lang`, falling back to English. */
function meaningsOf(literal, lang = "en") {
  if (lang !== "en") {
    const m = L10N_MEANINGS.get(lang)?.get(literal);
    if (m && m.length) return m;
  }
  return EN_MEANINGS.get(literal) || [];
}
/** First `n` meanings joined — the text shown on a kanji card. */
function meaningText(literal, lang = "en", n = 4) {
  return meaningsOf(literal, lang).slice(0, n).join(", ");
}

const HAS_ORIGIN_L10N = hasTable("origin_stories");
const originStoryStmt = HAS_ORIGIN_L10N
  ? db.prepare("SELECT story FROM origin_stories WHERE literal=? AND lang=?")
  : null;

const EXWORDS_HAS_LANG = !!hasColumn("example_words", "lang");

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
        EXWORDS_HAS_LANG
          ? "SELECT word, reading, gloss FROM example_words WHERE kanji_literal = ? AND lang = ? ORDER BY order_index LIMIT 8"
          : "SELECT word, reading, gloss FROM example_words WHERE kanji_literal = ? ORDER BY order_index LIMIT 8",
      ),
      radicalsAll: db.prepare(
        "SELECT part, display, strokes, joyo_count FROM radicals ORDER BY strokes, joyo_count DESC",
      ),
      // Whole-word lookup (a word appears once per constituent kanji, so DISTINCT).
      wordEntries: db.prepare(
        EXWORDS_HAS_LANG
          ? "SELECT DISTINCT reading, gloss FROM example_words WHERE word = ? AND lang = ? ORDER BY reading"
          : "SELECT DISTINCT reading, gloss FROM example_words WHERE word = ? ORDER BY reading",
      ),
      wordExists: db.prepare("SELECT 1 FROM example_words WHERE word = ? LIMIT 1"),
      // Find words by their exact kana reading (for kana / romaji searches).
      // Single-character "words" are skipped — they're just kanji, already
      // covered by the reading index.
      wordsByReading: db.prepare(
        EXWORDS_HAS_LANG
          ? `SELECT word, gloss, MIN(priority) AS priority
             FROM example_words WHERE reading = ? AND lang = ? AND length(word) >= 2
             GROUP BY word ORDER BY priority, length(word) LIMIT 20`
          : `SELECT word, gloss, MIN(priority) AS priority
             FROM example_words WHERE reading = ? AND length(word) >= 2
             GROUP BY word ORDER BY priority, length(word) LIMIT 20`,
      ),
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
function linkifyKanji(text, lp = "") {
  if (!text) return "";
  return escapeHtml(text).replace(/[㐀-鿿]/g, (ch) =>
    KANJI_SET.has(ch)
      ? `<a class="kref" href="${lp}/kanji/${encodeURIComponent(ch)}">${ch}</a>`
      : ch,
  );
}

// Hand-picked kanji with clear, visual etymologies — the home-page starting points.
const FEATURED = [..."水火木山川日月人雨花森明"];
const featuredCards = (lang = "en") =>
  FEATURED.filter((c) => oneKanjiStmt.get(c)).map((c) => ({
    literal: c,
    meaning: meaningText(c, lang, 2),
  }));

function parseKanjiRow(row, lang = "en") {
  if (!row) return null;
  return {
    ...row,
    meanings: meaningsOf(row.literal, lang),
    meanings_en: safeParse(row.meanings),
    on_readings: JSON.parse(row.on_readings),
    kun_readings: JSON.parse(row.kun_readings),
    nanori: JSON.parse(row.nanori),
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
function kanjiCard(literal, lang = "en") {
  const row = parseKanjiRow(stmts.kanji.get(literal), lang);
  if (!row) return null;
  return {
    literal: row.literal,
    meaning: row.meanings.slice(0, 3).join(", "),
    reading: primaryReading(row),
  };
}

function toResultList(rows, lang = "en") {
  return rows.map((r) => ({
    literal: r.literal,
    meaning: meaningText(r.literal, lang),
  }));
}

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Lower-case + strip diacritics + expand ligatures, so a meaning search matches
// with or without accents ("cafe" ↔ "café", "coracao" ↔ "coração", "cœur" ↔ "coeur").
const foldText = (s) =>
  String(s)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/œ/g, "oe")
    .replace(/æ/g, "ae");

/**
 * Meaning search against a non-English meaning set (kanji_meanings_l10n, held in
 * memory). Returns null when that language has no meaning data, so the caller
 * can fall back to the English gloss search. The corpus is tiny (~6k short
 * strings) so a scan is instant; ranking mimics the English FTS order.
 */
function searchMeaningLocalized(q, lang) {
  const idx = L10N_MEANINGS.get(lang);
  if (!idx) return null;
  const needle = foldText(q.trim());
  if (!needle) return [];
  const words = needle.split(/\s+/).filter(Boolean);
  // CJK meaning queries have no word boundaries, so \b-style matching never
  // fires; fall back to a plain substring test for them.
  const cjkNeedle = needle.length >= 2 && /[぀-ヿ㐀-鿿]/.test(needle);
  const esc = escapeRegex(needle);
  // Unicode-aware "flanked by non-letters" — works for accented queries where
  // JS \b (ASCII-only) would not.
  const wholeRe = new RegExp(`(^|[^\\p{L}])${esc}([^\\p{L}]|$)`, "u");
  const prefixRe = new RegExp(`(^|[^\\p{L}])${esc}`, "u");
  const hits = [];
  for (const [literal, meanings] of idx) {
    let score = 0;
    let at = 99;
    meanings.forEach((m, i) => {
      const ml = foldText(m);
      let s = 0;
      if (ml === needle) s = 5;
      else if (wholeRe.test(ml)) s = 3;
      else if (words.length > 1 && words.every((w) => ml.includes(w))) s = 2;
      else if (needle.length >= 5 && prefixRe.test(ml)) s = 1;
      else if (cjkNeedle && ml.includes(needle)) s = 1;
      if (s > score || (s === score && i < at)) { score = s; at = i; }
    });
    if (score) hits.push({ literal, score, at });
  }
  // Best score, then the match's position in the meaning list (a kanji whose
  // primary meaning is the query beats one where it's a minor sense), then freq.
  hits.sort((a, b) => b.score - a.score || a.at - b.at || freqRank(a.literal) - freqRank(b.literal));
  return hits.slice(0, 120).map((h) => ({ literal: h.literal, meaning: meaningText(h.literal, lang) }));
}

// English meaning search: FTS5 over the English glosses, LIKE fallback. Result
// cards are still shown in `lang`.
function searchMeaning(q, lang = "en") {
  const clean = q.trim().toLowerCase();
  if (!clean) return [];
  if (meaningFtsStmt) {
    const tokens = clean.split(/[^a-z0-9]+/i).filter(Boolean);
    if (tokens.length) {
      const match = tokens.map((t) => `"${t}"`).join(" ") + (tokens.length === 1 ? ` OR "${tokens[0]}"*` : "");
      try {
        const rows = meaningFtsStmt.all(match);
        if (rows.length) return toResultList(rows, lang);
      } catch {
        /* fall through to LIKE */
      }
    }
  }
  return toResultList(stmts.meaningLike.all(`%${clean}%`), lang);
}

function searchReading(input, lang = "en") {
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
  return { kana: norm, results: toResultList([...exact, ...prefix].slice(0, 150), lang) };
}

/**
 * One query, everything related: any kanji characters typed directly, kanji
 * whose English meaning matches, and kanji with a matching reading (kana typed
 * directly, or romaji converted to kana). No search-type switch.
 */
function unifiedSearch(q, lang = "en") {
  const raw = q.trim();
  const directSet = new Set();
  const direct = [];
  for (const ch of raw) {
    if (wanakana.isKanji(ch) && !directSet.has(ch)) {
      const k = lookupKanji(ch, lang);
      if (k) {
        directSet.add(ch);
        direct.push({ literal: k.literal, meaning: k.meanings.slice(0, 4).join(", ") });
      }
    }
  }

  // Any Latin / Western-European letter → try a meaning lookup. A non-English
  // language searches only its own meaning set (no English results bleeding onto
  // a localised page); English glosses are used only if that language has no
  // meaning data at all (searchMeaningLocalized returns null, not []).
  let meaning = [];
  if (/[a-zA-ZÀ-ÿ]/.test(raw)) {
    meaning = lang !== "en" ? searchMeaningLocalized(raw, lang) ?? searchMeaning(raw, lang) : searchMeaning(raw, lang);
  }

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
    const r = searchReading(kana, lang);
    readingKana = r.kana;
    reading = r.results;
    words = searchWordsByReading(readingKana || kana, lang);
  }

  meaning = meaning.filter((c) => !directSet.has(c.literal));
  reading = reading.filter((c) => !directSet.has(c.literal));

  return { query: raw, direct, meaning, reading, words, readingKana };
}

/** Multi-character words (jukugo) whose exact kana reading matches the query. */
function searchWordsByReading(kana, lang = "en") {
  if (!dictStmts) return [];
  const norm = (kana || "").trim();
  if (!norm) return [];
  let rows = EXWORDS_HAS_LANG
    ? dictStmts.wordsByReading.all(norm, lang)
    : dictStmts.wordsByReading.all(norm);
  if (!rows.length && EXWORDS_HAS_LANG && lang !== "en") {
    rows = dictStmts.wordsByReading.all(norm, "en");
  }
  return rows.map((r) => ({ word: r.word, gloss: r.gloss }));
}

/**
 * Common words for a kanji: the English-selected set (stable choice + order),
 * with each gloss swapped for its `lang` translation where one exists.
 */
function exampleWordsFor(literal, lang = "en") {
  if (!dictStmts) return [];
  if (!EXWORDS_HAS_LANG) return dictStmts.exampleWords.all(literal);
  const en = dictStmts.exampleWords.all(literal, "en");
  if (lang === "en" || !en.length) return en;
  const tr = new Map(
    dictStmts.exampleWords.all(literal, lang).map((r) => [r.word, r.gloss]),
  );
  return en.map((r) => (tr.has(r.word) ? { ...r, gloss: tr.get(r.word) } : r));
}

/** Dictionary entries (reading + gloss) for a whole word, in `lang` w/ fallback. */
function wordEntriesFor(word, lang = "en") {
  if (!dictStmts) return [];
  if (!EXWORDS_HAS_LANG) return dictStmts.wordEntries.all(word);
  let rows = dictStmts.wordEntries.all(word, lang);
  if (!rows.length && lang !== "en") rows = dictStmts.wordEntries.all(word, "en");
  return rows;
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

function toChips(rows, lang = "en", exclude = new Set()) {
  return rows
    .filter((r) => !exclude.has(r.literal))
    .map((r) => ({ literal: r.literal, meaning: meaningText(r.literal, lang, 2) }));
}

function lookupKanji(literal, lang = "en") {
  const row = parseKanjiRow(stmts.kanji.get(literal), lang);
  if (!row) return null;
  const components = stmts.components.all(literal).map((c) => ({
    element: c.element,
    position: c.position || null,
    isRadical: !!c.is_radical,
    isPhonetic: !!c.is_phonetic,
    roleKey: c.is_phonetic ? "sound-hint" : c.is_radical ? "radical" : "meaning-part",
  }));

  // Example words + related-kanji rails.
  const exampleWords = exampleWordsFor(literal, lang);

  // Origin story: prefer a translation for the requested language, else English.
  let originStory = row.origin_story;
  let originIsFallback = false;
  if (lang !== "en") {
    const localized = originStoryStmt?.get(literal, lang)?.story;
    if (localized) originStory = localized;
    else if (originStory) originIsFallback = true;
  }

  const exclude = new Set([literal]);
  const phoneticEls = [...new Set(components.filter((c) => c.isPhonetic).map((c) => c.element))];
  const samePhonetic = [];
  for (const el of phoneticEls) {
    for (const r of relStmts.samePhonetic.all(el, literal)) samePhonetic.push(r);
  }
  const samePhoneticChips = toChips(dedupeByLiteral(samePhonetic), lang, exclude);
  samePhoneticChips.forEach((c) => exclude.add(c.literal));

  const sameRadical = row.radical_number
    ? toChips(relStmts.sameRadical.all(row.radical_number, literal), lang, exclude)
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
    sharesComponents = toChips(rows, lang, exclude).slice(0, 12);
  }

  return {
    ...row,
    origin_story: originStory,
    originIsFallback,
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

const SITE_NAME = app.locals.SITE_NAME;
const CONTACT_EMAIL = app.locals.CONTACT_EMAIL;
const KANJI_COUNT_FMT = Number(META.kanji_count).toLocaleString("en-US");

function readCookie(req, name) {
  const raw = req.headers.cookie || "";
  const m = raw.match(new RegExp("(?:^|;\\s*)" + name + "=([^;]*)"));
  return m ? decodeURIComponent(m[1]) : null;
}

// ---------- locale: URL prefix (/fr, /es, /pt, /de) + cookie ----------
app.use((req, res, next) => {
  const base = siteBase(req);

  // Pull a "/xx" language prefix off the URL and hide it from the routes.
  const m = req.url.match(PREFIX_RE);
  let lang = "en";
  if (m) {
    lang = m[1];
    req.url = req.url.slice(3) || "/";
    if (req.url[0] !== "/") req.url = "/" + req.url;
  } else {
    // Bare "/" with a saved non-English preference → send them to /xx/.
    const pref = readCookie(req, "lang");
    if (req.path === "/" && pref && isSupported(pref) && pref !== "en") {
      return res.redirect(302, "/" + pref + "/");
    }
  }

  const lp = lang === "en" ? "" : "/" + lang;
  const tt = translator(lang);
  const cleanPath = req.path;

  res.locals.lang = lang;
  res.locals.lp = lp;
  res.locals.langDir = langDir(lang);
  res.locals.langLabel = langName(lang);
  res.locals.t = tt;
  res.locals.linkifyKanji = (text) => linkifyKanji(text, lp);
  res.locals.siteUrl = base;
  res.locals.canonical = base + lp + cleanPath;
  res.locals.langOptions = LANGS.map((l) => ({ code: l, name: langName(l), current: l === lang }));
  res.locals.altLangs = [
    ...LANGS.map((l) => ({
      hreflang: l,
      href: base + (l === "en" ? "" : "/" + l) + cleanPath,
    })),
    { hreflang: "x-default", href: base + cleanPath },
  ];
  next();
});

// ---------- per-page SEO (title + meta description) ----------

const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

/** { title, description } for a kanji detail page, built from its (localised) data. */
function kanjiSeo(k, tt) {
  const primary = k.meanings[0] || "";
  const reading = primaryReading(k);
  const romaji = reading ? wanakana.toRomaji(reading.replace(/[.\-]/g, "")) : "";
  const paren = romaji || reading;
  return {
    title: `${k.literal}${primary ? ` (${cap(primary)})` : ""}`,
    description: tt("seo.kanji_description", {
      literal: k.literal,
      paren: paren ? ` (${paren})` : "",
      meanings: k.meanings.slice(0, 3).join(", ") || tt("kanji.meanings_dash"),
      site: SITE_NAME,
    }),
  };
}

/** { title, description } for a /word/ page. `entry` = the dictionary hit or null. */
function wordSeo(word, entry, parts, tt) {
  const reading = entry?.reading || "";
  const romaji = reading ? wanakana.toRomaji(reading) : "";
  const paren = romaji || reading;
  const join = parts.length === 2 ? tt("seo.word_parts_join") : ", ";
  return {
    title: `${word}${paren ? ` (${paren})` : ""}`,
    description: entry
      ? tt("seo.word_description_exact", {
          word,
          paren: paren ? ` (${paren})` : "",
          gloss: entry.gloss || tt("kanji.meanings_dash"),
          parts: parts.join(join) || word,
          site: SITE_NAME,
        })
      : tt("seo.word_description_plain", {
          word,
          parts: parts.join(", ") || tt("kanji.meanings_dash"),
          site: SITE_NAME,
        }),
  };
}

/** SEO block for a static page, keyed by its catalog prefix (seo.<key>_*). */
function pageSeo(tt, key) {
  return {
    title: tt(`seo.${key}_title`, { count: KANJI_COUNT_FMT, site: SITE_NAME }),
    description: tt(`seo.${key}_description`, { count: KANJI_COUNT_FMT, site: SITE_NAME }),
  };
}

app.get("/", (req, res) => {
  res.render("home", { meta: META, featured: featuredCards(res.locals.lang) });
});

app.get("/about", (req, res) => {
  res.render("about", { ...pageSeo(res.locals.t, "about") });
});

app.get("/privacy", (req, res) => {
  res.render("privacy", { ...pageSeo(res.locals.t, "privacy") });
});

// A random kanji page — the "surprise me" link.
app.get("/random", (req, res) => {
  const row = randomStmt.get(1);
  res.redirect(row ? `${res.locals.lp}/kanji/${encodeURIComponent(row.literal)}` : `${res.locals.lp}/`);
});

// A handful of random kanji cards (home-page "explore" refresh).
app.get("/api/random", (req, res) => {
  const n = Math.min(24, Math.max(1, Number(req.query.n) || 12));
  const lang = isSupported(req.query.lang) ? req.query.lang : "en";
  res.set("Cache-Control", "no-store");
  const items = randomStmt.all(n).map((r) => ({
    literal: r.literal,
    meaning: meaningText(r.literal, lang, 2),
  }));
  res.json({ items });
});

app.get("/search", (req, res) => {
  const { lang, lp } = res.locals;
  const tt = res.locals.t;
  const q = (req.query.q ?? "").toString();
  if (!q.trim()) return res.redirect(`${lp}/`);

  const qt = q.trim();

  // A single kanji character: go straight to its page.
  if ([...qt].length === 1 && wanakana.isKanji(qt)) {
    return res.redirect(`${lp}/kanji/${encodeURIComponent(qt)}`);
  }

  // A run of 2+ kanji (no kana, no romaji, no English): try it as a whole word.
  const wordPath = wordRedirectPath(qt);
  if (wordPath) return res.redirect(lp + wordPath);

  const search = unifiedSearch(q, lang);
  const kanjiTotal = search.direct.length + search.meaning.length + search.reading.length;
  const total = kanjiTotal + search.words.length;

  // Exactly one hit overall: jump straight to it.
  if (total === 1 && search.words.length === 1) {
    return res.redirect(`${lp}/word/${encodeURIComponent(search.words[0].word)}`);
  }
  if (total === 1 && kanjiTotal === 1) {
    const only = search.direct[0] || search.meaning[0] || search.reading[0];
    return res.redirect(`${lp}/kanji/${encodeURIComponent(only.literal)}`);
  }

  res.render("results", {
    search,
    total,
    title: tt("seo.search_title", { q: search.query }),
    description: tt("seo.search_description", { q: search.query, site: SITE_NAME }),
    noindex: true,
  });
});

app.get("/api/search", (req, res) => {
  const lang = isSupported(req.query.lang) ? req.query.lang : res.locals.lang;
  const q = (req.query.q ?? "").toString();
  if (!q.trim())
    return res.json({ query: "", direct: [], meaning: [], reading: [], words: [], readingKana: null });
  res.json(unifiedSearch(q, lang));
});

// Typeahead: a short, flat, ranked list for the search-bar dropdown.
app.get("/api/suggest", (req, res) => {
  const lang = isSupported(req.query.lang) ? req.query.lang : res.locals.lang;
  const lp = lang === "en" ? "" : "/" + lang;
  const tt = translator(lang);
  const q = (req.query.q ?? "").toString().trim();
  res.set("Cache-Control", "no-store");
  if (!q) return res.json({ q, kana: null, items: [] });

  const s = unifiedSearch(q, lang);
  const items = [];
  const seen = new Set();
  const add = (it) => {
    const href = lp + (it.href || `/kanji/${encodeURIComponent(it.literal)}`);
    if (seen.has(href) || items.length >= 8) return;
    seen.add(href);
    items.push({ literal: it.literal, meaning: it.meaning, reason: it.reason, href });
  };

  s.direct.forEach((r) => add({ ...r, reason: tt("suggest.you_typed") }));
  // A real kana/romaji reading query (it actually matched something as a
  // reading) leads with words + single-kanji readings; otherwise it's a
  // meaning query — including Latin words that merely *look* convertible to kana.
  if (s.readingKana && (s.words.length || s.reading.length)) {
    const reason = tt("suggest.read_as", { kana: s.readingKana });
    s.words.forEach((w) =>
      add({ literal: w.word, meaning: w.gloss, reason, href: `/word/${encodeURIComponent(w.word)}` }),
    );
    s.reading.forEach((r) => add({ ...r, reason }));
  } else {
    s.meaning.forEach((r) => add({ ...r, reason: tt("suggest.meaning") }));
  }

  res.json({ q, kana: s.readingKana, items });
});

app.get("/kanji/:char", (req, res) => {
  const { lang, lp } = res.locals;
  const char = decodeURIComponent(req.params.char);
  const kanji = lookupKanji(char, lang);
  if (!kanji) {
    // A multi-kanji string landed here (old link, hand-typed URL) — it belongs
    // on the word page.
    const wordPath = wordRedirectPath(char.trim());
    if (wordPath) return res.redirect(301, lp + wordPath);
    return res.status(404).render("404", {
      message: res.locals.t("notfound.no_kanji", { char }),
      title: res.locals.t("notfound.title"),
      noindex: true,
    });
  }
  res.render("kanji", { kanji, meta: META, ...kanjiSeo(kanji, res.locals.t) });
});

// ---------- whole-word lookup ----------

app.get("/word/:word", (req, res) => {
  const { lang, lp } = res.locals;
  const tt = res.locals.t;
  const word = decodeURIComponent(req.params.word).trim();
  const chars = [...word];

  if (!word) return res.redirect(`${lp}/`);

  // A bare single kanji belongs on the kanji page.
  if (chars.length === 1 && KANJI_SET.has(word)) {
    return res.redirect(`${lp}/kanji/${encodeURIComponent(word)}`);
  }

  const entries = wordEntriesFor(word, lang);
  const isExact = entries.length > 0;

  const kanjiChars = chars.filter((c) => wanakana.isKanji(c));
  const isJoyoRun = kanjiChars.length >= 2 && chars.every((c) => KANJI_SET.has(c));

  if (!isExact && !isJoyoRun) {
    return res.status(404).render("404", {
      message: tt("notfound.not_word", { word }),
      title: tt("notfound.title"),
      noindex: true,
    });
  }

  // One breakdown card per kanji character, in order, de-duplicated.
  const seen = new Set();
  const breakdown = [];
  for (const c of kanjiChars) {
    if (seen.has(c)) continue;
    seen.add(c);
    const card = kanjiCard(c, lang);
    if (card) breakdown.push(card);
  }

  const parts = breakdown.map((b) => b.literal);
  res.render("word", {
    word,
    entries,
    isExact,
    breakdown,
    meta: META,
    ...wordSeo(word, entries[0] || null, parts, tt),
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
      SELECT literal FROM kanji ${whereSql}
      ORDER BY ${BROWSE_SORTS[sort]}
      LIMIT ? OFFSET ?`)
    .all(...params, BROWSE_PER_PAGE, (clampedPage - 1) * BROWSE_PER_PAGE);

  const strokeCounts = db
    .prepare("SELECT DISTINCT stroke_count s FROM kanji WHERE stroke_count IS NOT NULL ORDER BY s")
    .all()
    .map((r) => r.s);

  res.render("browse", {
    meta: META,
    results: rows.map((r) => ({ literal: r.literal, meaning: meaningText(r.literal, res.locals.lang, 3) })),
    filters: { grade, jlpt, strokes, formation, sort },
    strokeCounts,
    total,
    page: clampedPage,
    pages,
    query: req.query,
    ...pageSeo(res.locals.t, "browse"),
    noindex: Object.keys(req.query).length > 0,
  });
});

app.get("/radicals", (req, res) => {
  if (!HAS_DICT) {
    return res.render("radicals", { meta: META, groups: null, ...pageSeo(res.locals.t, "radicals") });
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
  res.render("radicals", { meta: META, groups, ...pageSeo(res.locals.t, "radicals") });
});

app.get("/api/by-radicals", (req, res) => {
  res.set("Cache-Control", "no-store");
  const lang = isSupported(req.query.lang) ? req.query.lang : "en";
  const parts = (req.query.parts ?? "")
    .toString()
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!HAS_DICT || !parts.length) return res.json({ parts, items: [] });

  const placeholders = parts.map(() => "?").join(",");
  const rows = db
    .prepare(`
      SELECT kp.kanji_literal AS literal, k.freq
      FROM kanji_parts kp JOIN kanji k ON k.literal = kp.kanji_literal
      WHERE kp.part IN (${placeholders})
      GROUP BY kp.kanji_literal
      HAVING COUNT(DISTINCT kp.part) = ?
      ORDER BY (k.freq IS NULL), k.freq
      LIMIT 400`)
    .all(...parts, parts.length);

  res.json({
    parts,
    items: rows.map((r) => ({ literal: r.literal, meaning: meaningText(r.literal, lang, 3) })),
  });
});

app.get("/credits", (req, res) => {
  res.render("credits", { meta: META, ...pageSeo(res.locals.t, "credits") });
});

// ---------- sitemap + robots ----------

const SITEMAP_STATIC = ["/", "/browse", "/radicals", "/about", "/privacy", "/credits"];
const sitemapCache = new Map(); // key -> xml

function buildSitemapIndex(base) {
  const body = LANGS.map(
    (l) => `  <sitemap><loc>${base}/sitemap-${l}.xml</loc></sitemap>`,
  ).join("\n");
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
    body +
    "\n</sitemapindex>\n"
  );
}

function buildSitemap(base, lang) {
  const lp = lang === "en" ? "" : "/" + lang;
  const kanji = db.prepare("SELECT literal FROM kanji ORDER BY (freq IS NULL), freq").all();
  const words = HAS_DICT
    ? db.prepare("SELECT DISTINCT word FROM example_words ORDER BY word").all()
    : [];
  const paths = [
    ...SITEMAP_STATIC,
    ...kanji.map((k) => `/kanji/${encodeURIComponent(k.literal)}`),
    ...words.map((w) => `/word/${encodeURIComponent(w.word)}`),
  ];
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
    paths.map((p) => `  <url><loc>${base}${lp}${p}</loc></url>`).join("\n") +
    "\n</urlset>\n"
  );
}

app.get("/sitemap.xml", (req, res) => {
  const base = res.locals.siteUrl;
  const key = `index:${base}`;
  if (!sitemapCache.has(key)) sitemapCache.set(key, buildSitemapIndex(base));
  res.type("application/xml").send(sitemapCache.get(key));
});

app.get(/^\/sitemap-([a-z]{2})\.xml$/, (req, res, next) => {
  const lang = req.params[0];
  if (!isSupported(lang)) return next();
  const base = res.locals.siteUrl;
  const key = `${lang}:${base}`;
  if (!sitemapCache.has(key)) sitemapCache.set(key, buildSitemap(base, lang));
  res.type("application/xml").send(sitemapCache.get(key));
});

app.get("/robots.txt", (req, res) => {
  res.type("text/plain").send(
    "User-agent: *\nAllow: /\n" +
      "Disallow: /api/\nDisallow: /*/api/\nDisallow: /search\nDisallow: /*/search\n\n" +
      `Sitemap: ${res.locals.siteUrl}/sitemap.xml\n`,
  );
});

app.use((req, res) => {
  res.status(404).render("404", {
    message: res.locals.t("notfound.page"),
    title: res.locals.t("notfound.title"),
    noindex: true,
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Kanji Decipher — http://localhost:${PORT}`);
  console.log(`  ${META.kanji_count} kanji · FTS5 ${FTS ? "on" : "off (LIKE fallback)"}`);
});
