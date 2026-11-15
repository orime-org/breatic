// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Packing a composition into a source package, and reading a package back into the composition it was made from
 * (#1490 design §5.2), so a modification starts from what its base result showed.
 *
 * Packing inlines three blocks, the runtime, the bridge and the font stylesheet, at the first `</head>` (else the last
 * `</body>`, else after a newline at the end). Reading takes the same three pieces: the composition is what is left
 * once that exact run of blocks is taken out, checked by packing it again. A composition whose own text holds what
 * looks like a block opening is therefore read back as it was written.
 */

/** The three texts a package inlines. */
export interface WebAnimationInlinePieces {
  /** The HyperFrames runtime. */
  runtime: string;
  /** The frame-ready bridge. */
  bridge: string;
  /** The font set's stylesheet. */
  fontStylesheet: string;
}

/**
 * Keep inlined text from ending its element early.
 * @param text - Script or stylesheet text.
 * @param tag - The element it goes into.
 * @returns The text, with every closing tag of that element and every comment opener escaped.
 * @throws {never} Never.
 */
function inlineSafe(text: string, tag: "script" | "style"): string {
  return text.replace(new RegExp(`</(${tag})`, "gi"), "<\\/$1").replace(/<!--/g, "<\\!--");
}

/**
 * The run of three blocks a package inlines.
 * @param pieces - The texts.
 * @returns The run.
 * @throws {never} Never.
 */
function inlinedBlocks(pieces: WebAnimationInlinePieces): string {
  return `<script>\n${inlineSafe(pieces.runtime, "script")}\n</script>\n` +
    `<script>\n${inlineSafe(pieces.bridge, "script")}\n</script>\n` +
    `<style>\n${inlineSafe(pieces.fontStylesheet, "style")}\n</style>\n`;
}

/**
 * Build the package: the model's composition with the runtime, then the bridge, then the font stylesheet inlined at
 * the end of its head (its body, or its end, when it has none), so the package references no file but the font set
 * and the runtime is loaded before the composition's own scripts run.
 * @param pieces - The composition and the three texts to inline.
 * @param pieces.composition - The composition the model wrote.
 * @returns The package's HTML.
 * @throws {never} Never.
 */
export function packWebAnimationSource(pieces: WebAnimationInlinePieces & { composition: string }): string {
  const inlined = inlinedBlocks(pieces);
  const lower = pieces.composition.toLowerCase();
  const head = lower.indexOf("</head>");
  const at = head >= 0 ? head : lower.lastIndexOf("</body>");
  if (at < 0) return `${pieces.composition}\n${inlined}`;
  return `${pieces.composition.slice(0, at)}${inlined}${pieces.composition.slice(at)}`;
}

/**
 * The composition a package was packed from with these pieces. Every package so far was packed with the runtime the
 * images carry; a release that changes the runtime reads older packages with the runtime they name in their Manifest.
 * @param html - The package.
 * @param pieces - The texts it was packed with.
 * @returns The composition.
 * @throws {Error} When the package was not packed with these pieces.
 */
export function unpackWebAnimationSource(html: string, pieces: WebAnimationInlinePieces): string {
  const inlined = inlinedBlocks(pieces);
  for (let at = html.indexOf(inlined); at >= 0; at = html.indexOf(inlined, at + 1)) {
    const end = at + inlined.length;
    const candidates = [html.slice(0, at) + html.slice(end)];
    if (end === html.length && at > 0 && html[at - 1] === "\n") candidates.unshift(html.slice(0, at - 1));
    for (const composition of candidates) {
      if (packWebAnimationSource({ composition, ...pieces }) === html) return composition;
    }
  }
  throw new Error("The package was not packed with these pieces");
}
