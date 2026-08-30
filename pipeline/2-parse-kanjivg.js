/**
 * Step 2 — parse KanjiVG into per-kanji stroke lists + component decomposition.
 *
 * Input:  data/sources/kanjivg.xml.gz   (combined release XML)
 * Output: data/intermediate/kanjivg.json
 *
 * For each base kanji (id "kvg:kanji_<hex>", no variant suffix):
 *   - strokes: ordered [{d, type, component}]  (component = index into components[] or -1)
 *   - components: [{element, position, isRadical, isPhonetic}] in reading order
 *   - svg / svgStatic: self-contained stroke-order diagrams
 */
import fs from "node:fs";
import zlib from "node:zlib";
import { XMLParser } from "fast-xml-parser";
import { ensureDirs, SOURCE_FILES, INTERMEDIATE_FILES } from "./lib/paths.js";
import { buildInteractiveSvg, buildStaticSvg } from "./lib/kanjivg-svg.js";

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  preserveOrder: true,
});

// preserveOrder node helpers: node is { <tag>: [children], ":@": {attrs} }
const tagOf = (node) => Object.keys(node).find((k) => k !== ":@");
const childrenOf = (node) => node[tagOf(node)] ?? [];
const attrsOf = (node) => node[":@"] ?? {};

function collectPathNodes(node, acc = []) {
  for (const child of childrenOf(node)) {
    if (tagOf(child) === "path") acc.push(child);
    else if (tagOf(child) === "g") collectPathNodes(child, acc);
  }
  return acc;
}

function elementBearingSubGroups(group) {
  return childrenOf(group).filter((n) => {
    if (tagOf(n) !== "g") return false;
    const a = attrsOf(n);
    return a["@_kvg:element"] != null || a["@_kvg:phon"] != null;
  });
}

/** Walk down single-wrapper groups until we find 2+ sibling components. */
function topComponentGroups(rootGroup) {
  let group = rootGroup;
  for (let depth = 0; depth < 6; depth++) {
    const subs = elementBearingSubGroups(group);
    if (subs.length >= 2) return subs;
    if (subs.length === 1) {
      group = subs[0];
      continue;
    }
    break;
  }
  return [];
}

function describeComponent(groupNode) {
  const a = attrsOf(groupNode);
  const element = a["@_kvg:element"] ?? a["@_kvg:phon"] ?? null;
  return {
    element,
    position: a["@_kvg:position"] ?? null,
    isRadical: a["@_kvg:radical"] != null,
    isPhonetic: a["@_kvg:phon"] != null,
    original: a["@_kvg:original"] ?? null,
  };
}

function parseKanjiNode(kanjiNode) {
  const id = attrsOf(kanjiNode)["@_id"] ?? "";
  const m = id.match(/^kvg:kanji_([0-9a-f]+)$/i);
  if (!m) return null; // skip variant forms (…-Kaisho, …-VtLst, etc.)

  const codepoint = parseInt(m[1], 16);
  const literal = String.fromCodePoint(codepoint);

  const rootGroup = childrenOf(kanjiNode).find((n) => tagOf(n) === "g");
  if (!rootGroup) return null;

  const compGroups = topComponentGroups(rootGroup);
  let components;
  if (compGroups.length) {
    components = compGroups.map(describeComponent).filter((c) => c.element);
  } else {
    const a = attrsOf(rootGroup);
    components = [
      {
        element: a["@_kvg:element"] ?? literal,
        position: null,
        isRadical: a["@_kvg:radical"] != null,
        isPhonetic: false,
        original: a["@_kvg:original"] ?? null,
      },
    ];
  }

  // Assign each stroke (document order under root) to a component index.
  const compPathSets = compGroups.map((g) => new Set(collectPathNodes(g)));
  const strokes = [];
  for (const p of collectPathNodes(rootGroup)) {
    const pa = attrsOf(p);
    if (pa["@_d"] == null) continue;
    let component = -1;
    for (let i = 0; i < compPathSets.length; i++) {
      if (compPathSets[i].has(p)) {
        component = i;
        break;
      }
    }
    strokes.push({ d: pa["@_d"], type: pa["@_kvg:type"] ?? null, component });
  }

  if (strokes.length === 0) return null;

  return {
    literal,
    codepoint: `U+${m[1].toUpperCase().padStart(4, "0")}`,
    strokeCount: strokes.length,
    components,
    strokes,
    svg: buildInteractiveSvg(strokes),
    svgStatic: buildStaticSvg(strokes),
  };
}

function main() {
  ensureDirs();

  if (!fs.existsSync(SOURCE_FILES.kanjivg)) {
    console.error(`Missing ${SOURCE_FILES.kanjivg} — run: npm run pipeline:download`);
    process.exit(1);
  }

  console.log("Reading + gunzipping KanjiVG …");
  let xml = zlib.gunzipSync(fs.readFileSync(SOURCE_FILES.kanjivg)).toString("utf8");
  xml = xml.replace(/<!DOCTYPE[\s\S]*?\]>/, ""); // drop the internal DTD subset

  console.log("Parsing XML (preserveOrder) …");
  const doc = parser.parse(xml);
  const kanjivgNode = doc.find((n) => tagOf(n) === "kanjivg");
  const kanjiNodes = childrenOf(kanjivgNode).filter((n) => tagOf(n) === "kanji");
  console.log(`  ${kanjiNodes.length} <kanji> elements`);

  const out = [];
  for (const node of kanjiNodes) {
    const parsed = parseKanjiNode(node);
    if (parsed) out.push(parsed);
  }

  const result = {
    meta: {
      source: "KanjiVG",
      license: "CC BY-SA 3.0",
      attribution: "Ulrich Apel",
      parsedAt: new Date().toISOString(),
      count: out.length,
    },
    kanji: out,
  };

  fs.writeFileSync(INTERMEDIATE_FILES.kanjivg, JSON.stringify(result));
  console.log(`\nWrote ${out.length} base kanji -> ${INTERMEDIATE_FILES.kanjivg}`);

  const multi = out.filter((k) => k.components.length >= 2).length;
  const phon = out.filter((k) => k.components.some((c) => c.isPhonetic)).length;
  console.log(`  ${multi} have 2+ components; ${phon} have a phonetic component`);
  console.log("\nNext: npm run pipeline:build");
}

main();
