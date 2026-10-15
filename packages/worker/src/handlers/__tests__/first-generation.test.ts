// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The account's first completed generation is reported once, only with
 * analytics consent, and never fails the run that reports it (inner#1442).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  claimFirstMilestone: vi.fn(),
  serverAnalyticsWanted: vi.fn(),
  trackServerEvent: vi.fn(),
  findOwnerStudioId: vi.fn(),
  warn: vi.fn(),
}));

vi.mock("@breatic/core", () => ({
  claimFirstMilestone: h.claimFirstMilestone,
  serverAnalyticsWanted: h.serverAnalyticsWanted,
  trackServerEvent: h.trackServerEvent,
  projectsRepo: { findOwnerStudioId: h.findOwnerStudioId },
  logger: { info: vi.fn(), warn: h.warn, error: vi.fn(), debug: vi.fn() },
}));

const { reportFirstGeneration } = await import("@worker/handlers/first-generation.js");

const TASK = { taskId: "t-1", taskType: "image", userId: "u-1", projectId: "p-1" };

beforeEach(() => {
  vi.clearAllMocks();
  h.claimFirstMilestone.mockResolvedValue(true);
  h.serverAnalyticsWanted.mockReturnValue(true);
  h.findOwnerStudioId.mockResolvedValue("s-1");
});

describe("reportFirstGeneration", () => {
  it("sends first_generation_completed when this run claims the milestone", async () => {
    await reportFirstGeneration(TASK);
    expect(h.claimFirstMilestone).toHaveBeenCalledWith("first-generation", "u-1");
    expect(h.trackServerEvent).toHaveBeenCalledWith("first_generation_completed", {
      userId: "u-1",
      insertId: "first-generation:u-1",
      properties: { studio_id: "s-1", project_id: "p-1", kind: "image" },
    });
  });

  it("sends nothing when another run already claimed it", async () => {
    h.claimFirstMilestone.mockResolvedValue(false);
    await reportFirstGeneration(TASK);
    expect(h.trackServerEvent).not.toHaveBeenCalled();
  });

  it("sends nothing without analytics consent", async () => {
    h.serverAnalyticsWanted.mockReturnValue(false);
    await reportFirstGeneration(TASK);
    expect(h.trackServerEvent).not.toHaveBeenCalled();
  });

  it("logs a failure instead of throwing it", async () => {
    h.claimFirstMilestone.mockRejectedValue(new Error("db down"));
    await expect(reportFirstGeneration(TASK)).resolves.toBeUndefined();
    expect(h.warn).toHaveBeenCalledWith(expect.objectContaining({ taskId: "t-1" }), "first_generation_report_failed");
  });
});
