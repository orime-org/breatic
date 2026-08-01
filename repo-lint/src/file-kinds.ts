// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * File kinds whose bytes are not text, skipped without opening them.
 *
 * A fast path, not the decision — the content sniff below is what actually
 * settles it, so a kind missing from this list is still kept out of every
 * text scan. Two earlier versions of this comment put the cost of that
 * omission too low. The first said it was a wasted read; measured, 20 KB of
 * random bytes handed to no-trojan-source produced 2400 findings, one per
 * control character, which is how a real finding gets buried. The second
 * repeated the wasted-read claim after no-silent-skip made the omission
 * report a finding of its own: a kind nobody lists now fails the build until
 * somebody decides whether it is binary or is broken text.
 */
const BINARY =
  /\.(png|jpe?g|gif|webp|avif|ico|icns|bmp|woff2?|ttf|otf|eot|pdf|zip|t?gz|bz2|mp4|mov|webm|mp3|wav|m4a|wasm)$/i;

/** How much of a file decides whether it is text — the length git reads. */
const SNIFF = 8000;

/**
 * Whether what was read is text rather than bytes.
 *
 * A NUL byte is the signal git itself uses, and it is the one that survives
 * being read as UTF-8. Decoding failures are the second signal: bytes that
 * are not valid UTF-8 arrive as U+FFFD, and a file that is mostly those is
 * not text in any useful sense. Both are judged over the opening of the file
 * only, so the cost does not grow with its size.
 *
 * Saying no here removes a file from every content scan at once, so the
 * no-silent-skip check reports each file this rejects that the binary list
 * above does not already account for. A subtraction nobody can see is the
 * failure this suite exists to remove, and this used to be one.
 * @param text The file's contents, decoded as UTF-8.
 * @returns True when a text scan can say something meaningful about it.
 */
export function isTextContent(text: string): boolean {
  const opening = text.slice(0, SNIFF);
  if (opening.includes("\u0000")) return false;
  const undecodable = (opening.match(/\uFFFD/g) ?? []).length;
  return undecodable / Math.max(opening.length, 1) < 0.1;
}

/**
 * Whether a text scan can read this file.
 *
 * Every check asking "does this file contain X" starts from every tracked
 * file and subtracts what it cannot read. The inverse — starting from a list
 * of extensions somebody thought of — fails silently: a file kind nobody
 * listed is never opened, and the check reports clean.
 *
 * That is not hypothetical. Of the four bypass residues that motivated
 * no-auth-bypass-residue, three lived where an extension list does not
 * reach: a Dockerfile with no extension at all, and both env templates. The
 * same miss in the secret scan is a published credential rather than a stale
 * mention, so the direction of the list matters most exactly where it used
 * to be wrong.
 * @param path Repo-relative path.
 * @returns True when the file is text some scan can read.
 */
export function isScannableText(path: string): boolean {
  return !BINARY.test(path);
}

/**
 * The lockfile, which is machine-authored.
 *
 * Exempted only from checks about how people write, never from checks about
 * what a file contains: a registry URL carrying an access token, or a git
 * dependency naming a private repository, lands here like anywhere else.
 */
export const GENERATED = /(^|\/)pnpm-lock\.yaml$/;

/**
 * Test files, which several checks exempt for the same reason.
 *
 * Their content is fixture data rather than something the product ships, so
 * a rule about what ships does not reach them.
 *
 * The suffix half covers every TypeScript extension rather than the two that
 * happen to exist today. A caller whose own pattern admits `.mts` while this
 * one does not gets a file that is test material by name and shipped code by
 * scope — a seam nobody would think to look for, since both regexes read as
 * if they agree about which extensions there are.
 *
 * It cuts both ways, and both are wanted. Callers that use this to EXEMPT
 * (no-cjk) now exempt `.test.mts` too, so a Chinese fixture string in one
 * stops being a violation; callers that use it to SUBTRACT from a scan
 * (i18n-no-dead-keys) now subtract it, so it stops reading as shipped code.
 * Either way the answer follows from the file being test material, which is
 * what this constant is for — and neither had it before, because the
 * extensions disagreed. No tracked file changes verdict today; both suites
 * pin the extensions so a future one cannot slip through either side.
 */
export const TEST_FILE = /(^|\/)__tests__\/|\.(test|spec)\.([cm]?ts|tsx)$/;
