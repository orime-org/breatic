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
 * Source that ships to users: under a package's `src`, in TypeScript.
 *
 * Both i18n key checks ask a question about shipped text — one that every
 * catalog message has a reader, the other that every message a source names
 * exists — so both need the same answer to "which files count", and there is
 * one copy of it here rather than one each. The reasoning below was written
 * for the dead-key check and moved here with the constant, because it explains
 * the constant rather than either check.
 *
 * Test material is subtracted by `TEST_FILE`, which knows it by directory and
 * by suffix. That misses scaffolding kept beside the code it serves —
 * `packages/web/src/test-utils/a11y.ts` and `packages/core/src/db/
 * test-support.ts` are both under `src`, are named like modules, and are
 * imported only by tests. They stay in the scan, deliberately.
 *
 * A content sniff was tried and reverted. It skipped any file whose raw text
 * matched an import of vitest — comments included. To size that, a probe
 * comment naming the import was pasted into one shipped component and the
 * dead-key check run: it dropped the file and reported 37 live keys for
 * deletion. No such comment exists in the tree, so this is what the mechanism
 * permits rather than something it did; the point is that a code comment is
 * enough to trigger it. The sniff also missed the scaffolding it was written
 * for, since `test-support.ts` imports drizzle. So it bought a cheap risk (a
 * helper keeping a dead key alive one more sweep) by taking on the expensive
 * one (a live key deleted, a raw id in the UI), which is backwards from the
 * asymmetry the dead-key check is built around. If a helper here ever does
 * hold up a dead key, move the helper into `__tests__/`; do not teach the scan
 * to guess from content.
 *
 * What keeps `repo-lint/` and `eslint-rules/` — including the checks
 * themselves — out of their own scans is the `<pkg>/src/` shape, not the
 * `packages/` word: both of those workspaces put their source one level
 * higher, at `<root>/src`, so they fall out on depth alone. Removing
 * `packages/` would change nothing today, which is exactly why it is worth
 * saying — the word states an intent the depth happens to enforce.
 *
 * The intent is that only what ships is scanned, and it cuts the expensive way
 * if it is ever wrong: a workspace added outside `packages/` that does read
 * the catalogs would be invisible, and every key only it reads would be
 * reported dead and deleted. Widen this pattern when that happens rather than
 * exempting the keys.
 *
 * Nothing outside TypeScript is here because nothing outside TypeScript reads
 * a key: a sweep of every tracked non-TS, non-Markdown file found zero naming
 * one. That is a measurement, not a guarantee — if a config ever does, the
 * dead-key check reports the key, and widening this pattern is the fix.
 *
 * Widening has a floor. The `packages/<pkg>/src` shape cannot go: dropping it
 * lets a check read its own worked examples, which is the defect this scope
 * exists to close. Three tests in the dead-key suite hold it there — a
 * package-shaped tree outside `packages/` is not scanned, this check's own
 * source is not scanned, and its own source cannot keep a key alive. Widen
 * within the shape: another extension, another path under it.
 */
export const APPLICATION_SOURCE = /^packages\/[^/]+\/src\/.*\.([cm]?ts|tsx)$/;

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
 *
 * A third copy of this concept lives in
 * `eslint-rules/src/rules/test-file-location.ts` — separate package, cannot
 * import this one — and it does NOT cover the same extensions. Aligning it
 * was tried and reverted: the two flat configs that turn that rule on select
 * only `{ts,tsx}`, so ESLint never hands it a `.mts` whatever its own regex
 * says, and widening the regex alone is dead code that reads like a fix.
 * Closing it means the rule, both configs, and the spec paragraph in
 * docs/ARCHITECTURE.md moving together, which is its own change.
 */
export const TEST_FILE = /(^|\/)__tests__\/|\.(test|spec)\.([cm]?ts|tsx)$/;
