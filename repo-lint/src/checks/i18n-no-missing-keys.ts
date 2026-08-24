// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0
import type { Check, CheckContext, Finding } from "#repo-lint/check";
import { APPLICATION_SOURCE, TEST_FILE } from "#repo-lint/file-kinds";
import { spelledOutKeys } from "#repo-lint/message-keys";

/** English is the source catalog; the others are translations of it. */
const SOURCE_CATALOG = "locales/en.json";

/**
 * Resolve a dotted key against the catalog.
 * @param catalog - The parsed English catalog.
 * @param key - The dotted key a source asked for.
 * @returns The message, or `undefined` if the path is absent or lands on a
 *   branch rather than a message.
 */
function messageAt(catalog: unknown, key: string): string | undefined {
  let cursor: unknown = catalog;
  for (const segment of key.split(".")) {
    if (cursor === null || typeof cursor !== "object") return undefined;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return typeof cursor === "string" ? cursor : undefined;
}

/**
 * Every message a source asks for by name is one the catalog can answer.
 *
 * The mirror of `i18n-no-dead-keys`, which asks whether every message has a
 * reader. Both directions can fail and only one was watched: `t("server.error
 * .notFound")` shipped against a catalog that spells it `not_found`, and
 * nothing rejected it — the runtime has no key to look up and puts the id
 * itself on screen, so the user reads `server.error.notFound`.
 *
 * WHAT THIS DOES NOT SEE, and it is more than one thing:
 *
 * A key the call does not spell out. `t(\`a.\${kind}\`)` has no key in the
 * source at all; `t(roleKey)` does have one, written out in full in a lookup
 * table — `BellMenu.tsx` has two such tables — but not where the match can
 * reach it; `t('a.b' + suffix)` writes a prefix and glues the rest on. Every
 * one of these is silent. They are not rare: the non-literal calls are all in
 * `packages/web`, where they are how a component picks one of several labels
 * (a role, a modality, a theme), and there are dozens. The count is
 * deliberately not written here — it moves with any commit, and a number in a
 * comment is a claim nobody re-measures.
 *
 * An id with no namespace, which is deliberately somebody else's finding.
 * `i18n-keys-namespaced` reports it at the call site, on the shape, without
 * consulting any catalog — and that is the right place for it. Reporting it
 * here as well would give one mistake two findings and blame the catalog for
 * a caller's error: the reader would go add `cancel` to the catalogs, where
 * that same check would then reject it.
 *
 * All of that is stated rather than closed because closing it is a different
 * piece of work: the indirect forms need the key resolved back through a
 * variable, and the cheap approximation — sweeping every dotted string literal
 * in the file, which is what the dead-key check does — is safe only in that
 * direction. There a false match merely keeps one extra key alive; here it
 * would report a file path or a property chain as a missing message, and a
 * check that cries wolf gets switched off.
 *
 * WHAT IT DOES COVER is the form the bug that prompted it was written in:
 * `t("server.error.notFound")`, the whole key spelled out as the whole
 * argument and followed straight by the `)` or the `,`, against a catalog that
 * says `not_found`. Every call written that way is checked, in any of the
 * three delimiters, with or without a params object.
 *
 * Comments are stripped. The first repo-wide run reported two keys that live
 * in a docstring showing callers how the hook is used, one of them about a
 * shopping cart this product does not have. A key named in a comment renders
 * nothing, so reporting it was a false positive by this check's own terms.
 */
export const i18nNoMissingKeys = {
  name: "i18n-no-missing-keys",
  description: "Every message a source names is one the catalog answers",
  run(context: CheckContext): Finding[] {
    const catalogs = context.files(
      (path) => path === SOURCE_CATALOG,
      "the English locale catalog",
    );
    const catalog = JSON.parse(context.read(catalogs[0]!)) as unknown;

    const findings: Finding[] = [];
    for (const file of context.files(
      (path) => APPLICATION_SOURCE.test(path) && !TEST_FILE.test(path),
      "application sources that could ask for a message",
    )) {
      for (const { key, line } of spelledOutKeys(context.read(file), file)) {
        // A dotless id belongs to `i18n-keys-namespaced`, which reports it on
        // the shape. Looking it up here would find nothing and say so, which
        // is true but blames the wrong side.
        if (!key.includes(".")) continue;
        if (messageAt(catalog, key) !== undefined) continue;
        findings.push({
          file,
          line,
          message: `${key} is asked of the catalog and ${SOURCE_CATALOG} has no message there, so the runtime falls back to printing the key and the user reads it as text. Either the key is misspelled — separator style is the usual cause, and it is not uniform: every key under server.* is snake_case, most of the rest is camelCase, and a few outside server.* are not, so read the catalog rather than guess — or the message was never added, in which case add it to all five catalogs.`,
        });
      }
    }
    return findings;
  },
} satisfies Check;
