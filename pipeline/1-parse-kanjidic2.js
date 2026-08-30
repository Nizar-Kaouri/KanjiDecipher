/**
 * Step 1 — parse KANJIDIC2 into per-kanji meanings, readings and stroke counts.
 *
 * Input:  data/sources/kanjidic2.xml.gz
 * Output: data/intermediate/kanjidic2.json   (jōyō kanji only)
 *
 * Jōyō filter: <misc><grade> 1–8 (1–6 Kyōiku + 8 = remaining jōyō). Grades 9/10
 * are jinmeiyō and are excluded. Expect ~2,136 rows.
 *
 * The <query_code> block (which contains the SKIP code — CC BY-NC-SA, the one
 * field we must NOT use) is never read.
 */
import fs from "node:fs";
import zlib from "node:zlib";
import { XMLParser } from "fast-xml-parser";
import { ensureDirs, SOURCE_FILES, INTERMEDIATE_FILES } from "./lib/paths.js";

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  isArray: (name) =>
    [
      "character",
      "reading",
      "meaning",
      "rad_value",
      "nanori",
      "stroke_count",
      "rmgroup",
      "variant",
    ].includes(name),
});

function asArray(v) {
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
}

function text(node) {
  if (node == null) return null;
  if (typeof node === "object") return node["#text"] ?? null;
  return node;
}

function parseCharacter(ch) {
  const literal = text(ch.literal);
  if (!literal) return null;

  const misc = ch.misc ?? {};
  const grade = misc.grade != null ? Number(text(misc.grade)) : null;

  // Jōyō only.
  if (grade == null || grade < 1 || grade > 8) return null;

  const strokeCounts = asArray(misc.stroke_count).map((s) => Number(text(s)));
  const strokeCount = strokeCounts[0] ?? null;

  let radicalNumber = null;
  for (const rv of asArray(ch.radical?.rad_value)) {
    if (rv?.["@_rad_type"] === "classical") radicalNumber = Number(text(rv));
  }

  const onReadings = [];
  const kunReadings = [];
  const meanings = [];
  for (const group of asArray(ch.reading_meaning?.rmgroup)) {
    for (const r of asArray(group.reading)) {
      const type = r?.["@_r_type"];
      const value = text(r);
      if (!value) continue;
      if (type === "ja_on") onReadings.push(value);
      else if (type === "ja_kun") kunReadings.push(value);
    }
    for (const m of asArray(group.meaning)) {
      // English meanings have no m_lang attribute.
      if (typeof m === "string") meanings.push(m);
      else if (m && m["@_m_lang"] == null && m["#text"]) meanings.push(m["#text"]);
    }
  }

  const nanori = asArray(ch.reading_meaning?.nanori)
    .map((n) => text(n))
    .filter(Boolean);

  return {
    literal,
    strokeCount,
    grade,
    freq: misc.freq != null ? Number(text(misc.freq)) : null,
    jlpt: misc.jlpt != null ? Number(text(misc.jlpt)) : null,
    radicalNumber,
    onReadings: [...new Set(onReadings)],
    kunReadings: [...new Set(kunReadings)],
    meanings: [...new Set(meanings)],
    nanori,
  };
}

function main() {
  ensureDirs();

  if (!fs.existsSync(SOURCE_FILES.kanjidic2)) {
    console.error(
      `Missing ${SOURCE_FILES.kanjidic2} — run: npm run pipeline:download`,
    );
    process.exit(1);
  }

  console.log("Reading + gunzipping KANJIDIC2 …");
  const xml = zlib.gunzipSync(fs.readFileSync(SOURCE_FILES.kanjidic2)).toString("utf8");

  console.log("Parsing XML …");
  const doc = parser.parse(xml);
  const characters = asArray(doc.kanjidic2?.character);
  console.log(`  ${characters.length} <character> elements`);

  const out = [];
  for (const ch of characters) {
    const parsed = parseCharacter(ch);
    if (parsed) out.push(parsed);
  }

  out.sort((a, b) => (a.freq ?? 1e9) - (b.freq ?? 1e9));

  const header = doc.kanjidic2?.header ?? {};
  const result = {
    meta: {
      source: "KANJIDIC2",
      license: "CC BY-SA 4.0",
      attribution: "EDRDG / Jim Breen",
      fileVersion: text(header.file_version) ?? null,
      databaseVersion: text(header.database_version) ?? null,
      dateOfCreation: text(header.date_of_creation) ?? null,
      parsedAt: new Date().toISOString(),
      count: out.length,
    },
    kanji: out,
  };

  fs.writeFileSync(INTERMEDIATE_FILES.kanjidic2, JSON.stringify(result, null, 1));
  console.log(`\nWrote ${out.length} jōyō kanji -> ${INTERMEDIATE_FILES.kanjidic2}`);

  if (out.length < 2100 || out.length > 2150) {
    console.warn(
      `  WARNING: expected ~2,136 jōyō kanji, got ${out.length}. Check the grade filter / source file.`,
    );
  }

  const noMeaning = out.filter((k) => k.meanings.length === 0);
  const noStroke = out.filter((k) => !k.strokeCount);
  if (noMeaning.length)
    console.warn(`  ${noMeaning.length} kanji have no English meaning: ${noMeaning.map((k) => k.literal).join("")}`);
  if (noStroke.length)
    console.warn(`  ${noStroke.length} kanji have no stroke count: ${noStroke.map((k) => k.literal).join("")}`);

  console.log("\nNext: npm run pipeline:kanjivg");
}

main();
