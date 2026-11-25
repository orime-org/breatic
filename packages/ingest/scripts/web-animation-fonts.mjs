// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * Lay out the web-animation font set (inner#1711 design §3.6) from the pinned @fontsource-variable packages in this
 * package's devDependencies: every `wght-normal` woff2 slice of the six families into `<out>/v<version>/`, with
 * `faces.json` (family, file, unicode-range and weight of each slice, which the runner turns into the package's
 * @font-face rules) and each package's OFL text beside them.
 *
 * Every earlier version is laid out too, from the families it held: a stored package names the set it was packed
 * with, so modifying, exporting and previewing an older result reads that set. A version only ever adds families,
 * so a new family names the version it joined in.
 *
 * Beside `faces.json` each version gets `glyphs.json` (inner#1709): for every slice, the code points its
 * woff2 really holds (read with fontkit) cut to its `unicodeRange`, made disjoint inside each family by giving every
 * code point to the last face in `faces.json` order that has its glyph, the face CSS Fonts 4 §4.5 has an export look at
 * first. A face left with nothing is not written. `faces.json` itself never changes: a version's files are served
 * immutable, so a change to either file means a new version.
 *
 * The Worker serves the result as static assets (`assets/web-animation/fonts`) and the web-animation image carries
 * the same files, so the stylesheet a package embeds and the files the preview loads always come from one build.
 * The version is `web_animation.font_set_version` in config/timeline.yaml.
 *
 * Usage: node scripts/web-animation-fonts.mjs [out-dir]   (default: assets/web-animation/fonts)
 */

import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { openSync as openFont } from "fontkit";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

/** The families of the set, the package each comes from and the version it joined in; names match WEB_ANIMATION_FONT_FAMILIES. */
const FAMILIES = [
  ["Noto Sans SC", "@fontsource-variable/noto-sans-sc", 1],
  ["Noto Serif SC", "@fontsource-variable/noto-serif-sc", 1],
  ["Inter", "@fontsource-variable/inter", 1],
  ["Noto Sans KR", "@fontsource-variable/noto-sans-kr", 2],
  ["Noto Sans JP", "@fontsource-variable/noto-sans-jp", 3],
  ["Noto Sans TC", "@fontsource-variable/noto-sans-tc", 3],
];

const config = readFileSync(join(here, "../../../config/timeline.yaml"), "utf8");
const version = /^\s*font_set_version:\s*(\d+)\s*$/m.exec(config)?.[1];
if (version === undefined) throw new Error("config/timeline.yaml has no web_animation.font_set_version");

/**
 * Every code point a CSS unicode-range value names.
 * @param {string} range - A comma-separated unicode-range value.
 * @returns {Set<number>} Its code points.
 */
function codePointsOf(range) {
  const points = new Set();
  for (const token of range.split(",")) {
    const body = token.trim().slice(2);
    const [low, high] = body.includes("-")
      ? body.split("-").map((hex) => Number.parseInt(hex, 16))
      : [Number.parseInt(body.replace(/\?/g, "0"), 16), Number.parseInt(body.replace(/\?/g, "F"), 16)];
    for (let point = low; point <= high; point += 1) points.add(point);
  }
  return points;
}

/**
 * A unicode-range value naming exactly the given code points, consecutive ones as one span.
 * @param {number[]} points - Code points, ascending.
 * @returns {string} The value, as `U+0020-007E,U+00A0`.
 */
function rangeOf(points) {
  const hex = (point) => point.toString(16).toUpperCase().padStart(4, "0");
  const spans = [];
  for (let start = 0; start < points.length; ) {
    let end = start;
    while (end + 1 < points.length && points[end + 1] === points[end] + 1) end += 1;
    spans.push(end === start ? `U+${hex(points[start])}` : `U+${hex(points[start])}-${hex(points[end])}`);
    start = end + 1;
  }
  return spans.join(",");
}

/** Each slice's character set by file name; a file is the same bytes in every version that holds it. */
const characterSets = new Map();

/**
 * The glyph ranges of one version's faces: each code point to the last face of its family that has its glyph.
 * @param {string} dir - The version directory, holding the faces' woff2 files.
 * @param {{ family: string, file: string, unicodeRange: string }[]} faces - Its faces, in faces.json order.
 * @returns {{ file: string, glyphRange: string }[]} One entry per face that owns any code point, in faces.json order.
 */
function glyphsOf(dir, faces) {
  const owner = new Map();
  for (const face of faces) {
    if (!characterSets.has(face.file)) characterSets.set(face.file, openFont(join(dir, `${face.file}.woff2`)).characterSet);
    const range = codePointsOf(face.unicodeRange);
    for (const point of characterSets.get(face.file)) if (range.has(point)) owner.set(`${face.family}\u0000${String(point)}`, face.file);
  }
  const owned = new Map(faces.map((face) => [face.file, []]));
  for (const [key, file] of owner) owned.get(file).push(Number(key.split("\u0000")[1]));
  return faces
    .map((face) => ({ file: face.file, points: owned.get(face.file).sort((a, b) => a - b) }))
    .filter(({ points }) => points.length > 0)
    .map(({ file, points }) => ({ file, glyphRange: rangeOf(points) }));
}

const root = resolve(process.argv[2] ?? join(here, "../assets/web-animation/fonts"));
for (let set = 1; set <= Number(version); set += 1) {
  const out = join(root, `v${set}`);
  mkdirSync(out, { recursive: true });
  const faces = [];
  for (const [family, pkg] of FAMILIES.filter(([, , since]) => since <= set)) {
    const css = readFileSync(require.resolve(`${pkg}/index.css`), "utf8");
    const files = dirname(require.resolve(`${pkg}/index.css`));
    for (const [, rule] of css.matchAll(/@font-face\s*\{([^}]*)\}/g)) {
      const file = /url\(\.\/files\/([^)]+)\.woff2\)/.exec(rule)?.[1];
      const unicodeRange = /unicode-range:\s*([^;]+);/.exec(rule)?.[1];
      const weight = /font-weight:\s*([^;]+);/.exec(rule)?.[1];
      if (file === undefined || unicodeRange === undefined) throw new Error(`${pkg}/index.css has a face without a file or range`);
      copyFileSync(join(files, "files", `${file}.woff2`), join(out, `${file}.woff2`));
      faces.push({ family, file, unicodeRange: unicodeRange.trim(), ...(weight !== undefined && { weight: weight.trim() }) });
    }
    copyFileSync(require.resolve(`${pkg}/LICENSE`), join(out, `${pkg.split("/")[1]}-OFL.txt`));
  }
  writeFileSync(join(out, "faces.json"), `${JSON.stringify(faces, null, 2)}\n`);
  writeFileSync(join(out, "glyphs.json"), `${JSON.stringify(glyphsOf(out, faces), null, 2)}\n`);
  process.stdout.write(`web-animation font set v${set}: ${faces.length} faces in ${out}\n`);
}
