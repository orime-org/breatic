// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { compareShippedNotice } from "#repo-lint/checks/notice-travels-with-the-bundle";
import { SHIPPED_NOTICES } from "#repo-lint/licence-notice";

const AT = "packages/web/public/third-party-licences.txt";

describe("compareShippedNotice", () => {
  it("says nothing when the committed copy is what the packages produce", () => {
    expect(compareShippedNotice(AT, "the same words\n", "the same words\n")).toBe(
      undefined,
    );
  });

  it("reports a copy that drifted from what the packages produce", () => {
    const said = compareShippedNotice(AT, "old words\n", "new words\n");

    expect(said).toContain("out of date");
  });

  it("names the command that fixes it", () => {
    const said = compareShippedNotice(AT, "old words\n", "new words\n");

    expect(said).toContain("pnpm --filter @breatic/repo-lint licences");
  });

  it("reports a copy that is missing outright", () => {
    const said = compareShippedNotice(AT, undefined, "new words\n");

    expect(said).toContain("missing");
  });

  it("says the text changed when both sides list the same packages", () => {
    const committed = "PACKAGES\n\nalpha 1.0.0  MIT\n\nLICENCE TEXTS\n\nold words\n";
    const current = "PACKAGES\n\nalpha 1.0.0  MIT\n\nLICENCE TEXTS\n\nnew words\n";

    const said = compareShippedNotice(AT, committed, current);

    expect(said).toContain("same 1 packages");
    expect(said).toContain("licence text one of them ships");
  });

  it("counts the packages each side accounts for, so the gap is legible", () => {
    const committed = "PACKAGES\n\nalpha 1.0.0  MIT\nbeta 1.0.0  MIT\n";
    const current = "PACKAGES\n\nalpha 1.0.0  MIT\n";

    const said = compareShippedNotice(AT, committed, current);

    expect(said).toMatch(/2\b/);
    expect(said).toMatch(/1\b/);
  });

  it("names the file that drifted", () => {
    expect(compareShippedNotice("packages/desktop/resources/third-party-licences.txt", "old\n", "new\n")).toContain(
      "packages/desktop/resources/third-party-licences.txt",
    );
  });
});

describe("SHIPPED_NOTICES", () => {
  it("covers every artefact that ships third-party code: the web bundle and the desktop installer", () => {
    expect(SHIPPED_NOTICES.map(({ covers, path }) => ({ covers, path }))).toEqual([
      { covers: "@breatic/web...", path: "packages/web/public/third-party-licences.txt" },
      { covers: "@breatic/desktop...", path: "packages/desktop/resources/third-party-licences.txt" },
    ]);
  });
});
