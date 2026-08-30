/**
 * Generate the PWA / touch icons into web/public/icons/.
 * One-off build step — the PNGs are committed. Re-run after changing the mark:
 *
 *   npm run icons        (needs the `sharp` devDependency)
 */
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const here = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(here, "public", "icons");
fs.mkdirSync(OUT, { recursive: true });

const BG = "#b0472b"; // --accent
const FG = "#fbf9f5"; // --bg (light)

function svg(size) {
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">
      <rect width="${size}" height="${size}" fill="${BG}"/>
      <text x="${size * 0.512}" y="${size * 0.766}" text-anchor="middle"
            font-family="Yu Gothic, Meiryo, 'Hiragino Sans', sans-serif"
            font-weight="700" font-size="${size * 0.629}" fill="${FG}">字</text>
    </svg>`,
  );
}

const targets = [
  ["icon-192.png", 192],
  ["icon-512.png", 512],
  ["apple-touch-icon.png", 180],
];

for (const [name, size] of targets) {
  await sharp(svg(size))
    .flatten({ background: BG }) // opaque — no alpha (iOS home-screen icons dislike it)
    .png()
    .toFile(path.join(OUT, name));
  console.log("  wrote", path.join("web/public/icons", name), `(${size}×${size})`);
}
console.log("done");
