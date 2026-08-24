// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0
import { describe, expect, it } from "vitest";
import { serviceEntriesPresent } from "#repo-lint/checks/service-entries-present";
import { fakeContext } from "#repo-lint/__tests__/fake-context";

const ALL = {
  "packages/server/src/index.ts": "x",
  "packages/worker/src/index.ts": "x",
  "packages/collab/src/index.ts": "x",
};

describe("service-entries-present", () => {
  it("passes when all three exist", () => {
    expect(serviceEntriesPresent.run(fakeContext(ALL))).toEqual([]);
  });

  it("reports a deleted entry, which no rule could see", () => {
    const { "packages/collab/src/index.ts": removed, ...rest } = ALL;
    expect(removed).toBe("x");
    const findings = serviceEntriesPresent.run(fakeContext(rest));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.file).toBe("packages/collab/src/index.ts");
    expect(findings[0]?.message).toContain("collab");
  });

  it("reports each missing entry separately", () => {
    expect(
      serviceEntriesPresent.run(fakeContext({ "unrelated.ts": "x" })),
    ).toHaveLength(3);
  });

  it("is not satisfied by an entry that merely moved", () => {
    // A renamed entry is the same hole: the rule keyed on the old path
    // stops running and nothing says so.
    const moved = { ...ALL, "packages/collab/src/main.ts": "x" };
    delete (moved as Record<string, string>)["packages/collab/src/index.ts"];
    expect(serviceEntriesPresent.run(fakeContext(moved))).toHaveLength(1);
  });
});
