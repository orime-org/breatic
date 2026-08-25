// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0
import type { Check, CheckContext, Finding } from "#repo-lint/check";
import { stripComments } from "#repo-lint/strip-comments";

/** Where the product's own UI lives. */
const WEB_SOURCE = /^packages\/web\/src\//;

/** The file kinds that can carry a class name or a custom property. */
const STYLED = /\.(ts|tsx|css)$/;

/**
 * Every way a raw brand colour reaches the screen.
 *
 * The Tailwind arms need a digit, because `bg-brand-500` is a palette step
 * while `bg-brand-foreground` would be a semantic alias. The custom-property
 * arm is the opposite — a letter — for the same reason from the other side.
 * Declarations like `--brand-500: hsl(...)` match nothing here: defining the
 * palette is not using it, and the palette has to be defined somewhere.
 */
const RAW_BRAND =
  /bg-brand-[0-9]|text-brand-[0-9]|border-brand-[0-9]|ring-brand-[0-9]|--color-brand-[a-z]|var\(--brand-/;

/** The logo's own token. Referencing it is the point of the exemption. */
const LOGO_TOKEN = "brand-logo-primary";

/** The deliberate per-line escape, kept from the guard this replaces. */
const ESCAPE = "brand-guard: allow";

/**
 * Chrome, canvas and studio stay neutral; brand belongs to the logo.
 *
 * A 2026-06-06 decision took the product's chrome monochrome — black,
 * greys and white, with semantic tokens for meaning — and reserved the
 * brand palette for the logo mark alone. A raw brand token leaking into any
 * screen drifts the UI back toward the branded look that decision reversed,
 * and nothing else in the build would notice: it compiles, it renders, it
 * just looks like a different product.
 *
 * Not an ESLint rule, for a reason that will not change: `.css` is in scope
 * and there is no CSS parser in the repo's ESLint setup, and the largest
 * live consumer of the pattern is custom-property syntax rather than
 * anything with a JS AST node.
 *
 * Comments are stripped, which the guard did not do. The invariant is about
 * what renders; a brand token named in a comment does not make chrome
 * un-neutral, so flagging one was a false positive by the rule's own terms.
 *
 * Two exemptions from the guard are not carried over, both measured dead:
 * the whole-file pass for the token definitions (the only line there that
 * matches is the logo alias, which the logo exemption already covers), and
 * a studio pages directory that the guard's comments advertised while the
 * filter itself had been deleted from the code.
 */
export const noBrandUsage = {
  name: "no-brand-usage",
  description: "Raw brand colours are reserved for the logo",
  run(context: CheckContext): Finding[] {
    const files = context.files(
      (path) => WEB_SOURCE.test(path) && STYLED.test(path),
      "web source that can carry a colour",
    );

    const findings: Finding[] = [];
    for (const file of files) {
      const style = file.endsWith(".css") ? "css" : "js";
      const text = context.read(file);
      const source = text.split("\n");
      const code = stripComments(text, style, file).split("\n");

      code.forEach((text, index) => {
        if (!RAW_BRAND.test(text)) return;
        if (text.includes(LOGO_TOKEN)) return;
        // The escape marker lives in a comment, so it is read from the
        // original line rather than the stripped one.
        if (source[index]?.includes(ESCAPE) === true) return;
        findings.push({
          file,
          line: index + 1,
          message: `Raw brand colour: ${text.trim().slice(0, 80)} — chrome, canvas and studio stay neutral; only the logo keeps brand identity. To keep one line deliberately, append a "${ESCAPE}" comment.`,
        });
      });
    }
    return findings;
  },
} satisfies Check;
