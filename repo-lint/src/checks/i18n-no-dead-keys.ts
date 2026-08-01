// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0
import type { Check, CheckContext, Finding } from "#repo-lint/check";

/** English is the source catalog; the others are translations of it. */
const SOURCE_CATALOG = "locales/en.json";

/** The catalogs themselves, which naming a key does not count as using it. */
const ANY_CATALOG = /^locales\/[a-zA-Z-]+\.json$/;

/**
 * Keys whose only consumer builds the id somewhere this scan cannot see, each
 * with the reason it cannot.
 *
 * The bar is a mechanism the scanner is structurally blind to, not "I am
 * fairly sure this one is used" — an entry without a reason is an exemption
 * with nowhere to park, which is how a list like this stops meaning anything.
 * A dotted literal or a template prefix in any tracked file is already found
 * below, so neither belongs here.
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
 * as a feature that exists. The catalogs held 350 such keys across sixteen
 * namespaces when this check was written — whole namespaces for screens that
 * had been deleted, and one that duplicated text the model configs already
 * own.
 *
 * What counts as a use is deliberately generous, because the cost of the two
 * mistakes is not symmetric: a key wrongly called dead gets deleted and the UI
 * shows a raw id, while a dead key wrongly called live just survives another
 * pass. So a bare dotted literal anywhere in any tracked file counts, quoted
 * or not — `canvas.upload.tooLarge` written in a comment or a YAML value is
 * enough. Interpolated ids count through their static head, which is how
 * `` t(`canvas.upload.${rejection}`) `` keeps every key under it.
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
    for (const file of context.textFiles(
      (path) => !ANY_CATALOG.test(path),
      "files that could reference a message",
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
        message: `${key} is not reachable from any file. Delete it from every catalog, or — if its id is assembled somewhere this scan cannot see — add its root to DYNAMIC_KEY_ROOTS with the reason.`,
      });
    }
    return findings;
  },
} satisfies Check;
