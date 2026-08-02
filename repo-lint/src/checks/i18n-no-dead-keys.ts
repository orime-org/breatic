// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0
import type { Check, CheckContext, Finding } from "#repo-lint/check";
import { TEST_FILE } from "#repo-lint/file-kinds";

/** English is the source catalog; the others are translations of it. */
const SOURCE_CATALOG = "locales/en.json";

/**
 * Where an application source lives: under a package's `src`, in TypeScript.
 *
 * Test material is subtracted by `TEST_FILE`, which knows it by directory and
 * by suffix. That misses scaffolding kept beside the code it serves —
 * `packages/web/src/test-utils/a11y.ts` and `packages/core/src/db/
 * test-support.ts` are both under `src`, are named like modules, and are
 * imported only by tests. They stay in the scan, deliberately.
 *
 * A content sniff was tried and reverted, and the reason is the whole design
 * of this check. It skipped any file whose raw text matched an import of
 * vitest — comments included. To size that, a probe comment naming the import
 * was pasted into one shipped component and the check run: it dropped the
 * file and reported 37 live keys for deletion. No such comment exists in the
 * tree, so this is what the mechanism permits rather than something it did;
 * the point is that a code comment is enough to trigger it. The sniff also
 * missed the scaffolding it was written for, since `test-support.ts` imports
 * drizzle. So it bought a cheap risk (a helper keeping a dead key alive one
 * more sweep) by taking on the expensive one (a live key deleted, a raw id in
 * the UI), which is backwards from the asymmetry this check is built around.
 * If a helper here ever does hold up a dead key, move the helper into
 * `__tests__/`; do not teach the scan to guess from content.
 *
 * The question this check asks is "does deleting this key change what a user
 * sees", so the files whose word counts are the ones that ship. Everything
 * else merely *names* a key — a test fixture, a sentence in a spec, this
 * check's own worked example — and a key held up only by those is dead along
 * with whatever names it.
 *
 * What keeps `repo-lint/` — this file included — out of its own scan is the
 * `<pkg>/src/` shape, not the `packages/` word: both workspaces outside
 * `packages/` (`eslint-rules`, `repo-lint`) put their source one level higher,
 * at `<root>/src`, so they fall out on depth alone. Removing `packages/` from
 * this pattern changes nothing today, which is exactly why it is worth saying
 * — the word states an intent the depth happens to enforce.
 *
 * The intent is that only what ships to users is scanned, and it cuts the
 * expensive way if it is ever wrong: a workspace added outside `packages/`
 * that does read the catalogs would be invisible, and every key only it reads
 * would be reported dead and deleted. Widen this pattern when that happens
 * rather than exempting the keys.
 *
 * Nothing outside TypeScript is here because nothing outside TypeScript reads
 * a key: a sweep of every tracked non-TS, non-Markdown file found zero naming
 * one. That is a measurement, not a guarantee — if a config ever does, this
 * check reports the key, and widening this pattern is the fix. There is no
 * per-key exemption list to reach for, deliberately: an empty one existed for
 * three commits, was never used, and made its own call site impossible to
 * test end to end. Add the mechanism when a key needs it, with that key in it.
 *
 * Widening has a floor. The `packages/<pkg>/src` shape is pinned by three
 * tests and cannot go — dropping it lets this check read its own docstring
 * again, which is the defect the scope exists to close. Widen within it:
 * another extension, another path. And reviving a key deleted by an earlier
 * sweep takes a second edit nothing else announces — its row in
 * REMOVED_DEAD_KEYS asserts the key is absent from all five catalogs, so
 * putting it back fails five tests until that row goes too.
 */
const APPLICATION_SOURCE = /^packages\/[^/]+\/src\/.*\.([cm]?ts|tsx)$/;

/**
 * Collects every leaf key in a catalog as its dotted path.
 * @param value A parsed catalog or one of its subtrees.
 * @param prefix The dotted path accumulated so far.
 * @param out Where to collect the keys.
 * @returns Every leaf key, as dotted paths.
 */
function leafKeys(value: unknown, prefix = "", out: string[] = []): string[] {
  if (typeof value === "string") {
    out.push(prefix);
    return out;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      leafKeys(child, prefix === "" ? key : `${prefix}.${key}`, out);
    }
  }
  return out;
}

/**
 * A dotted identifier anywhere in a file — `canvas.upload.tooLarge`.
 *
 * Every id has a dot to anchor on, and that part is a guarantee rather than an
 * observation: `i18n-keys-namespaced` fails the build on a catalog key that
 * has none. Without it this pattern would need a companion that reads the id
 * out of the translation call instead, and there was one — a second matching
 * path, covering strictly less, kept only for two keys.
 *
 * Read that carefully, because it is only half of what this pattern asks. A
 * dot is necessary; it is not sufficient. Every SEGMENT here must also begin
 * with a letter, and nothing upstream guarantees that. One catalog key already
 * fails it: `canvas.nodePlaceholder.3d`, in all five locales. It is alive only
 * because the one file that reads it builds the id with a template literal, so
 * `TEMPLATE_PREFIX` covers the whole namespace; rewrite that line as a plain
 * `t('canvas.nodePlaceholder.3d')` — the form the very next line of that file
 * uses — and this check reports a live key dead. The removed second path did
 * match it, since its character class allowed a digit to lead a segment.
 *
 * So the removal traded a real, narrow piece of coverage for one matching path
 * instead of two. That trade is deliberate and the residue is written down
 * rather than papered over; closing it (align the two shapes, or rename the
 * key) is tracked as its own task.
 *
 * Widening this to bare words is not the alternative it looks like. `cancel`
 * and `loading` are ordinary words that appear all over the tree as enum
 * members and state literals (`z.enum(["confirm", "cancel"])`, `phase ===
 * 'loading'`), so a bare-word pattern would count every one of them as a use
 * and exempt every short key forever.
 */
const DOTTED_LITERAL = /[a-zA-Z][\w-]*(?:\.[a-zA-Z][\w-]*)+/g;

/**
 * The static head of an interpolated id — the `` `canvas.upload.${x}` `` form.
 * The trailing dot is kept, so the prefix cannot swallow a sibling subtree
 * whose name merely starts with the same letters.
 */
const TEMPLATE_PREFIX = /`([a-zA-Z][\w-]*(?:\.[a-zA-Z][\w-]*)*\.)\$\{/g;

/**
 * Every message in the catalogs is reachable from the code.
 *
 * A key nobody reads costs five translations and reads, to whoever finds it,
 * as a feature that exists.
 *
 * A use means an application source names the key: a dotted literal anywhere
 * in it, quoted or not, or the static head of an interpolated id, which is how
 * an id built from a variable suffix keeps every key beneath it. Files that
 * merely name a key without reading it — tests, specs, this check itself — are
 * outside `APPLICATION_SOURCE`, because a key held up only by them is dead
 * along with whatever names it. Measured when that scope was set: twelve keys
 * were alive on nothing but a test fixture or a sentence in a spec.
 *
 * One matching path, not two, and that rests on `i18n-keys-namespaced`: every
 * id has a dot because that check fails the build on a catalog key without
 * one. Delete it and this one starts reporting live keys as dead — the shape
 * it forbids is a shape `DOTTED_LITERAL` cannot see. A shape, not every shape:
 * the two are not the same set, and where they differ is spelled out on
 * `DOTTED_LITERAL` below. Nothing enforces that dependency mechanically, so
 * deleting the upstream check leaves this suite green.
 *
 * Within that scope the matching stays generous, since the two mistakes do not
 * cost the same: a live key called dead ships a raw id to the UI, while a dead
 * key called live only survives another pass.
 *
 * How generous, stated plainly: `DOTTED_LITERAL` cannot tell a message id from
 * any other dotted expression, so ordinary property access counts. Measured by
 * fabricating twelve keys named like code — nine survived, among them
 * `user.email`, `canvas.width`, and `Math.max`. A dead key whose name collides
 * with a common expression is therefore invisible here. Narrowing it means
 * matching the translation call *instead of* the mention — a smaller set, and
 * the opposite direction from the call-matching that was removed alongside the
 * dotless keys, which was a second path unioned *onto* this one. Worth not
 * confusing, since both are described as "matching the call". What must not
 * happen is reading the scope above as if it closed this too.
 *
 * One honest caveat about the self-exclusion. This check no longer reads its
 * own source, which closes a real mechanism — the tests below pin it — but on
 * this repository it closed nothing observable: every namespace the examples
 * here mention (`canvas.upload`, `common.cancel`) is independently alive in
 * application code, so no key\'s verdict changed. The mechanism was worth
 * closing; the evidence for it is the test, not a measured deletion.
 */
export const i18nNoDeadKeys = {
  name: "i18n-no-dead-keys",
  description: "Every catalog message is reachable from the code",
  run(context: CheckContext): Finding[] {
    const keys = context
      .files((path) => path === SOURCE_CATALOG, "the English locale catalog")
      .flatMap((catalog) => leafKeys(JSON.parse(context.read(catalog)) as unknown));

    // Read the sources once and index what they mention, rather than
    // searching the tree per key: at ~1100 keys the second shape is a
    // thousand full scans of the repository.
    const literals = new Set<string>();
    const prefixes: string[] = [];
    for (const file of context.files(
      (path) => APPLICATION_SOURCE.test(path) && !TEST_FILE.test(path),
      "application sources that could read a message",
    )) {
      const text = context.read(file);
      for (const match of text.matchAll(DOTTED_LITERAL)) literals.add(match[0]);
      for (const match of text.matchAll(TEMPLATE_PREFIX)) {
        const prefix = match[1];
        if (prefix !== undefined) prefixes.push(prefix);
      }
    }

    const findings: Finding[] = [];
    for (const key of keys) {
      if (literals.has(key)) continue;
      if (prefixes.some((prefix) => key.startsWith(prefix))) continue;
      findings.push({
        file: SOURCE_CATALOG,
        message: `${key} is not read by any application source. A test or a document may still name it — that is not a use, and both should go with the key. Delete it from every catalog, and add it to REMOVED_DEAD_KEYS in packages/web/src/i18n/__tests__/frozen-product-terms.test.ts so re-adding it fails. If instead a reader exists that this scan cannot see, widen APPLICATION_SOURCE to reach it — another extension, or another path under packages/<pkg>/src. Do not drop the packages/<pkg>/src shape itself: three tests pin it, because that shape is what keeps this check from reading its own worked examples.`,
      });
    }
    return findings;
  },
} satisfies Check;
