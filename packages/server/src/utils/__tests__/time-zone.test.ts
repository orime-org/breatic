// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, expect, it } from "vitest";

import { isKnownTimeZone } from "@server/utils/time-zone.js";

describe("isKnownTimeZone", () => {
  it("accepts IANA zone names", () => {
    expect(isKnownTimeZone("Asia/Shanghai")).toBe(true);
    expect(isKnownTimeZone("America/New_York")).toBe(true);
    expect(isKnownTimeZone("UTC")).toBe(true);
  });

  it("accepts the legacy links Intl still resolves", () => {
    expect(isKnownTimeZone("US/Eastern")).toBe(true);
  });

  it("refuses names Intl cannot format a time in", () => {
    expect(isKnownTimeZone("Mars/Olympus")).toBe(false);
    expect(isKnownTimeZone("")).toBe(false);
  });
});
