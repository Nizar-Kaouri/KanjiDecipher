/**
 * Kana helpers for the reverse-reading index.
 *
 * KANJIDIC2 gives on'yomi in katakana and kun'yomi in hiragana. Kun readings
 * also carry markers: "." separates the reading from its okurigana
 * (e.g. "つ.ける") and a leading/trailing "-" marks a prefix/suffix position
 * (e.g. "-がわ"). For the searchable index we drop the markers and fold
 * everything to hiragana so a romaji query (converted to kana by the server)
 * matches both on and kun readings.
 */

const KATA_START = 0x30a1;
const KATA_END = 0x30f6;
const HIRA_OFFSET = 0x3041 - 0x30a1;

/** Convert katakana to hiragana; leaves everything else untouched. */
export function katakanaToHiragana(str) {
  let out = "";
  for (const ch of str) {
    const cp = ch.codePointAt(0);
    if (cp >= KATA_START && cp <= KATA_END) {
      out += String.fromCodePoint(cp + HIRA_OFFSET);
    } else {
      out += ch; // katakana "ー", punctuation, iteration marks — keep as-is
    }
  }
  return out;
}

/** Remove KANJIDIC okurigana "." and position "-" markers. */
export function stripReadingMarkers(reading) {
  return reading.replace(/[.\-]/g, "");
}

/**
 * Normalised, searchable form of a reading: markers removed, folded to
 * hiragana, whitespace trimmed. Used as the key in the `readings` index.
 */
export function normalizeReading(reading) {
  return katakanaToHiragana(stripReadingMarkers(reading)).trim();
}
