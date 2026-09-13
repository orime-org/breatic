// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0
import { describe, expect, it } from "vitest";
import { parseLicenceReport } from "#repo-lint/licence-report";

describe("parseLicenceReport", () => {
  it("returns the groups when the tool answered", () => {
    const groups = parseLicenceReport(
      '{"MIT":[{"name":"react","versions":["19.2.8"]}]}',
      false,
    );
    expect(groups["MIT"]?.[0]?.name).toBe("react");
  });

  it("throws on the error object the tool prints to stdout", () => {
    // Measured: a directory with no lockfile gets exit 1 and valid JSON. A
    // check that parsed this and walked its entries would report clean.
    const printed = JSON.stringify({
      error: {
        code: "ERR_PNPM_LICENSES_NO_LOCKFILE",
        message: "No pnpm-lock.yaml found: Cannot check a project without a lockfile",
      },
    });
    expect(() => parseLicenceReport(printed, true)).toThrow(
      /No pnpm-lock\.yaml found/,
    );
  });

  it("throws on an error object even when the exit status was zero", () => {
    const printed = '{"error":{"message":"something went wrong"}}';
    expect(() => parseLicenceReport(printed, false)).toThrow(
      /something went wrong/,
    );
  });

  it("throws when the tool printed no JSON at all", () => {
    expect(() => parseLicenceReport("command not found: pnpm", true)).toThrow(
      /Run pnpm install first/,
    );
  });

  it("throws rather than returning nothing when stdout is empty", () => {
    expect(() => parseLicenceReport("", true)).toThrow();
  });
});
