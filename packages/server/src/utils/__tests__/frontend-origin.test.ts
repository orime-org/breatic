// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, expect, it, vi } from "vitest";
vi.mock("@breatic/core", () => ({env: {ALLOWED_ORIGINS: "https://app.example.com, https://preview.example.com"}}));
import { frontendOrigin } from "../frontend-origin.js";
describe("frontend links", () => {
  it("uses the configured frontend for absent or untrusted request origins", () => {
    for (const origin of [undefined, "null", "https://attacker.example", "https://backend.example.com"]) {
      expect(frontendOrigin(origin)).toBe("https://app.example.com");
    }
  });
  it("preserves an explicitly allowed second frontend", () => {
    expect(frontendOrigin("https://preview.example.com")).toBe("https://preview.example.com");
  });
});
