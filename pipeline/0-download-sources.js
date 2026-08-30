/**
 * Step 0 — download raw source data into data/sources/.
 *
 * Sources (all free / attribution licences — see /credits):
 *   - KanjiVG      combined XML   CC BY-SA 3.0   (Ulrich Apel)
 *   - KANJIDIC2    gzipped XML    CC BY-SA 4.0   (EDRDG / Jim Breen)
 *   - JMdict       json.zip       CC BY-SA 4.0   (EDRDG / Jim Breen; via jmdict-simplified)
 *   - KRADFILE     json.zip       CC BY-SA 3.0   (James Breen / EDRDG; via jmdict-simplified)
 *   - RADKFILE     json.zip       CC BY-SA 3.0   (James Breen / EDRDG; via jmdict-simplified)
 *
 * Idempotent: skips files that already exist unless --force is passed.
 *
 *   node pipeline/0-download-sources.js [--force]
 */
import fs from "node:fs";
import { ensureDirs, SOURCE_FILES } from "./lib/paths.js";

const args = new Set(process.argv.slice(2));
const FORCE = args.has("--force");

const KANJIVG_RELEASES_API =
  "https://api.github.com/repos/KanjiVG/kanjivg/releases/latest";

const KANJIDIC2_URLS = [
  "http://www.edrdg.org/kanjidic/kanjidic2.xml.gz",
  "http://ftp.edrdg.org/pub/Nihongo/kanjidic2.xml.gz",
  "http://nihongo.monash.edu/kanjidic2/kanjidic2.xml.gz",
];

const JMDICT_SIMPLIFIED_API =
  "https://api.github.com/repos/scriptin/jmdict-simplified/releases/latest";

// jmdict-simplified assets we want, keyed by SOURCE_FILES name -> asset-name regex.
const JMDICT_SIMPLIFIED_ASSETS = [
  ["jmdict", /^jmdict-eng-common-.*\.json\.zip$/],
  ["kradfile", /^kradfile-.*\.json\.zip$/],
  ["radkfile", /^radkfile-.*\.json\.zip$/],
];

async function downloadTo(dest, url, { headers } = {}) {
  process.stdout.write(`  GET ${url}\n`);
  const res = await fetch(url, { headers, redirect: "follow" });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(dest, buf);
  process.stdout.write(
    `  saved ${dest}  (${(buf.length / 1024 / 1024).toFixed(2)} MB)\n`,
  );
}

async function tryUrls(dest, urls, opts) {
  let lastErr;
  for (const url of urls) {
    try {
      await downloadTo(dest, url, opts);
      return;
    } catch (err) {
      lastErr = err;
      process.stdout.write(`  ! ${err.message}\n`);
    }
  }
  throw lastErr;
}

async function resolveKanjiVgAssetUrl() {
  const res = await fetch(KANJIVG_RELEASES_API, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "kanji-origin-pipeline",
    },
  });
  if (!res.ok) {
    throw new Error(
      `KanjiVG releases API returned HTTP ${res.status} ${res.statusText}`,
    );
  }
  const release = await res.json();
  const asset = (release.assets || []).find((a) =>
    /^kanjivg-\d+\.xml\.gz$/.test(a.name),
  );
  if (!asset) {
    throw new Error(
      `no kanjivg-*.xml.gz asset in release ${release.tag_name ?? "?"}`,
    );
  }
  process.stdout.write(
    `  KanjiVG release ${release.tag_name} -> ${asset.name}\n`,
  );
  return asset.browser_download_url;
}

async function resolveJmdictSimplifiedAssets() {
  const res = await fetch(JMDICT_SIMPLIFIED_API, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "kanji-origin-pipeline",
    },
  });
  if (!res.ok) {
    throw new Error(
      `jmdict-simplified releases API returned HTTP ${res.status} ${res.statusText}`,
    );
  }
  const release = await res.json();
  const assets = release.assets || [];
  const out = [];
  for (const [key, rx] of JMDICT_SIMPLIFIED_ASSETS) {
    const asset = assets.find((a) => rx.test(a.name));
    if (!asset) throw new Error(`no asset matching ${rx} in release ${release.tag_name}`);
    out.push([key, asset.browser_download_url, asset.name]);
  }
  process.stdout.write(`  jmdict-simplified release ${release.tag_name}\n`);
  return out;
}

function skip(dest) {
  if (!FORCE && fs.existsSync(dest) && fs.statSync(dest).size > 0) {
    process.stdout.write(`  exists, skipping ${dest}  (--force to redownload)\n`);
    return true;
  }
  return false;
}

async function main() {
  ensureDirs();

  console.log("KanjiVG (combined stroke + component XML)");
  if (!skip(SOURCE_FILES.kanjivg)) {
    const url = await resolveKanjiVgAssetUrl();
    await downloadTo(SOURCE_FILES.kanjivg, url, {
      headers: { "User-Agent": "kanji-origin-pipeline" },
    });
  }

  console.log("\nKANJIDIC2 (meanings + readings + stroke counts)");
  if (!skip(SOURCE_FILES.kanjidic2)) {
    await tryUrls(SOURCE_FILES.kanjidic2, KANJIDIC2_URLS, {
      headers: { "User-Agent": "kanji-origin-pipeline" },
    });
  }

  console.log("\nJMdict + KRADFILE + RADKFILE (words, components — via jmdict-simplified)");
  const needJmdict = [
    SOURCE_FILES.jmdict,
    SOURCE_FILES.kradfile,
    SOURCE_FILES.radkfile,
  ].some((f) => !(fs.existsSync(f) && fs.statSync(f).size > 0));
  if (FORCE || needJmdict) {
    const assets = await resolveJmdictSimplifiedAssets();
    for (const [key, url, name] of assets) {
      if (skip(SOURCE_FILES[key])) continue;
      process.stdout.write(`  ${name}\n`);
      await downloadTo(SOURCE_FILES[key], url, {
        headers: { "User-Agent": "kanji-origin-pipeline" },
      });
    }
  } else {
    console.log("  all present, skipping (--force to redownload)");
  }

  console.log("\nDone. Next: npm run pipeline:kanjidic");
}

main().catch((err) => {
  console.error("\nDownload failed:", err.message);
  process.exit(1);
});
