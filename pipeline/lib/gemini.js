/**
 * Minimal Google Gemini REST client for the translation scripts (4b, 4c).
 * Free tier: https://aistudio.google.com/apikey
 * Key from GEMINI_API_KEY env var or pipeline/.gemini_key (git-ignored).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

export const GEMINI_MODEL_DEFAULT = "gemini-flash-lite-latest";
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function readGeminiKey() {
  if (process.env.GEMINI_API_KEY) return process.env.GEMINI_API_KEY.trim();
  const f = path.join(here, "..", ".gemini_key");
  if (fs.existsSync(f)) return fs.readFileSync(f, "utf8").trim();
  throw new Error(
    "No Gemini API key.\n" +
      "  Get a free key at https://aistudio.google.com/apikey , then either:\n" +
      "    setx GEMINI_API_KEY \"your-key\"   (new shell)   — or —\n" +
      "    put it in pipeline/.gemini_key",
  );
}

/**
 * One generateContent call expecting a JSON object back (responseMimeType is
 * application/json). Retries on 429 / 5xx. Returns the parsed object.
 */
export async function callGeminiJson(model, key, prompt, tries = 4) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;
  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.2, responseMimeType: "application/json" },
  };
  for (let attempt = 1; attempt <= tries; attempt++) {
    let res;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch (err) {
      if (attempt === tries) throw err;
      await sleep(2000 * attempt);
      continue;
    }
    if (res.status === 429 || res.status >= 500) {
      if (attempt === tries) throw new Error(`HTTP ${res.status} after ${tries} tries`);
      const wait = res.status === 429 ? 30000 : 3000 * attempt;
      console.warn(`  HTTP ${res.status} — waiting ${wait / 1000}s`);
      await sleep(wait);
      continue;
    }
    const data = await res.json();
    if (!res.ok) throw new Error(data?.error?.message || `HTTP ${res.status}`);
    const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text).join("") ?? "";
    if (!text) throw new Error("empty response");
    return JSON.parse(text);
  }
}
