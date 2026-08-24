// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/** Which comment syntaxes a file uses. */
export type CommentStyle = "css" | "js";

/** The quote characters that open a string in either language. */
const QUOTES = new Set(["'", '"', "`"]);

/**
 * Characters after which a slash begins a regular expression, not a division.
 *
 * The distinction is not decidable from the slash alone — it is the one place
 * JavaScript's grammar needs to know what came before. This is the standard
 * approximation: a slash divides only when something dividable precedes it,
 * which is an identifier, a number, or a closing bracket.
 */
const BEFORE_REGEX = new Set([
  "(",
  ",",
  "=",
  ":",
  "[",
  "!",
  "&",
  "|",
  "?",
  "{",
  "}",
  ";",
  "+",
  "-",
  "*",
  "%",
  "~",
  "^",
  "<",
  ">",
  "\n",
]);

/** Keywords after which a slash begins a regular expression. */
const BEFORE_REGEX_WORDS = new Set([
  "return",
  "typeof",
  "case",
  "in",
  "of",
  "new",
  "delete",
  "void",
  "instanceof",
  "do",
  "else",
  "yield",
  "await",
]);

/**
 * Whether a slash at this point opens a regular expression.
 * @param before Everything emitted on this line before the slash.
 * @returns True when a regular expression may start here.
 */
function opensRegex(before: string): boolean {
  const trimmed = before.trimEnd();
  if (trimmed.length === 0) return true;
  const last = trimmed.at(-1) ?? "";
  if (BEFORE_REGEX.has(last)) return true;
  return BEFORE_REGEX_WORDS.has(/[A-Za-z$_]+$/.exec(trimmed)?.[0] ?? "");
}

/**
 * Where a regular expression starting at `start` ends on this line.
 *
 * A regular expression cannot span lines, so failing to find the terminator
 * here means this slash was never one — and answering "not a regex" costs at
 * most one unstripped comment, where answering "regex" wrongly would swallow
 * real code.
 * @param line The line being scanned.
 * @param start Index of the opening slash.
 * @returns Index just past the closing slash, or -1 when there is none.
 */
function regexEnd(line: string, start: number): number {
  let inClass = false;
  for (let index = start + 1; index < line.length; index += 1) {
    const character = line[index];
    if (character === "\\") {
      index += 1;
      continue;
    }
    if (character === "[") inClass = true;
    else if (character === "]") inClass = false;
    else if (character === "/" && !inClass) return index + 1;
  }
  return -1;
}

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
 * Regular expressions are tracked for the same reason strings are, and were
 * missed for longer: `/[/*]/` is ordinary code, and reading the `/*` in it as
 * an opener blanked every following line of that file. The two never actually
 * compete — no regular expression can begin with `*` or `/` — so the comment
 * openers are settled first and the slash is only reconsidered afterwards.
 *
 * Strings and regular expressions are tracked only well enough for this job:
 * it knows escapes, it does not attempt template-literal interpolation, and
 * it decides regex-versus-division from the preceding token the way every
 * tokenizer does. Each approximation is chosen so that being wrong costs one
 * unstripped comment rather than a blanked file.
 *
 * Whatever the cause, a block that never closes is refused rather than
 * returned. A caller handed text that goes blank partway through cannot tell
 * it from text with nothing in it, so the mistake would surface as every
 * check reporting clean.
 * @param text The file's contents.
 * @param style Which comment syntaxes to remove.
 * @param source Where the text came from, named in the error. Without it the
 *   refusal says a block comment is unterminated somewhere in the repository
 *   and leaves the reader to find which file.
 * @returns The same text, same number of lines, with comments blanked.
 * @throws {Error} When a block comment opens and never closes.
 */
export function stripComments(
  text: string,
  style: CommentStyle,
  source = "this text",
): string {
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

      // Only after the two comment openers have been ruled out, because no
      // regular expression can begin with `*` or `/` — `/*/` has a quantifier
      // with nothing to repeat. Checking the openers first is therefore free,
      // and checking the regex first would eat every block comment that sits
      // where an operand belongs.
      if (style === "js" && character === "/" && opensRegex(result)) {
        const end = regexEnd(line, index);
        if (end !== -1) {
          result += line.slice(index, end);
          index = end;
          continue;
        }
      }

      result += character;
      index += 1;
    }

    if (inString !== null && inString !== "`") inString = null;
    out.push(result);
  }

  if (inBlock) {
    throw new Error(
      `${source}: a block comment opens and never closes, so it goes blank partway through. ` +
        "Returning it would hand the caller a file it cannot tell from an empty one, and every " +
        "check reading it would report clean on lines it never saw.",
    );
  }

  return out.join("\n");
}
