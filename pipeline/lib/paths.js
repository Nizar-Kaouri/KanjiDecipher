import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";

const here = path.dirname(fileURLToPath(import.meta.url));

export const ROOT = path.resolve(here, "..", "..");
export const DATA_DIR = path.join(ROOT, "data");
export const SOURCES_DIR = path.join(DATA_DIR, "sources");
export const INTERMEDIATE_DIR = path.join(DATA_DIR, "intermediate");
export const DB_PATH = path.join(DATA_DIR, "kanji.db");

export const SOURCE_FILES = {
  kanjidic2: path.join(SOURCES_DIR, "kanjidic2.xml.gz"),
  kanjivg: path.join(SOURCES_DIR, "kanjivg.xml.gz"),
  jmdict: path.join(SOURCES_DIR, "jmdict-eng-common.json.zip"),
  kradfile: path.join(SOURCES_DIR, "kradfile.json.zip"),
  radkfile: path.join(SOURCES_DIR, "radkfile.json.zip"),
};

export const INTERMEDIATE_FILES = {
  kanjidic2: path.join(INTERMEDIATE_DIR, "kanjidic2.json"),
  kanjivg: path.join(INTERMEDIATE_DIR, "kanjivg.json"),
};

export function ensureDirs() {
  for (const dir of [DATA_DIR, SOURCES_DIR, INTERMEDIATE_DIR]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}
