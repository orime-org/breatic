// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only
import type { Check, CheckContext, Finding } from "#repo-lint/check";

/**
 * Billing lives in the private billing service, not here (inner#1993).
 *
 * The product takes no payment itself: it forwards purchase, subscription
 * and referral requests to the billing service and receives the facts back
 * on its internal listener. What would put billing back in this repository
 * is one of four things, each checked here: a server module for it, the
 * Stripe SDK declared or imported, or a Stripe webhook handler.
 */

/** Server modules that belong to the billing service. */
const BILLING_MODULES = ["payment", "subscription", "credit-refund", "referral", "stripe-webhook"];

/** Packages whose source must not import the Stripe SDK. */
const NO_STRIPE_SOURCE = /^packages\/(core|shared|domain|server)\/src\/.*\.[cm]?tsx?$/;

/** An import of the Stripe SDK, static or dynamic, or a re-export of it. */
const STRIPE_IMPORT = /\b(?:from|import)\s*\(?\s*["']stripe["']/;

/** A manifest's dependency sections. */
const SECTIONS = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"] as const;

/** What every finding says the rule is. */
const RULE = "Billing runs in the private billing service; the product forwards to it and never talks to Stripe (inner#1993).";

export const noBillingInProduct = {
  name: "no-billing-in-product",
  description: "No billing module, Stripe dependency or Stripe webhook in the product",
  run(context: CheckContext): Finding[] {
    const findings: Finding[] = [];
    for (const file of context.files(() => true, "tracked files")) {
      const module = BILLING_MODULES.find((name) => file.startsWith(`packages/server/src/modules/${name}/`));
      if (module !== undefined) {
        findings.push({ file, message: `A server module named "${module}". ${RULE}` });
        continue;
      }
      if (/(^|\/)[^/]*stripe-webhook[^/]*$/.test(file)) {
        findings.push({ file, message: `A file named after the Stripe webhook. ${RULE}` });
        continue;
      }
      if (file === "package.json" || /^packages\/[^/]+\/package\.json$/.test(file)) {
        const manifest = JSON.parse(context.read(file)) as Partial<Record<(typeof SECTIONS)[number], Record<string, string>>>;
        if (SECTIONS.some((section) => manifest[section]?.["stripe"] !== undefined)) {
          findings.push({ file, message: `Declares the stripe package. ${RULE}` });
        }
        continue;
      }
      if (file === "pnpm-workspace.yaml") {
        const line = context.read(file).split("\n").findIndex((text) => /^\s+["']?stripe["']?\s*:/.test(text));
        if (line >= 0) findings.push({ file, line: line + 1, message: `The catalog names the stripe package. ${RULE}` });
        continue;
      }
      if (NO_STRIPE_SOURCE.test(file)) {
        context
          .read(file)
          .split("\n")
          .forEach((text, index) => {
            if (STRIPE_IMPORT.test(text)) findings.push({ file, line: index + 1, message: `Imports the stripe package. ${RULE}` });
          });
      }
    }
    return findings;
  },
} satisfies Check;
