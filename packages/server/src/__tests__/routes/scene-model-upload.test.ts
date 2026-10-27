// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { beforeEach, describe, expect, it, vi } from "vitest";
import * as fc from "fast-check";

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
    ...domainMock(),
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
import { MINI_TOOLS } from "@breatic/shared/mini-tools";
import { createApp } from "@server/app.js";
import { mocks } from "@server/__tests__/helpers/mock-core.js";

const PROJECT = "11111111-1111-4111-8111-111111111111";
const STUDIO = "22222222-2222-4222-8222-222222222222";
const NODE = "33333333-3333-4333-8333-333333333333";
const SPACE = "44444444-4444-4444-8444-444444444444";
const AUTH = { Cookie: "breatic_session=valid-token", "Content-Type": "application/json" };
const BROWSER_TOOL = MINI_TOOLS.find((tool) => tool.run.kind === "browser")!.id;
const TICKET = {
  kind: "ticket", uploadId: "upload-1", token: "upload-token", storageKey: "file/model.glb",
  uploadUrl: "https://ingest.example.test", assetKind: "file", partSize: 8388608,
  totalParts: 1, taskId: undefined,
};
const MODEL = {
  project_id: PROJECT, purpose: "scene_model", filename: "model.glb",
  content_type: "model/gltf-binary", size: 4096, client_hash: "a".repeat(64),
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
  mocks.projectService.assertMayManage.mockReset().mockResolvedValue(undefined);
  mocks.assetService.resolveOwnerStudioId.mockReset().mockResolvedValue(STUDIO);
});

describe("scene model upload request contract", () => {
  it.each([
    ["model/gltf-binary", "model.glb"],
    ["application/zip", "model.zip"],
  ])("admits %s through the explicit model purpose", async (contentType, filename) => {
    const response = await requestTicket({ ...MODEL, content_type: contentType, filename });

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ data: {
      uploadId: TICKET.uploadId, token: TICKET.token, storageKey: TICKET.storageKey,
      uploadUrl: TICKET.uploadUrl, kind: "file", partSize: TICKET.partSize, totalParts: 1,
    } });
    expect(mocks.projectService.assertAccess).toHaveBeenCalledWith(PROJECT, "user-1", "editor");
    expect(mocks.assetService.resolveOwnerStudioId).toHaveBeenCalledWith(PROJECT);
    expect(issueUploadTicket).toHaveBeenCalledWith(
      { userId: "user-1", studioId: STUDIO, projectId: PROJECT },
      { ...MODEL, content_type: contentType, filename },
      expect.any(Function),
    );
    expect(mocks.projectService.assertMayManage).not.toHaveBeenCalled();
    expect(assertStudioRole).not.toHaveBeenCalled();
  });

  it("normalizes the model MIME essence before the upload service", async () => {
    const response = await requestTicket({ ...MODEL, content_type: "MODEL/GLTF-BINARY; charset=binary" });

    expect(response.status).toBe(201);
    expect(issueUploadTicket.mock.calls[0]?.[1]).toEqual(MODEL);
  });

  it("checks Project editing access before resolving the Studio or opening an upload", async () => {
    mocks.projectService.assertAccess.mockRejectedValue(new ForbiddenError("forbidden"));

    const response = await requestTicket(MODEL);

    expect(response.status).toBe(403);
    expect(mocks.projectService.assertAccess).toHaveBeenCalledWith(PROJECT, "user-1", "editor");
    expect(mocks.assetService.resolveOwnerStudioId).not.toHaveBeenCalled();
    expect(issueUploadTicket).not.toHaveBeenCalled();
  });

  it("requires authentication before opening a model upload", async () => {
    const response = await createApp().request("/api/v1/assets/upload-ticket", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(MODEL),
    });

    expect(response.status).toBe(401);
    expect(issueUploadTicket).not.toHaveBeenCalled();
    expect(mocks.assetService.resolveOwnerStudioId).not.toHaveBeenCalled();
  });

  it.each([
    ["node", { node_id: NODE }],
    ["Space", { space_id: SPACE }],
    ["mini-tool source", { source: "mini_tool", tool_name: BROWSER_TOOL }],
    ["client-selected Studio", { studio_id: STUDIO }],
  ])("rejects a model purpose mixed with %s", async (_label, extra) => {
    const response = await requestTicket({ ...MODEL, ...extra });

    expect(response.status).toBe(422);
    expect(issueUploadTicket).not.toHaveBeenCalled();
    expect(mocks.assetService.resolveOwnerStudioId).not.toHaveBeenCalled();
  });

  it("requires a Project for the model purpose", async () => {
    const { project_id: _projectId, ...withoutProject } = MODEL;
    const response = await requestTicket({ ...withoutProject, studio_id: STUDIO });

    expect(response.status).toBe(422);
    expect(assertStudioRole).not.toHaveBeenCalled();
    expect(issueUploadTicket).not.toHaveBeenCalled();
  });

  it.each(["model/gltf-binary", "application/zip"])("keeps %s outside generic uploads", async (contentType) => {
    const { purpose: _purpose, ...generic } = MODEL;
    const response = await requestTicket({ ...generic, content_type: contentType });

    expect(response.status).toBe(422);
    expect(issueUploadTicket).not.toHaveBeenCalled();
  });

  it.each(["image/png", "video/mp4", "audio/mpeg", "model/gltf+json"])(
    "rejects %s under the model purpose",
    async (contentType) => {
      const response = await requestTicket({ ...MODEL, content_type: contentType });

      expect(response.status).toBe(422);
      expect(issueUploadTicket).not.toHaveBeenCalled();
    },
  );

  it.each(["image/png", "video/mp4", "audio/mpeg"])("preserves the generic %s entry", async (contentType) => {
    const { purpose: _purpose, ...generic } = MODEL;
    const response = await requestTicket({ ...generic, content_type: contentType });

    expect(response.status).toBe(201);
    expect(mocks.projectService.assertAccess).toHaveBeenCalledWith(PROJECT, "user-1", "editor");
    expect(issueUploadTicket).toHaveBeenCalledTimes(1);
  });

  it("preserves Project cover authorization", async () => {
    const response = await requestTicket({ ...MODEL, purpose: "project_cover", content_type: "image/png" });

    expect(response.status).toBe(201);
    expect(mocks.projectService.assertMayManage).toHaveBeenCalledWith(PROJECT, "user-1");
    expect(mocks.projectService.assertAccess).not.toHaveBeenCalled();
    expect(assertStudioRole).not.toHaveBeenCalled();
  });

  it("preserves Studio avatar authorization", async () => {
    const { project_id: _projectId, ...avatar } = MODEL;
    const response = await requestTicket({ ...avatar, studio_id: STUDIO, purpose: "studio_avatar", content_type: "image/png" });

    expect(response.status).toBe(201);
    expect(assertStudioRole).toHaveBeenCalledWith("user-1", STUDIO, "admin");
    expect(mocks.projectService.assertAccess).not.toHaveBeenCalled();
    expect(mocks.assetService.resolveOwnerStudioId).not.toHaveBeenCalled();
  });

  it("INVARIANT: model upload ownership follows the authorized Project", async () => {
    await fc.assert(fc.asyncProperty(fc.uuid(), fc.uuid(), async (projectId, studioId) => {
      issueUploadTicket.mockClear();
      mocks.assetService.resolveOwnerStudioId.mockResolvedValue(studioId);

      const response = await requestTicket({ ...MODEL, project_id: projectId });

      expect(response.status).toBe(201);
      expect(mocks.projectService.assertAccess).toHaveBeenLastCalledWith(projectId, "user-1", "editor");
      expect(mocks.assetService.resolveOwnerStudioId).toHaveBeenLastCalledWith(projectId);
      expect(issueUploadTicket.mock.calls[0]?.[0]).toEqual({ userId: "user-1", studioId, projectId });
    }), { numRuns: 20 });
  });
});
