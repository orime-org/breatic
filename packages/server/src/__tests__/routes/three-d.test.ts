// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { beforeEach, describe, expect, it, vi } from "vitest";

const { getSceneConfig, resolveSceneAsset } = vi.hoisted(() => ({
  getSceneConfig: vi.fn(),
  resolveSceneAsset: vi.fn(),
}));

vi.mock("ai", () => ({
  tool: (config: Record<string, unknown>) => config,
  streamText: vi.fn(), generateText: vi.fn(), stepCountIs: vi.fn(),
}));
vi.mock("@breatic/core", async (importOriginal) => {
  const { coreMock } = await import("../helpers/mock-core.js");
  return { ...await coreMock(importOriginal), getSceneConfig };
});
vi.mock("@breatic/domain", async () => {
  const { domainMock } = await import("../helpers/mock-core.js");
  return domainMock();
});
vi.mock("@server/modules", async (importOriginal) => {
  const { serverModulesMock } = await import("../helpers/mock-core.js");
  return {
    ...await serverModulesMock(importOriginal),
    sceneAssetService: { resolveSceneAsset },
  };
});

import { createApp } from "@server/app.js";
import { mocks } from "@server/__tests__/helpers/mock-core.js";

const PROJECT = "11111111-1111-4111-8111-111111111111";
const ASSET = "22222222-2222-4222-8222-222222222222";
const AUTH = { Cookie: "breatic_session=valid-token" };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.projectAuthService.loadProjectRole.mockResolvedValue("viewer");
  getSceneConfig.mockReturnValue({ scale_sensitivity: 0.025 });
  resolveSceneAsset.mockResolvedValue({
    url: "https://assets.example.test/registered-model.glb",
    mimeType: "model/gltf-binary",
  });
});

describe("3D Space project read routes", () => {
  it("allows a Viewer to read the configured scale sensitivity", async () => {
    const response = await createApp().request(`/api/v1/projects/${PROJECT}/three-d/config`, { headers: AUTH });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: { scaleSensitivity: 0.025 } });
    expect(mocks.projectAuthService.loadProjectRole).toHaveBeenCalledWith("user-1", PROJECT);
    expect(getSceneConfig).toHaveBeenCalledTimes(1);
    expect(resolveSceneAsset).not.toHaveBeenCalled();
  });

  it("allows a Viewer to resolve an asset through the scene service", async () => {
    const response = await createApp().request(`/api/v1/projects/${PROJECT}/three-d/assets/${ASSET}`, { headers: AUTH });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: {
      url: "https://assets.example.test/registered-model.glb", mimeType: "model/gltf-binary",
    } });
    expect(resolveSceneAsset).toHaveBeenCalledWith(PROJECT, "user-1", ASSET);
  });

  it.each(["config", `assets/${ASSET}`])("rejects a non-member before reading %s", async (suffix) => {
    mocks.projectAuthService.loadProjectRole.mockResolvedValue(null);
    const response = await createApp().request(`/api/v1/projects/${PROJECT}/three-d/${suffix}`, { headers: AUTH });

    expect(response.status).toBe(403);
    expect(getSceneConfig).not.toHaveBeenCalled();
    expect(resolveSceneAsset).not.toHaveBeenCalled();
  });

  it.each(["config", `assets/${ASSET}`])("requires authentication for %s", async (suffix) => {
    const response = await createApp().request(`/api/v1/projects/${PROJECT}/three-d/${suffix}`);

    expect(response.status).toBe(401);
    expect(getSceneConfig).not.toHaveBeenCalled();
    expect(resolveSceneAsset).not.toHaveBeenCalled();
  });

  it.each([
    "/api/v1/projects/not-a-uuid/three-d/config",
    `/api/v1/projects/not-a-uuid/three-d/assets/${ASSET}`,
    `/api/v1/projects/${PROJECT}/three-d/assets/not-a-uuid`,
  ])("validates UUIDs before the role query for %s", async (path) => {
    const response = await createApp().request(path, { headers: AUTH });

    expect(response.status).toBe(422);
    expect(mocks.projectAuthService.loadProjectRole).not.toHaveBeenCalled();
    expect(getSceneConfig).not.toHaveBeenCalled();
    expect(resolveSceneAsset).not.toHaveBeenCalled();
  });
});
