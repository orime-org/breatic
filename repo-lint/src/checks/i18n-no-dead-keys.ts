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
 * of this check. Skipping any file whose text matched an import of vitest
 * meant one comment mentioning that phrase, in a shipped component, dropped
 * the file and had 37 live keys reported for deletion — measured. It also
 * missed `test-support.ts`, which imports drizzle. So it bought a cheap risk
 * (a helper keeping a dead key alive one more sweep) by taking on the
 * expensive one (a live key deleted, a raw id in the UI), which is backwards
 * from the asymmetry this check is built around. If a helper here ever does
 * hold up a dead key, move the helper into `__tests__/`; do not teach the
 * scan to guess from content.
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
 * check reports the key and `DYNAMIC_KEY_ROOTS` is where it gets recorded,
 * with the reason.
 */
const APPLICATION_SOURCE = /^packages\/[^/]+\/src\/.*\.([cm]?ts|tsx)$/;

/**
 * Keys whose only consumer builds the id somewhere this scan cannot see, each
 * with the reason it cannot.
 *
 * The bar is a mechanism the scanner is structurally blind to, not "I am
 * fairly sure this one is used" — an entry without a reason is an exemption
 * with nowhere to park, which is how a list like this stops meaning anything.
 *
 * Being named somewhere is not such a mechanism, but being named somewhere
 * outside the scanned scope now can be: a key read from a config file, or
 * from a package that is not under `packages/`, is invisible to the scan and
 * belongs here with that stated. A key an application source names in full,
 * or reaches through an interpolated id, does not — the scan finds those.
 */
const DYNAMIC_KEY_ROOTS: ReadonlyArray<{ prefix: string; reason: string }> = [];

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

/** A dotted identifier anywhere in a file — `canvas.upload.tooLarge`. */
const DOTTED_LITERAL = /[a-zA-Z][\w-]*(?:\.[a-zA-Z][\w-]*)+/g;

/**
 * The id in a translation call — `t('cancel')`.
 *
 * The catalogs allow a flat top-level key, and such an id has no dot for
 * `DOTTED_LITERAL` to anchor on. Widening that pattern to bare words instead
 * would make every English word in the tree count as a use. So dotless keys
 * are read from the call itself, which is exact — `t(…)` is the only
 * translation call form in this tree, and a check that quietly stops covering
 * a shape of key is worth less than one that names the shape it covers.
 */
const TRANSLATION_CALL = /\bt\(\s*['"]([\w.-]+)['"]/g;

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
 * Within that scope the matching stays generous, since the two mistakes do not
 * cost the same: a live key called dead ships a raw id to the UI, while a dead
 * key called live only survives another pass.
 *
 * How generous, stated plainly: `DOTTED_LITERAL` cannot tell a message id from
 * any other dotted expression, so ordinary property access counts. Measured by
 * fabricating twelve keys named like code — nine survived, among them
 * `user.email`, `canvas.width`, and `Math.max`. A dead key whose name collides
 * with a common expression is therefore invisible here. Narrowing this means
 * matching the translation call instead of the mention, which is a different
 * change with its own trade-offs; what must not happen is reading the scope
 * above as if it closed this too.
 *
 * One honest caveat about the self-exclusion. This check no longer reads its
 * own source, which closes a real mechanism — the tests below pin it — but on
 * this repository it closed nothing observable: every namespace the examples
 * here mention (`canvas.upload`, `cancel`) is independently alive in
 * application code, so no key\'s verdict changed. The mechanism was worth
 * closing; the evidence for it is the test, not a measured deletion.
 *
 * Only the keys nothing at all can see reach `DYNAMIC_KEY_ROOTS`, and only
 * with the reason the scan cannot see them.
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
      for (const match of text.matchAll(TRANSLATION_CALL)) {
        const id = match[1];
        if (id !== undefined) literals.add(id);
      }
      for (const match of text.matchAll(TEMPLATE_PREFIX)) {
        const prefix = match[1];
        if (prefix !== undefined) prefixes.push(prefix);
      }
    }

    const findings: Finding[] = [];
    for (const key of keys) {
      if (literals.has(key)) continue;
      if (prefixes.some((prefix) => key.startsWith(prefix))) continue;
      if (DYNAMIC_KEY_ROOTS.some(({ prefix }) => key.startsWith(prefix))) continue;
      findings.push({
        file: SOURCE_CATALOG,
        message: `${key} is not read by any application source. A test or a document may still name it — that is not a use, and both should go with the key. Delete it from every catalog; if instead its id is assembled somewhere this scan cannot see, add its root to DYNAMIC_KEY_ROOTS with the reason.`,
      });
    }
    return findings;
  },
} satisfies Check;
