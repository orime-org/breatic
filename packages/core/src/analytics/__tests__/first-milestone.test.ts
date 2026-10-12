// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { beforeEach, describe, expect, it, vi } from "vitest";

const claimMilestone = vi.hoisted(() => vi.fn(async () => true));

vi.mock("@core/analytics/milestone.repo.js", () => ({ claimMilestone }));

import { claimFirstMilestone } from "@core/analytics/first-milestone.js";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("claimFirstMilestone", () => {
  it("records the milestone on a deployment that sends nothing yet, so enabling analytics later reports no false first", async () => {
    expect(await claimFirstMilestone("first-project", "user-1")).toBe(true);
    expect(claimMilestone).toHaveBeenCalledWith("first-project:user-1", undefined);
  });

  it("answers with the claim, which is false for an account that already reached the milestone", async () => {
    claimMilestone.mockResolvedValueOnce(false);
    expect(await claimFirstMilestone("first-agent", "user-1")).toBe(false);
  });
});
