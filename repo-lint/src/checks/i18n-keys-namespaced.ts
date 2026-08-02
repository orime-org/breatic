// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0
import type { Check, CheckContext, Finding } from "#repo-lint/check";

/**
 * Every locale catalog, translations included.
 *
 * All five rather than English alone, because a key that exists only in a
 * translation is invisible to any check that reads the source catalog — and
 * the shape this one is about would be just as broken there.
 */
const CATALOG = /^locales\/[^/]+\.json$/;

/**
 * Every message lives in a namespace.
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
 * A namespace is asked for positively — a top-level value must be an object
 * that is not an array — rather than by rejecting types one at a time. The
 * array is spelled out because `typeof` calls one an object while it is not a
 * namespace; `null` is spelled out because `typeof` calls it one too.
 *
 * WHAT THIS DOES NOT GIVE YOU, stated plainly, because the gap is easy to
 * read past. This check delivers "every id contains at least one dot". The
 * dead-key check needs something strictly stronger: that `DOTTED_LITERAL`
 * matches the id whole, and that pattern requires EVERY segment to begin with
 * a letter. Having a dot is necessary, not sufficient, and the difference is
 * not hypothetical — `canvas.nodePlaceholder.3d` is in all five catalogs
 * today, has two dots, passes this check, and cannot be matched, because the
 * `3d` segment starts with a digit. It survives only because the one file
 * reading it builds the id with a template literal, so the interpolated-prefix
 * path covers it; rewritten as a plain call it would be reported dead.
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
  description: "Every catalog message lives in a namespace",
  run(context: CheckContext): Finding[] {
    const findings: Finding[] = [];
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
