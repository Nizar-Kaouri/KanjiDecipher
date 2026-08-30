/**
 * RADKFILE / KRADFILE use a handful of ordinary JIS characters as stand-ins for
 * radical *forms* that have no standalone code point in common fonts (or did not
 * when the files were created). Map those to the form people expect to see in a
 * radical picker. Anything not listed is shown as-is.
 */
export const RADICAL_DISPLAY = {
  "汁": "氵", // water, left
  "扎": "扌", // hand, left
  "忙": "忄", // heart, left
  "犯": "犭", // dog, left
  "礼": "礻", // spirit / show, left
  "初": "衤", // clothes, left
  "艾": "艹", // grass, top
  "邦": "⻏", // city, right
  "阡": "⻖", // mound, left
  "込": "⻌", // movement
  "化": "亻", // person, left
  "个": "𠆢", // person, roof
  "并": "丷", // eight, top
  "刈": "刂", // sword, right
  "尚": "⺌", // small, top
  "杰": "灬", // fire, bottom
  "老": "耂", // old, top
};

export function radicalDisplay(part) {
  return RADICAL_DISPLAY[part] ?? part;
}
