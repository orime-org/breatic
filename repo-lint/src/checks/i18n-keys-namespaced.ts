// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0
import type { Check, CheckContext, Finding } from "#repo-lint/check";
import { APPLICATION_SOURCE, TEST_FILE } from "#repo-lint/file-kinds";
import { spelledOutKeys } from "#repo-lint/message-keys";

/**
 * Every locale catalog, translations included.
 *
 * All five rather than English alone, because a key that exists only in a
 * translation is invisible to any check that reads the source catalog — and
 * the shape this one is about would be just as broken there.
 */
const CATALOG = /^locales\/[^/]+\.json$/;

/**
 * Every message id lives in a namespace — where it is defined, and where it
 * is used.
 *
 * The dead-key check finds a use by looking for the key's dotted name in the
 * sources. A key with no dot has no shape to look for: matching it as a bare
 * word would make every English word in the tree count as a use, so it needs
 * a second, narrower path — reading the id out of the translation call — and
 * that path covers strictly less. Two ways of finding a use, one of them
 * weaker, is a worse position than one way that always applies, and the way
 * to have one is for the dotless shape not to exist.
 *
 * That is the whole reason this check is here, and it is why it is worth
 * having for two keys. It is not tidiness: it is the precondition that lets
 * the dead-key check drop its special case. Delete this check and that one
 * silently goes back to reporting live dotless keys as dead — which it did,
 * once, and the finding was `cancel` and `loading`.
 *
 * BOTH SIDES, since 2026-08-06. Until then only the catalogs were read, and
 * a source could ask for a dotless id with nothing to say so: the catalog
 * cannot hold one, the dead-key check runs the other way and never meets
 * one, and the missing-key check's pattern required a dot and so did not see
 * the call at all. Three checks, none of them responsible, and the user reads
 * `cancel` on screen.
 *
 * The call site is judged on its SHAPE and no catalog is consulted. A lookup
 * would reach the same verdict today, and that is the trap: it would reach it
 * only because a sibling check keeps dotless ids out of the catalogs, so the
 * moment that check changes this one goes quiet. It would also blame the
 * wrong side — the reader would go add the id to the catalogs, where the case
 * below would reject it.
 *
 * A namespace is asked for positively — a top-level value must be an object
 * that is not an array — rather than by rejecting types one at a time. The
 * array is spelled out because `typeof` calls one an object while it is not a
 * namespace; `null` is spelled out because `typeof` calls it one too.
 *
 * WHAT THIS DOES NOT GIVE YOU, stated plainly, because the gap is easy to
 * read past. This check delivers "every id contains at least one dot". The
 * dead-key check needs something strictly stronger: that `DOTTED_LITERAL`
 * matches the id whole. Having a dot is necessary, not sufficient. The two
 * were further apart until 2026-08-06, when the segment shape was widened to
 * admit a leading digit and `canvas.nodePlaceholder.3d` — in all five
 * catalogs, and until then matchable by neither check — became visible to
 * both.
 *
 * Three more shapes sit in that same gap and this check sees none of them:
 * an array NESTED under a namespace (top-level values are all it inspects, so
 * `errors.list.0` passes), a key whose own name contains a dot (`a.b` reads as
 * two segments and resolves to nothing at runtime), and a top-level namespace
 * named with the empty string (which puts a dotless id back in play). None
 * exist in the catalogs today — measured, not assumed — which is why closing
 * them is tracked as its own task rather than done here.
 *
 * The honest summary: this closes the dotless shape, which is the one that
 * actually bit. It does not certify that every catalog id is matchable, and
 * the dead-key check's docstring says so where it matters. Reading this as
 * the full precondition is the mistake worth naming, since a check that looks
 * adjacent to a gap is how the gap stays open.
 *
 * Also outside its scope, for the same reason: a catalog with no keys at all,
 * and a non-string leaf below the top level. Both belong to the dead-key
 * check's handling of degenerate input and are tracked separately.
 */
export const i18nKeysNamespaced = {
  name: "i18n-keys-namespaced",
  description: "Every message id lives in a namespace",
  run(context: CheckContext): Finding[] {
    const findings: Finding[] = [];

    // Both sides of the same rule. An id is defined in a catalog and used at
    // a call site, and until 2026-08-06 only the first was checked: a source
    // could ask for a dotless id and nothing said anything, because the
    // catalog cannot hold one and the missing-key check's pattern could not
    // see one. That left a caller's mistake with no owner — the runtime
    // prints the id and the user reads `cancel` on screen.
    //
    // Reported here on the shape rather than by looking the id up. The two
    // are not the same finding: a lookup would blame the catalog for a
    // caller's error, and the reader would go add the id to the catalogs,
    // where the check below would then reject it.
    for (const source of context.files(
      (path) => APPLICATION_SOURCE.test(path) && !TEST_FILE.test(path),
      "application sources that could ask for a message",
    )) {
      for (const { key, line } of spelledOutKeys(
        context.read(source),
        source,
      )) {
        if (key.includes(".")) continue;
        findings.push({
          file: source,
          line,
          message: `${key} is asked of the catalog with no namespace, and no catalog can answer it — the case below fails the build on a top-level message, so a dotless id is unanswerable by construction and the runtime falls back to printing the id itself. Give it a namespace at this call site and in every catalog: \`common\` if the product shares the message, the feature's own namespace otherwise.`,
        });
      }
    }

    for (const catalog of context.files(
      (path) => CATALOG.test(path),
      "locale catalogs",
    )) {
      const parsed = JSON.parse(context.read(catalog)) as Record<
        string,
        unknown
      >;
      for (const [key, value] of Object.entries(parsed)) {
        const isNamespace =
          value !== null && typeof value === "object" && !Array.isArray(value);
        if (isNamespace) continue;
        findings.push({
          file: catalog,
          message: `${key} sits at the top level and is not a namespace, so every id under it — the id itself, if it is a message — has no dot. The dead-key check finds a use by looking for a key's dotted name, and a dotless id cannot be looked for that way: supporting it costs a second, weaker matching path, and losing it means live keys get reported dead. A message here belongs in a namespace — \`common\` if the product shares it, the feature's own namespace otherwise. Anything else here (an array, a number, null) is not a catalog shape at all: messages are named, not numbered, so give each one a key.`,
        });
      }
    }
    return findings;
  },
} satisfies Check;
