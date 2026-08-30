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
  if (kana) {
    const r = searchReading(kana);
    readingKana = r.kana;
    reading = r.results;
  }

  meaning = meaning.filter((c) => !directSet.has(c.literal));
  reading = reading.filter((c) => !directSet.has(c.literal));

  return { query: raw, direct, meaning, reading, readingKana };
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
app.use(express.static(path.join(here, "public")));
app.locals.linkifyKanji = linkifyKanji;

app.get("/", (req, res) => {
  res.render("home", { meta: META, featured: featuredCards() });
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

  // A single kanji character: go straight to its page.
  if ([...q.trim()].length === 1 && wanakana.isKanji(q.trim())) {
    return res.redirect(`/kanji/${encodeURIComponent(q.trim())}`);
  }

  const search = unifiedSearch(q);
  const total = search.direct.length + search.meaning.length + search.reading.length;

  // Exactly one kanji anywhere in the results: jump to it.
  if (total === 1) {
    const only = search.direct[0] || search.meaning[0] || search.reading[0];
    return res.redirect(`/kanji/${encodeURIComponent(only.literal)}`);
  }

  res.render("results", { search, total });
});

app.get("/api/search", (req, res) => {
  const q = (req.query.q ?? "").toString();
  if (!q.trim()) return res.json({ query: "", direct: [], meaning: [], reading: [], readingKana: null });
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
  const add = (r, reason) => {
    if (!r || seen.has(r.literal) || items.length >= 8) return;
    seen.add(r.literal);
    items.push({ literal: r.literal, meaning: r.meaning, reason });
  };

  s.direct.forEach((r) => add(r, "you typed this"));
  if (s.readingKana) {
    // Kana / romaji query: readings are the intent; skip fuzzy meaning-prefix hits.
    s.reading.forEach((r) => add(r, `read ${s.readingKana}`));
  } else {
    s.meaning.forEach((r) => add(r, "meaning"));
  }

  res.json({ q, kana: s.readingKana, items });
});

app.get("/kanji/:char", (req, res) => {
  const char = decodeURIComponent(req.params.char);
  const kanji = lookupKanji(char);
  if (!kanji) {
    return res.status(404).render("404", { message: `No jōyō kanji “${char}” in the database.` });
  }
  res.render("kanji", { kanji, meta: META });
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
  });
});

app.get("/radicals", (req, res) => {
  if (!HAS_DICT) {
    return res.render("radicals", { meta: META, groups: null });
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
  res.render("radicals", { meta: META, groups });
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
  res.render("credits", { meta: META });
});

app.use((req, res) => {
  res.status(404).render("404", { message: "Page not found." });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Kanji Origin — http://localhost:${PORT}`);
  console.log(`  ${META.kanji_count} kanji · FTS5 ${FTS ? "on" : "off (LIKE fallback)"}`);
});
