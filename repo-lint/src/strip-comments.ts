// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/** Which comment syntaxes a file uses. */
export type CommentStyle = "css" | "js";

/**
 * Blanks out comments while keeping every line in place.
 *
 * Blanking rather than deleting is the whole point: a stripper that removes
 * lines shifts every line number after it. The awk version these checks
 * replace did exactly that — its loop did not execute on an empty line, so
 * blank lines vanished and every reported line number after the first one
 * was too low. On a file carrying the mandated two-line SPDX header that is
 * an error on the very first report.
 *
 * Deliberately simple: it does not know that `"// not a comment"` is a
 * string. A check whose subject can appear inside a string literal wants an
 * AST and belongs in ESLint, not here; the checks that use this look for
 * tokens that are the same thing whether quoted or not.
 * @param text The file's contents.
 * @param style Which comment syntaxes to remove.
 * @returns The same text, same number of lines, with comments blanked.
 */
export function stripComments(text: string, style: CommentStyle): string {
  const lines = text.split("\n");
  const out: string[] = [];
  let inBlock = false;

  for (const line of lines) {
    let result = "";
    let index = 0;

    while (index < line.length) {
      if (inBlock) {
        const close = line.indexOf("*/", index);
        if (close === -1) {
          index = line.length;
        } else {
          index = close + 2;
          inBlock = false;
        }
        continue;
      }

      const blockOpen = line.indexOf("/*", index);
      const lineOpen = style === "js" ? line.indexOf("//", index) : -1;
      const first =
        lineOpen !== -1 && (blockOpen === -1 || lineOpen < blockOpen)
          ? lineOpen
          : blockOpen;

      if (first === -1) {
        result += line.slice(index);
        break;
      }
      result += line.slice(index, first);
      if (first === lineOpen) break;
      index = first + 2;
      inBlock = true;
    }

    out.push(result);
  }

  return out.join("\n");
}
