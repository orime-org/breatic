// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Lay out the web-animation font set (inner#1711 design §3.6) from the pinned @fontsource-variable packages in this
 * package's devDependencies: every `wght-normal` woff2 slice of the four families into `<out>/v<version>/`, with
 * `faces.json` (family, file, unicode-range and weight of each slice, which the runner turns into the package's
 * @font-face rules) and each package's OFL text beside them.
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

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

/** The families of the set and the package each comes from; names match WEB_ANIMATION_FONT_FAMILIES. */
const FAMILIES = [
  ["Noto Sans SC", "@fontsource-variable/noto-sans-sc"],
  ["Noto Serif SC", "@fontsource-variable/noto-serif-sc"],
  ["Inter", "@fontsource-variable/inter"],
  ["Noto Sans KR", "@fontsource-variable/noto-sans-kr"],
];

const config = readFileSync(join(here, "../../../config/timeline.yaml"), "utf8");
const version = /^\s*font_set_version:\s*(\d+)\s*$/m.exec(config)?.[1];
if (version === undefined) throw new Error("config/timeline.yaml has no web_animation.font_set_version");

const out = join(resolve(process.argv[2] ?? join(here, "../assets/web-animation/fonts")), `v${version}`);
mkdirSync(out, { recursive: true });

const faces = [];
for (const [family, pkg] of FAMILIES) {
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
process.stdout.write(`web-animation font set v${version}: ${faces.length} faces in ${out}\n`);
