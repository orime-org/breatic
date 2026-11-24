// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0
import { describe, expect, it } from "vitest";
import { noBillingInProduct } from "#repo-lint/checks/no-billing-in-product";
import { fakeContext } from "#repo-lint/__tests__/fake-context";

/** A product with no billing in it. */
const CLEAN = {
  "package.json": '{"devDependencies":{"turbo":"2.5.0"}}',
  "pnpm-workspace.yaml": 'packages:\n  - packages/*\ncatalog:\n  "hono": ^4.13.1\n',
  "packages/server/package.json": '{"dependencies":{"hono":"catalog:"}}',
  "packages/server/src/modules/commerce/commerce-client.ts": 'import { signedCall } from "@breatic/core";\n',
  "packages/server/src/modules/account/apply-subscription.ts": "export const x = 1;\n",
};

describe("no-billing-in-product", () => {
  it("passes a product that only calls the billing service", () => {
    expect(noBillingInProduct.run(fakeContext(CLEAN))).toEqual([]);
  });

  it.each(["payment", "subscription", "credit-refund", "referral", "stripe-webhook"])("reports a server module named %s", (name) => {
    const findings = noBillingInProduct.run(fakeContext({ ...CLEAN, [`packages/server/src/modules/${name}/x.service.ts`]: "export {};\n" }));

    expect(findings).toEqual([expect.objectContaining({ file: `packages/server/src/modules/${name}/x.service.ts` })]);
  });

  it("reports stripe declared by a manifest or by the catalog", () => {
    const findings = noBillingInProduct.run(
      fakeContext({
        ...CLEAN,
        "packages/core/package.json": '{"dependencies":{"stripe":"catalog:"}}',
        "pnpm-workspace.yaml": 'catalog:\n  "stripe": ^21.0.1\n',
      }),
    );

    expect(findings.map((f) => f.file).sort()).toEqual(["packages/core/package.json", "pnpm-workspace.yaml"]);
  });

  it.each([
    'import Stripe from "stripe";',
    "import type Stripe from 'stripe';",
    'const s = await import("stripe");',
    'export { default } from "stripe";',
  ])("reports a library or server source that imports stripe: %s", (line) => {
    const findings = noBillingInProduct.run(fakeContext({ ...CLEAN, "packages/domain/src/x.ts": `${line}\n` }));

    expect(findings).toEqual([expect.objectContaining({ file: "packages/domain/src/x.ts", line: 1 })]);
  });

  it("leaves a word stripe that is no import alone", () => {
    expect(noBillingInProduct.run(fakeContext({ ...CLEAN, "packages/server/src/x.ts": "// the billing service talks to stripe\nconst stripeish = 1;\n" }))).toEqual([]);
  });

  it("reports a tracked file named after the Stripe webhook", () => {
    const findings = noBillingInProduct.run(fakeContext({ ...CLEAN, "packages/web/src/stripe-webhook-panel.tsx": "export {};\n" }));

    expect(findings).toEqual([expect.objectContaining({ file: "packages/web/src/stripe-webhook-panel.tsx" })]);
  });
});
