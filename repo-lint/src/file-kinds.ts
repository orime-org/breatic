// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * File kinds whose bytes are not text, skipped without opening them.
 *
 * A fast path, not the decision. An earlier version of this comment claimed
 * the whole cost of an omission here was a wasted read — that was measured
 * and is false: 20 KB of random bytes handed to no-trojan-source produced
 * 2400 findings, one per control character, which is how a real finding gets
 * buried. The content sniff below is what actually decides, so a kind nobody
 * listed costs a read and nothing else.
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
 */
export const TEST_FILE = /(^|\/)__tests__\/|\.(test|spec)\.(ts|tsx)$/;
