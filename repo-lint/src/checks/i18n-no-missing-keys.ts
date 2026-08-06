// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0
import type { Check, CheckContext, Finding } from "#repo-lint/check";
import { TEST_FILE } from "#repo-lint/file-kinds";
import { stripComments } from "#repo-lint/strip-comments";

/** English is the source catalog; the others are translations of it. */
const SOURCE_CATALOG = "locales/en.json";

/**
 * Where an application source lives — the same shape the dead-key check scans,
 * for the same reason: it keeps a check from reading its own worked examples.
 */
const APPLICATION_SOURCE = /^packages\/[^/]+\/src\/.*\.([cm]?ts|tsx)$/;

/**
 * A message asked of the catalog by name: `t("a.b.c")`, either quote.
 *
 * Only the argument of a `t(...)` call counts. The sibling dead-key check
 * sweeps every dotted literal in a file, because for its question a false
 * match is harmless — one extra thing keeping a key alive. Here a false match
 * is a finding against a file path or a property chain, so the call is what
 * anchors it.
 */
const MESSAGE_CALL = /\bt\(\s*(['"])([a-zA-Z][\w-]*(?:\.[a-zA-Z][\w-]*)+)\1/g;

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
 * WHAT THIS DOES NOT SEE: a key built by interpolation. `t(\`a.\${kind}\`)`
 * names nothing in full, so whether the catalog answers it cannot be settled
 * by reading the source. Those are silent here. That is a stated limit rather
 * than coverage, and it is the reason this is a separate check instead of a
 * second question inside the dead-key one — that check reasons about prefixes
 * precisely so it can keep interpolated keys alive, and the same reasoning
 * run backwards would have to guess at what the interpolation can produce.
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
      const code = stripComments(context.read(file), "js", file);
      for (const match of code.matchAll(MESSAGE_CALL)) {
        const key = match[2];
        if (key === undefined) continue;
        if (messageAt(catalog, key) !== undefined) continue;
        findings.push({
          file,
          message: `${key} is asked of the catalog and ${SOURCE_CATALOG} has no message there, so the runtime falls back to printing the key and the user reads it as text. Either the key is misspelled — check the separator style, since the catalogs use snake_case under server.error and camelCase elsewhere — or the message was never added, in which case add it to all five catalogs.`,
        });
      }
    }
    return findings;
  },
} satisfies Check;
