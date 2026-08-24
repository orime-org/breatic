// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0
import type { Check, CheckContext, Finding } from "#repo-lint/check";
import { APPLICATION_SOURCE, TEST_FILE } from "#repo-lint/file-kinds";
import { KEY_SEGMENT } from "#repo-lint/message-keys";

/** English is the source catalog; the others are translations of it. */
const SOURCE_CATALOG = "locales/en.json";

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
 * A segment may begin with a digit, which it could not until 2026-08-06. The
 * exclusion cost real coverage: `canvas.nodePlaceholder.3d` is in all five
 * locales and this pattern could not match it, so a plain
 * `t('canvas.nodePlaceholder.3d')` counted as no use at all and the key read
 * as dead. It survived only because the one file that reads it builds the id
 * with a template literal, so `TEMPLATE_PREFIX` covered the namespace.
 * Widening it was measured: a few hundred more literals land in the evidence
 * set — version numbers, an IP address, a licence id — and no key changes
 * verdict, because a catalog key is matched whole and none of them looks like
 * one. The exact count is not written here on purpose: it moves with any
 * commit that edits a source, and the version that did name a number went
 * false within one commit of being written.
 *
 * Widening this to bare words is not the alternative it looks like. `cancel`
 * and `loading` are ordinary words that appear all over the tree as enum
 * members and state literals (`z.enum(["confirm", "cancel"])`, `phase ===
 * 'loading'`), so a bare-word pattern would count every one of them as a use
 * and exempt every short key forever.
 */
const DOTTED_LITERAL = new RegExp(`${KEY_SEGMENT}(?:\\.${KEY_SEGMENT})+`, "g");

/**
 * The static head of an interpolated id — the `` `canvas.upload.${x}` `` form.
 * The trailing dot is kept, so the prefix cannot swallow a sibling subtree
 * whose name merely starts with the same letters.
 */
const TEMPLATE_PREFIX = new RegExp(
  `\`(${KEY_SEGMENT}(?:\\.${KEY_SEGMENT})*\\.)\\$\\{`,
  "g",
);

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
 * id has a dot because that check fails the build on a dotless one, in the
 * catalog and at the call site both. Delete it and this one starts reporting
 * live keys as dead — the shape it forbids is a shape `DOTTED_LITERAL` cannot
 * see. Nothing enforces that dependency mechanically, so deleting the
 * upstream check leaves this suite green.
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
 * matching the translation call *instead of* the mention — which is what
 * `spelledOutKeys` does for the two checks that reason about call sites, and
 * it is a strictly smaller set: it sees only ids written out in full inside
 * a call, and this check needs every mention, including the interpolated
 * prefixes that keep a whole namespace alive. Using it here would report
 * live keys dead. What must not happen is reading the scope above as if it
 * closed this too.
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
