// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/** Which comment syntaxes a file uses. */
export type CommentStyle = "css" | "js";

/** The quote characters that open a string in either language. */
const QUOTES = new Set(["'", '"', "`"]);

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
 * It tracks string literals, which it has to. A first version did not, and
 * `accept='image/*,video/*'` opened a block comment that never closed —
 * every line after it in that file became invisible to the checks reading
 * the result, and nothing said so. The same omission made a `//` inside a
 * URL blank the rest of its line. Both are worse than not stripping at all,
 * because the failure is silent and file-wide.
 *
 * Strings are tracked only well enough for this job: it knows escapes and
 * it does not attempt template-literal interpolation, where a comment
 * marker inside `${...}` is vanishingly unlikely and the cost of being
 * wrong is one unstripped comment rather than a blanked file.
 * @param text The file's contents.
 * @param style Which comment syntaxes to remove.
 * @returns The same text, same number of lines, with comments blanked.
 */
export function stripComments(text: string, style: CommentStyle): string {
  const out: string[] = [];
  let inBlock = false;
  // A string may span lines only when it is a template literal, so the
  // open quote has to survive across iterations.
  let inString: string | null = null;

  for (const line of text.split("\n")) {
    let result = "";
    let index = 0;

    while (index < line.length) {
      const character = line[index] ?? "";

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

      if (inString !== null) {
        result += character;
        if (character === "\\") {
          result += line[index + 1] ?? "";
          index += 2;
          continue;
        }
        if (character === inString) inString = null;
        index += 1;
        continue;
      }

      if (QUOTES.has(character)) {
        // A single- or double-quoted string cannot span lines; only a
        // template literal stays open, so the others close at end of line.
        inString = character;
        result += character;
        index += 1;
        continue;
      }

      const twoChars = line.slice(index, index + 2);
      if (twoChars === "/*") {
        inBlock = true;
        index += 2;
        continue;
      }
      if (style === "js" && twoChars === "//") break;

      result += character;
      index += 1;
    }

    if (inString !== null && inString !== "`") inString = null;
    out.push(result);
  }

  return out.join("\n");
}
