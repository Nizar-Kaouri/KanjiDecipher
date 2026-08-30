/**
 * Best-effort formation-type classification.
 *
 * KANJIDIC2 does not record how a character was formed, so this is a heuristic
 * derived from the KanjiVG component decomposition. It is deliberately coarse
 * and always tagged source = "heuristic"; the origin-story prompt is told the
 * classification is uncertain and to hedge accordingly.
 *
 * Types:
 *   phono-semantic         — one component is a pronunciation hint (kvg:phon)
 *   compound-ideographic   — 2+ meaning components combined, none phonetic
 *   pictographic-or-simple — single component / indivisible / == the character
 *   unknown                — not enough information
 */
export function classifyFormation(literal, components) {
  const parts = (components || []).filter((c) => c.element);

  if (parts.some((c) => c.isPhonetic)) {
    return { type: "phono-semantic", source: "heuristic" };
  }

  const distinct = parts.filter((c) => c.element !== literal);
  if (distinct.length <= 1) {
    return { type: "pictographic-or-simple", source: "heuristic" };
  }

  if (distinct.length >= 2) {
    return { type: "compound-ideographic", source: "heuristic" };
  }

  return { type: "unknown", source: "heuristic" };
}

/** Human-readable label for the UI. */
export const FORMATION_LABELS = {
  "phono-semantic": "Phono-semantic (meaning + sound hint)",
  "compound-ideographic": "Compound ideographic (combined meanings)",
  "pictographic-or-simple": "Pictographic or simple",
  unknown: "Uncertain",
};
