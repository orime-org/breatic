// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * `space_created` is sent once per Space, keyed by its id, and only with
 * analytics consent (inner#1442 design §4.8).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  serverAnalyticsWanted: vi.fn(),
  trackServerEvent: vi.fn(),
  findOwnerStudioId: vi.fn(),
}));

vi.mock("@breatic/core", () => ({
  serverAnalyticsWanted: h.serverAnalyticsWanted,
  trackServerEvent: h.trackServerEvent,
  projectsRepo: { findOwnerStudioId: h.findOwnerStudioId },
  reportCollaboratorFirstAction: vi.fn(),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { reportSpaceCreated } from "@collab/services/space-analytics.js";

const SPACE = { projectId: "p-1", spaceId: "sp-1", spaceType: "canvas", userId: "u-1", via: "manual" as const };

beforeEach(() => {
  vi.clearAllMocks();
  h.serverAnalyticsWanted.mockReturnValue(true);
  h.findOwnerStudioId.mockResolvedValue("s-1");
});

describe("reportSpaceCreated", () => {
  it("sends space_created keyed by the Space", async () => {
    await reportSpaceCreated(SPACE);
    expect(h.trackServerEvent).toHaveBeenCalledWith("space_created", {
      userId: "u-1",
      insertId: "space:sp-1",
      properties: { studio_id: "s-1", project_id: "p-1", space_type: "canvas", via: "manual" },
    });
  });

  it("sends nothing without analytics consent", async () => {
    h.serverAnalyticsWanted.mockReturnValue(false);
    await reportSpaceCreated(SPACE);
    expect(h.trackServerEvent).not.toHaveBeenCalled();
  });
});
