/**
 * Build clean, self-contained stroke-order SVGs from KanjiVG path data.
 *
 * KanjiVG uses a 109x109 viewBox. We emit one <path> per stroke in stroke
 * order, tagged with data-stroke (0-based order) and data-component (index into
 * the kanji's component list, or -1). The frontend measures each path with
 * getTotalLength() to animate it, and toggles a highlight class by
 * data-component. The static variant adds numbered markers for the no-JS case.
 */

const VIEWBOX = "0 0 109 109";

function escapeAttr(s) {
  return String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

/** First moveto coordinate of an SVG path's `d` string. */
export function pathStart(d) {
  const m = d.match(/[Mm]\s*(-?[\d.]+)[ ,]+(-?[\d.]+)/);
  if (!m) return { x: 0, y: 0 };
  return { x: parseFloat(m[1]), y: parseFloat(m[2]) };
}

/**
 * @param {{d:string,type?:string,component:number}[]} strokes
 */
export function buildInteractiveSvg(strokes) {
  const paths = strokes
    .map(
      (s, i) =>
        `<path class="kvg-stroke" data-stroke="${i}" data-component="${s.component ?? -1}" d="${escapeAttr(s.d)}"/>`,
    )
    .join("");
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${VIEWBOX}" class="kvg" role="img">` +
    `<g fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round">` +
    paths +
    `</g></svg>`
  );
}

/**
 * @param {{d:string,component:number}[]} strokes
 */
export function buildStaticSvg(strokes) {
  const paths = strokes
    .map(
      (s, i) =>
        `<path data-stroke="${i}" data-component="${s.component ?? -1}" d="${escapeAttr(s.d)}"/>`,
    )
    .join("");
  const labels = strokes
    .map((s, i) => {
      const { x, y } = pathStart(s.d);
      return `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" class="kvg-num">${i + 1}</text>`;
    })
    .join("");
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${VIEWBOX}" class="kvg kvg-static" role="img">` +
    `<g fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round">` +
    paths +
    `</g>` +
    `<g class="kvg-nums" fill="#c0392b" stroke="none" font-size="8" font-family="sans-serif">` +
    labels +
    `</g></svg>`
  );
}
