// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0
import type { Check, CheckContext, Finding } from "#repo-lint/check";
import { APPLICATION_SOURCE, TEST_FILE } from "#repo-lint/file-kinds";
import { KEY_SEGMENT } from "#repo-lint/message-keys";
import { stripComments } from "#repo-lint/strip-comments";

/** English is the source catalog; the others are translations of it. */
const SOURCE_CATALOG = "locales/en.json";

/**
 * A message asked of the catalog by name: `t("a.b.c")`, in any of the three
 * string delimiters.
 *
 * Only the argument of a `t(...)` call counts. The sibling dead-key check
 * sweeps every dotted literal in a file, because for its question a false
 * match is harmless — one extra thing keeping a key alive. Here a false match
 * is a finding against a file path or a property chain, so the call is what
 * anchors it.
 *
 * A backtick is in the class because a backtick with nothing interpolated is a
 * literal like any other, and nothing stops one being written: `packages/web`
 * forbids the form with a `quotes` lint rule, the root config that governs
 * `packages/server` has no such rule, and server is where the typo this check
 * exists for shipped. An interpolated one still cannot match, since a segment
 * cannot contain `$` or `{`.
 *
 * The literal has to BE the argument, which is what the trailing `[),]` says:
 * a `)` closes the call, a `,` starts the params object. Without it,
 * `t('canvas.group' + suffix)` matched as far as the closing quote and the
 * namespace `canvas.group` was reported as a missing message — a finding
 * against a call whose real key is not in the source at all.
 *
 * That anchor is also where this stops: a literal wearing a trailing type
 * assertion (`t("a.b" as const)`, `t("a.b" satisfies string)`) or reached
 * through an optional call (`t?.("a.b")`) is not followed by `)` or `,` and
 * goes unseen. Those are syntax decorations rather than another way of naming
 * a key, and a text scan chasing them has no end; none appears in the tree.
 * Saying where the scan stops is worth more than pretending it does not.
 */
const MESSAGE_CALL = new RegExp(
  String.raw`\bt\(\s*(['"` +
    "`" +
    String.raw`])(` +
    `${KEY_SEGMENT}(?:\\.${KEY_SEGMENT})+` +
    String.raw`)\1\s*[),]`,
  "g",
);

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
 * A key whose shape `KEY_SEGMENT` excludes: a segment starting with a digit,
 * or no dot at all. Those limits belong to both i18n checks and are written
 * where the shape is.
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
      const code = stripComments(context.read(file), "js", file);
      for (const match of code.matchAll(MESSAGE_CALL)) {
        const key = match[2];
        if (key === undefined) continue;
        if (messageAt(catalog, key) !== undefined) continue;
        findings.push({
          file,
          message: `${key} is asked of the catalog and ${SOURCE_CATALOG} has no message there, so the runtime falls back to printing the key and the user reads it as text. Either the key is misspelled — separator style is the usual cause, and it is not uniform: every key under server.* is snake_case, most of the rest is camelCase, and a few outside server.* are not, so read the catalog rather than guess — or the message was never added, in which case add it to all five catalogs.`,
        });
      }
    }
    return findings;
  },
} satisfies Check;
