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
 * that is not an array — rather than by rejecting the types seen so far. A
 * rejection list is only as long as what someone thought of; `null` and a
 * number are caught here without being named.
 *
 * The array is named, because `typeof` calls one an object and it is not a
 * namespace. It is the same defect as the dotless key wearing a different
 * shape: an array yields ids like `tags.0`, which do have a dot but whose
 * first segment is a digit, and the dead-key check anchors on a leading
 * letter. So every key under an array reads as dead, forever, no matter how
 * often it is used — exactly the failure this check exists to prevent, and
 * the one an `Array.isArray` shortcut in the dead-key check would only hide.
 *
 * What this check does not do: say anything about a catalog with no keys, or
 * about a non-string leaf deeper than the top level. Both belong to the
 * dead-key check's handling of degenerate input and are tracked separately.
 * Reading this one as covering them is the mistake worth naming, since a
 * check that looks adjacent to a gap is how the gap stays open.
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
        if (value !== null && typeof value === "object" && !Array.isArray(value))
          continue;
        findings.push({
          file: catalog,
          message: `${key} is a message at the top level, so its id has no dot in it. The dead-key check finds a use by looking for a key's dotted name, and a dotless id cannot be looked for that way — supporting it costs a second, weaker matching path, and losing it means live keys get reported dead. Move it into a namespace: a message shared across the product belongs under \`common\`, one belonging to a feature under that feature's namespace.`,
        });
      }
    }
    return findings;
  },
} satisfies Check;
