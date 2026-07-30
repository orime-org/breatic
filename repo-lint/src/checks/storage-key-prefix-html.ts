// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0
import type { Check, CheckContext, Finding } from "#repo-lint/check";
import { stripComments } from "#repo-lint/strip-comments";

/** The web app's HTML, which carries an inline script. */
const WEB_HTML = /^packages\/web\/src\/.*\.html$/;

/** A persisted-storage access with a literal key. */
const KEYED_ACCESS =
  /(localStorage|sessionStorage)\s*\.\s*(getItem|setItem|removeItem)\s*\(\s*['"`]([^'"`]*)/g;

/** Where the product declares the prefix, once. */
const REGISTRY = "packages/web/src/lib/storage-keys.ts";

/** How that declaration is written. */
const DECLARATION = /STORAGE_PREFIX\s*=\s*['"`]([^'"`]+)/;

/**
 * Reads the prefix out of the registry rather than restating it.
 *
 * A guard carrying its own copy of the value it guards agrees with the
 * product right up until somebody changes one of them, and then it keeps
 * passing while checking the wrong string. Reading the real declaration
 * removes that possibility instead of documenting it.
 * @param context The check context.
 * @returns The prefix the product declares.
 * @throws {Error} When the registry is gone or no longer declares it.
 */
function declaredPrefix(context: CheckContext): string {
  if (!context.exists(REGISTRY)) {
    throw new Error(
      `${REGISTRY} is missing, so there is nothing to check keys against. A guard that cannot find the value it enforces must not report clean.`,
    );
  }
  const match = DECLARATION.exec(context.read(REGISTRY));
  if (match?.[1] === undefined) {
    throw new Error(
      `${REGISTRY} no longer declares STORAGE_PREFIX in a form this can read.`,
    );
  }
  return match[1];
}

/**
 * Persisted keys carry the product's prefix — the HTML half.
 *
 * The companion ESLint rule covers `.ts` and `.tsx`. It cannot cover this
 * file: ESLint is never handed HTML here, and there is no HTML processor
 * configured. That matters more than it sounds, because the inline script
 * in the web app's HTML is exactly the callsite that structurally *cannot*
 * import the key registry — it runs before the module graph exists, to set
 * the theme without a flash. So the one place a bare key is most likely to
 * be written by hand is the one place a source-file linter cannot see.
 *
 * The invariant is the same one: localStorage is shared across the origin,
 * so a bare key can be read or clobbered by an extension or a sibling app.
 */
export const storageKeyPrefixHtml = {
  name: "storage-key-prefix-html",
  description: "Persisted keys in inline HTML scripts carry the prefix",
  run(context: CheckContext): Finding[] {
    const prefix = declaredPrefix(context);
    const documents = context.files(
      (path) => WEB_HTML.test(path),
      "web HTML documents",
    );

    const findings: Finding[] = [];
    for (const file of documents) {
      // Script comments only; an HTML comment cannot contain live code.
      const lines = stripComments(context.read(file), "js").split("\n");
      lines.forEach((text, index) => {
        for (const hit of text.matchAll(KEYED_ACCESS)) {
          const key = hit[3] ?? "";
          if (key.startsWith(prefix)) continue;
          findings.push({
            file,
            line: index + 1,
            message: `'${key}' has no '${prefix}' prefix. This script runs before the module graph exists so it cannot import the registry — keep the literal here in step with the registry entry it mirrors.`,
          });
        }
      });
    }
    return findings;
  },
} satisfies Check;
