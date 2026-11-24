// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * Which signer the product's internal listener accepts with which secret, and
 * where each may go (inner#1993 §3.1): the billing service signs as `commerce`
 * with COMMERCE_API_SECRET and reaches only `/internal/v1/commerce/`; a request
 * claiming to come from `product` is never accepted here; every other signer is
 * a back office admin with INTERNAL_API_SECRET and stays out of the commerce
 * prefix.
 */

import type * as CoreModule from "@breatic/core";
import { describe, expect, it, vi } from "vitest";

const env = vi.hoisted(() => ({
  INTERNAL_API_SECRET: "internal-current",
  INTERNAL_API_SECRET_PREVIOUS: "internal-previous",
  COMMERCE_API_SECRET: "commerce-current",
  COMMERCE_API_SECRET_PREVIOUS: "commerce-previous",
}));
vi.mock("@breatic/core", async (importOriginal) => ({
  ...(await importOriginal<typeof CoreModule>()),
  env,
}));

import { signerMayAccess, signerSecrets } from "@server/middleware/internal-auth.js";

describe("signerSecrets", () => {
  it("checks the billing service against the commerce secrets", () => {
    expect(signerSecrets("commerce")).toEqual({ current: "commerce-current", previous: "commerce-previous" });
  });

  it("accepts nothing signed as the product, which only ever calls out", () => {
    expect(signerSecrets("product")).toBeNull();
  });

  it("checks every other signer against the back office secrets", () => {
    expect(signerSecrets("admin-7")).toEqual({ current: "internal-current", previous: "internal-previous" });
  });
});

describe("signerMayAccess", () => {
  it("keeps the billing service inside the commerce prefix", () => {
    expect(signerMayAccess("commerce", "/internal/v1/commerce/payment-grants/p-1")).toBe(true);
    expect(signerMayAccess("commerce", "/internal/v1/credit-grants")).toBe(false);
    expect(signerMayAccess("commerce", "/internal/v1/commercex")).toBe(false);
  });

  it("keeps back office admins out of the commerce prefix", () => {
    expect(signerMayAccess("admin-7", "/internal/v1/credit-grants")).toBe(true);
    expect(signerMayAccess("admin-7", "/internal/v1/commerce/accounts/u-1")).toBe(false);
  });
});
