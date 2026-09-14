// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0
import { describe, expect, it } from "vitest";
import { compareShippedNotice } from "#repo-lint/checks/notice-travels-with-the-bundle";

describe("compareShippedNotice", () => {
  it("says nothing when the committed copy is what the packages produce", () => {
    expect(compareShippedNotice("the same words\n", "the same words\n")).toBe(
      undefined,
    );
  });

  it("reports a copy that drifted from what the packages produce", () => {
    const said = compareShippedNotice("old words\n", "new words\n");

    expect(said).toContain("out of date");
  });

  it("names the command that fixes it", () => {
    const said = compareShippedNotice("old words\n", "new words\n");

    expect(said).toContain("pnpm --filter @breatic/repo-lint licences");
  });

  it("reports a copy that is missing outright", () => {
    const said = compareShippedNotice(undefined, "new words\n");

    expect(said).toContain("missing");
  });

  it("says the text changed when both sides list the same packages", () => {
    const committed = "PACKAGES\n\nalpha 1.0.0  MIT\n\nLICENCE TEXTS\n\nold words\n";
    const current = "PACKAGES\n\nalpha 1.0.0  MIT\n\nLICENCE TEXTS\n\nnew words\n";

    const said = compareShippedNotice(committed, current);

    expect(said).toContain("same 1 packages");
    expect(said).toContain("licence text one of them ships");
  });

  it("counts the packages each side accounts for, so the gap is legible", () => {
    const committed = "PACKAGES\n\nalpha 1.0.0  MIT\nbeta 1.0.0  MIT\n";
    const current = "PACKAGES\n\nalpha 1.0.0  MIT\n";

    const said = compareShippedNotice(committed, current);

    expect(said).toMatch(/2\b/);
    expect(said).toMatch(/1\b/);
  });
});
