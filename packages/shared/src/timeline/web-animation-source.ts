// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Reading a source package back into the composition it was made from (#1490 design §5.2), so a modification starts
 * from what its base result showed.
 *
 * Packing inlines three blocks, the runtime, the bridge and the font stylesheet, at the first `</head>` (else the last
 * `</body>`, else after a newline at the end). Each block's text has every closing tag of its own element escaped, so
 * the first `\n</script>\n` or `\n</style>\n` after a block's opening ends it. A run of the three blocks the
 * composition happens to contain is told apart by where packing would have put them.
 */

const SCRIPT_OPEN = "<script>\n";
const SCRIPT_CLOSE = "\n</script>\n";
const STYLE_OPEN = "<style>\n";
const STYLE_CLOSE = "\n</style>\n";

/**
 * Where a run of the three inlined blocks starting at an offset ends.
 * @param html - The package.
 * @param at - Where the run would start.
 * @returns The offset just after it, or null when no run starts there.
 * @throws {never} Never.
 */
function blocksEnd(html: string, at: number): number | null {
  let cursor = at;
  for (const [open, close] of [[SCRIPT_OPEN, SCRIPT_CLOSE], [SCRIPT_OPEN, SCRIPT_CLOSE], [STYLE_OPEN, STYLE_CLOSE]] as const) {
    if (!html.startsWith(open, cursor)) return null;
    const end = html.indexOf(close, cursor + open.length);
    if (end < 0) return null;
    cursor = end + close.length;
  }
  return cursor;
}

/**
 * Whether packing a composition would put the blocks at this offset.
 * @param composition - The composition left once the blocks are taken out.
 * @param at - Where the blocks sat.
 * @param appended - Whether they followed the composition after a newline.
 * @returns True when the offset is where packing puts them.
 * @throws {never} Never.
 */
function packedHere(composition: string, at: number, appended: boolean): boolean {
  const lower = composition.toLowerCase();
  const head = lower.indexOf("</head>");
  const body = lower.lastIndexOf("</body>");
  if (appended) return head < 0 && body < 0;
  return head >= 0 ? head === at : body === at;
}

/**
 * The composition a source package was packed from.
 * @param html - The package.
 * @returns The composition.
 * @throws {Error} When the package holds no packed blocks.
 */
export function unpackWebAnimationSource(html: string): string {
  for (let at = html.indexOf(SCRIPT_OPEN); at >= 0; at = html.indexOf(SCRIPT_OPEN, at + 1)) {
    const end = blocksEnd(html, at);
    if (end === null) continue;
    if (end === html.length && at > 0 && html[at - 1] === "\n") {
      const composition = html.slice(0, at - 1);
      if (packedHere(composition, at - 1, true)) return composition;
    }
    const composition = html.slice(0, at) + html.slice(end);
    if (packedHere(composition, at, false)) return composition;
  }
  throw new Error("The package holds no packed web-animation blocks");
}
