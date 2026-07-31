// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0
import type { Check, CheckContext, Finding } from "#repo-lint/check";
import { TRANSLATED_PRODUCT_NOUNS } from "#repo-lint/product-noun-denylist";

/** The non-English catalogs. English is the source, so it is not scanned. */
const TRANSLATED_CATALOG = /^locales\/(zh-CN|zh-TW|ja|ko)\.json$/;

/**
 * Reads every leaf string in a catalog, keyed by its dotted path.
 * @param value A parsed catalog or one of its subtrees.
 * @param prefix The dotted path accumulated so far.
 * @param out Where to collect the leaves.
 * @returns Every leaf string, keyed by dotted path.
 */
function flatten(
  value: unknown,
  prefix = "",
  out: Record<string, string> = {},
): Record<string, string> {
  if (typeof value === "string") {
    out[prefix] = value;
    return out;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      flatten(child, prefix === "" ? key : `${prefix}.${key}`, out);
    }
  }
  return out;
}

/**
 * Product nouns stay English in every locale.
 *
 * Reads the catalogs as JSON and looks only at leaf string values, so a key
 * name or an ICU placeholder is never mistaken for a translation. The shell
 * version delegated to a Node script for the same reason, plus one more: a
 * bracket range of these characters is not portable across greps.
 *
 * A denylist rather than a per-key freeze, because the point is to cover
 * strings nobody has written yet. Forms that also mean something ordinary
 * cannot be handled this way and are frozen per key in the web package's
 * frozen-product-terms test — the two halves are deliberate and neither
 * covers the other.
 */
export const noTranslatedProductNoun = {
  name: "no-translated-product-noun",
  description: "Product nouns stay English in every locale",
  run(context: CheckContext): Finding[] {
    const catalogs = context.files(
      (path) => TRANSLATED_CATALOG.test(path),
      "non-English locale catalogs",
    );

    const findings: Finding[] = [];
    for (const catalog of catalogs) {
      const strings = flatten(JSON.parse(context.read(catalog)) as unknown);
      for (const [key, value] of Object.entries(strings)) {
        for (const [noun, forms] of TRANSLATED_PRODUCT_NOUNS) {
          for (const form of forms) {
            if (value.includes(form)) {
              findings.push({
                file: catalog,
                message: `${key} translates "${noun}". It is brand vocabulary and stays English, inside sentences included. Found: ${value}`,
              });
            }
          }
        }
      }
    }
    return findings;
  },
} satisfies Check;
