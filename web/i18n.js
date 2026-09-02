/**
 * Tiny i18n layer for the EJS views and server-side strings.
 *
 * - Catalogs live in web/locales/<lang>.json (flat key -> string).
 * - en.json is the source of truth and the fallback for every other language:
 *   a missing or empty key falls back to English, then to the key itself.
 * - Interpolation: "{name}" placeholders, filled from the vars object.
 *   Values are NOT HTML-escaped here — keys whose value contains markup are
 *   rendered with <%- %> in the views; plain keys with <%= %>.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const LOCALES_DIR = path.join(here, "locales");

// Order = order shown in the language dropdown. English first (no URL prefix).
export const LANGS = ["en", "fr", "es", "pt", "de", "ja"];

// Non-English languages get a "/xx" path prefix. Keep this in sync with LANGS
// and with the regex in lang.js.
export const PREFIXED_LANGS = LANGS.filter((l) => l !== "en");
export const PREFIX_RE = new RegExp(`^/(${PREFIXED_LANGS.join("|")})(?=/|$)`);

const catalogs = {};
for (const lang of LANGS) {
  const file = path.join(LOCALES_DIR, `${lang}.json`);
  try {
    catalogs[lang] = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    catalogs[lang] = {};
  }
}

const EN = catalogs.en || {};

export function isSupported(lang) {
  return LANGS.includes(lang);
}

/** Endonym for the dropdown ("Français"), from the catalog's _meta. */
export function langName(lang) {
  return catalogs[lang]?._meta?.endonym || catalogs.en?._meta?.endonym || lang;
}

export function langDir(lang) {
  return catalogs[lang]?._meta?.dir || "ltr";
}

/** How complete a non-English catalog is (0..1), ignoring _meta. */
export function coverage(lang) {
  const keys = Object.keys(EN).filter((k) => k !== "_meta");
  if (!keys.length || lang === "en") return 1;
  const cat = catalogs[lang] || {};
  const have = keys.filter((k) => typeof cat[k] === "string" && cat[k] !== "").length;
  return have / keys.length;
}

function interpolate(str, vars) {
  if (!vars) return str;
  return str.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
}

/** Translate `key` for `lang`, with English then key-name fallback. */
export function t(lang, key, vars) {
  const cat = catalogs[lang] || {};
  let s = cat[key];
  if (s == null || s === "") s = EN[key];
  if (s == null) s = key;
  return interpolate(s, vars);
}

/** A `t` bound to one language — handy as `res.locals.t`. */
export function translator(lang) {
  return (key, vars) => t(lang, key, vars);
}
