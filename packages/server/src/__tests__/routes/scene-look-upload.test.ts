// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

const { issueUploadTicket, assertStudioRole } = vi.hoisted(() => ({
  issueUploadTicket: vi.fn(),
  assertStudioRole: vi.fn(),
}));

vi.mock("ai", () => ({
  tool: (config: Record<string, unknown>) => config,
  streamText: vi.fn(), generateText: vi.fn(), stepCountIs: vi.fn(),
}));
vi.mock("@breatic/core", async (importOriginal) => {
  const { coreMock } = await import("../helpers/mock-core.js");
  return coreMock(importOriginal);
});
vi.mock("@breatic/domain", async () => {
  const { domainMock } = await import("../helpers/mock-core.js");
  return {
    ...(await domainMock()),
    studioAuthService: { assertStudioRole },
    mediaReadService: { purposeAccepts: (mimeType: string) => mimeType.startsWith("image/") },
  };
});
vi.mock("@server/modules", async (importOriginal) => {
  const { serverModulesMock } = await import("../helpers/mock-core.js");
  return serverModulesMock(importOriginal);
});
vi.mock("@server/modules/asset/upload-ticket.service.js", () => ({
  issueUploadTicket,
  issueUploadTicketBatch: vi.fn(),
  issueTransferTicket: vi.fn(),
  transferTicketMaxBytes: () => 1024,
}));
vi.mock("@server/modules/activity/projectActivity.service.js", () => ({
  recordProjectActivity: vi.fn(),
}));

import { ForbiddenError } from "@breatic/core";
import { createApp } from "@server/app.js";
import { mocks } from "@server/__tests__/helpers/mock-core.js";

const PROJECT = "11111111-1111-4111-8111-111111111111";
const STUDIO = "22222222-2222-4222-8222-222222222222";
const NODE = "33333333-3333-4333-8333-333333333333";
const SPACE = "44444444-4444-4444-8444-444444444444";
const OBJECT = "55555555-5555-4555-8555-555555555555";
// A part picture is stored as its address (inner#2171 design §3.2).
const START = "https://assets.example.test/before.png";
const AUTH = { Cookie: "breatic_session=valid-token", "Content-Type": "application/json" };
const TICKET = {
  kind: "ticket", uploadId: "upload-1", token: "upload-token", storageKey: "image/wood.png",
  uploadUrl: "https://ingest.example.test", assetKind: "image", partSize: 8388608,
  totalParts: 1, taskId: undefined,
};
/** A picture for part 3 of an object, which held another picture when the upload started. */
const PICTURE = {
  project_id: PROJECT, purpose: "scene_look", space_id: SPACE, object_id: OBJECT, part: "3", start_map: START,
  filename: "wood.png", content_type: "image/png", size: 4096, client_hash: "a".repeat(64),
};

/**
 * Exercise the real request schema and authorization before the upload service.
 * @param body - The request supplied by the browser.
 * @returns The response from the application.
 * @throws {Error} When application construction fails.
 */
async function requestTicket(body: Record<string, unknown>): Promise<Response> {
  return createApp().request("/api/v1/assets/upload-ticket", {
    method: "POST", headers: AUTH, body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  issueUploadTicket.mockReset().mockResolvedValue(TICKET);
  assertStudioRole.mockReset().mockResolvedValue(undefined);
  mocks.projectService.assertAccess.mockReset().mockResolvedValue(undefined);
  mocks.assetService.resolveOwnerStudioId.mockReset().mockResolvedValue(STUDIO);
});

describe("3D part picture upload request contract (inner#1693 design 6.3)", () => {
  it.each([
    ["another picture", START],
    ["the model's own picture turned off", "none"],
    ["no picture", null],
  ])("admits a part picture whose part held %s at the start, for a Project editor", async (_label, startMap) => {
    const response = await requestTicket({ ...PICTURE, start_map: startMap });

    expect(response.status).toBe(201);
    expect(mocks.projectService.assertAccess).toHaveBeenCalledWith(PROJECT, "user-1", "editor");
    expect(issueUploadTicket).toHaveBeenCalledWith(
      { userId: "user-1", studioId: STUDIO, projectId: PROJECT },
      { ...PICTURE, start_map: startMap },
      expect.any(Function),
    );
  });

  it("checks Project editing access before opening an upload", async () => {
    mocks.projectService.assertAccess.mockRejectedValue(new ForbiddenError("forbidden"));

    const response = await requestTicket(PICTURE);

    expect(response.status).toBe(403);
    expect(issueUploadTicket).not.toHaveBeenCalled();
  });

  it.each([
    ["no Space", { space_id: undefined }],
    ["no object", { object_id: undefined }],
    ["no part", { part: undefined }],
    ["no starting picture", { start_map: undefined }],
    ["an object id that is not one", { object_id: "figure" }],
    ["a part key outside the format", { part: "x" }],
    ["a starting picture outside the format", { start_map: "wood.png" }],
    ["a node", { node_id: NODE }],
    ["a model name", { label: "Lamp" }],
    ["a video", { content_type: "video/mp4", filename: "clip.mp4" }],
    ["a GIF", { content_type: "image/gif", filename: "loop.gif" }],
  ])("rejects a part picture with %s", async (_label, extra) => {
    const response = await requestTicket({ ...PICTURE, ...extra });

    expect(response.status).toBe(422);
    expect(issueUploadTicket).not.toHaveBeenCalled();
  });

  it("refuses a part target on any other upload", async () => {
    const { purpose: _purpose, ...plain } = PICTURE;

    const response = await requestTicket(plain);

    expect(response.status).toBe(422);
    expect(issueUploadTicket).not.toHaveBeenCalled();
  });
});
