// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Mini-tool runs write into a project, so they need editor or above on it —
 * the same gate as generating on the canvas. A viewer (and every member of an
 * archived project, whose role reads as viewer) is refused before anything is
 * spent or queued.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
vi.mock("ai", () => ({
  tool: (c: Record<string, unknown>) => c,
  streamText: vi.fn(), generateText: vi.fn(), stepCountIs: vi.fn(),
}));

vi.mock("@breatic/core", async (importOriginal) => {
  const { coreMock } = await import("../helpers/mock-core.js");
  return coreMock(importOriginal);
});

vi.mock("@breatic/domain", async () => {
  const { domainMock } = await import("../helpers/mock-core.js");
  return domainMock();
});

vi.mock("@server/modules", async (importOriginal) => {
  const { serverModulesMock } = await import("../helpers/mock-core.js");
  return serverModulesMock(importOriginal);
});

import { ForbiddenError } from "@breatic/core";
import { createApp } from "../../app.js";
import { mocks, mockQueueAdd } from "../helpers/mock-core.js";

const AUTH = { Cookie: "breatic_session=valid-token", "Content-Type": "application/json" };

const BINDING = {
  project_id: "11111111-1111-4111-8111-111111111111",
  space_id: "22222222-2222-4222-9222-222222222222",
  target_node_id: "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11",
};

const BODIES: Record<string, Record<string, unknown>> = {
  image: { tool: "remove-bg", image: "http://example.com/image.png", ...BINDING },
  video: { tool: "upscale", video: "http://example.com/v.mp4", ...BINDING },
  audio: { tool: "sfx", prompt: "rain", ...BINDING },
};

describe("mini-tools need editor on the project", () => {
  beforeEach(() => {
    mocks.projectService.assertAccess.mockReset();
    mocks.creditLotService.getSpendableCredits.mockReset();
    mocks.taskService.create.mockReset();
    mockQueueAdd.mockReset();
  });

  for (const kind of ["image", "video", "audio"] as const) {
    it(`refuses /${kind} to a caller below editor, before spending or queueing`, async () => {
      mocks.projectService.assertAccess.mockRejectedValue(new ForbiddenError("forbidden"));

      const res = await createApp().request(`/api/v1/mini-tools/${kind}`, {
        method: "POST",
        headers: AUTH,
        body: JSON.stringify(BODIES[kind]),
      });

      expect(res.status).toBe(403);
      expect(mocks.projectService.assertAccess).toHaveBeenCalledWith(BINDING.project_id, "user-1", "editor");
      expect(mocks.creditLotService.getSpendableCredits).not.toHaveBeenCalled();
      expect(mocks.taskService.create).not.toHaveBeenCalled();
    });
  }
});
