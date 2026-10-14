// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, expect, it } from "vitest";
import { SpaceRpcRequestSchema } from "@shared/types/space-rpc.js";
import { CONSENT_COOKIE_NAME, requiresOptIn } from "../analytics/consent.js";

it("names the cookie both repos agree on", () => {
  expect(CONSENT_COOKIE_NAME).toBe("breatic_consent");
});

describe("requiresOptIn", () => {
  it("asks first in the EEA, the UK, Switzerland and mainland China", () => {
    for (const country of ["DE", "FR", "IE", "IS", "LI", "NO", "GB", "CH", "CN"]) {
      expect(requiresOptIn(country)).toBe(true);
    }
  });

  it("defaults on elsewhere", () => {
    for (const country of ["US", "JP", "KR", "TW", "HK", "SG", "BR"]) {
      expect(requiresOptIn(country)).toBe(false);
    }
  });

  // Cloudflare reports `XX` when it cannot place the visitor and `T1` for Tor.
  it("asks first when the country is unknown", () => {
    expect(requiresOptIn(null)).toBe(true);
    expect(requiresOptIn("")).toBe(true);
    expect(requiresOptIn("XX")).toBe(true);
    expect(requiresOptIn("T1")).toBe(true);
  });

  it("matches country codes regardless of case", () => {
    expect(requiresOptIn("de")).toBe(true);
    expect(requiresOptIn("us")).toBe(false);
  });
});

describe("space RPC envelope consent", () => {
  const base = { id: "r1", type: "space:rename", payload: { spaceId: "s1", name: "x" } };

  it("carries the sender's consent when attached", () => {
    const parsed = SpaceRpcRequestSchema.parse({ ...base, analyticsConsent: { analytics: true, ads: false } });
    expect(parsed.analyticsConsent).toEqual({ analytics: true, ads: false });
  });

  it("accepts a request without it", () => {
    expect(SpaceRpcRequestSchema.parse(base).analyticsConsent).toBeUndefined();
  });

  it("refuses a malformed one", () => {
    expect(SpaceRpcRequestSchema.safeParse({ ...base, analyticsConsent: { analytics: "yes" } }).success).toBe(false);
    expect(
      SpaceRpcRequestSchema.safeParse({ ...base, analyticsConsent: { analytics: true, ads: true, extra: 1 } }).success,
    ).toBe(false);
  });
});
