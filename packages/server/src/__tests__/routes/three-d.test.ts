// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

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
const IMPORT_CONFIG = {
  max_input_bytes: 67108864,
  max_expanded_bytes: 268435456,
  max_artifact_bytes: 268435456,
  max_files: 4096,
  max_entry_json_bytes: 4194304,
  decoder_worker_limit: 1,
  max_texture_edge: 8192,
  max_texture_bytes: 268435456,
};
const CAPTURE_CONFIG = { long_edge_px: 2048, min_frame_px: 120, canvas_sync_timeout_ms: 10000 };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.projectAuthService.loadProjectRole.mockResolvedValue("viewer");
  getSceneConfig.mockReturnValue({ scale_sensitivity: 0.025, import: IMPORT_CONFIG, capture: CAPTURE_CONFIG });
  resolveSceneAsset.mockResolvedValue({
    url: "https://assets.example.test/registered-model.glb",
    mimeType: "model/gltf-binary",
    sizeBytes: 5956,
  });
});

describe("3D Space project read routes", () => {
  it("allows a Viewer to read the configured scale sensitivity and import budgets", async () => {
    const response = await createApp().request(`/api/v1/projects/${PROJECT}/three-d/config`, { headers: AUTH });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: {
      scaleSensitivity: 0.025,
      import: {
        maxInputBytes: 67108864,
        maxExpandedBytes: 268435456,
        maxArtifactBytes: 268435456,
        maxFiles: 4096,
        maxEntryJsonBytes: 4194304,
        decoderWorkerLimit: 1,
        maxTextureEdge: 8192,
        maxTextureBytes: 268435456,
      },
      capture: { longEdgePx: 2048, minFramePx: 120, canvasSyncTimeoutMs: 10000 },
    } });
    expect(mocks.projectAuthService.loadProjectRole).toHaveBeenCalledWith("user-1", PROJECT);
    expect(getSceneConfig).toHaveBeenCalledTimes(1);
    expect(resolveSceneAsset).not.toHaveBeenCalled();
  });

  it("maps all configured import budgets to their camelCase wire fields", async () => {
    getSceneConfig.mockReturnValue({ scale_sensitivity: 0.04, import: {
      max_input_bytes: 33554432,
      max_expanded_bytes: 134217728,
      max_artifact_bytes: 150994944,
      max_files: 2048,
      max_entry_json_bytes: 2097152,
      decoder_worker_limit: 2,
      max_texture_edge: 4096,
      max_texture_bytes: 100663296,
    }, capture: { long_edge_px: 1024, min_frame_px: 80, canvas_sync_timeout_ms: 5000 } });

    const response = await createApp().request(`/api/v1/projects/${PROJECT}/three-d/config`, { headers: AUTH });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: {
      scaleSensitivity: 0.04,
      import: {
        maxInputBytes: 33554432,
        maxExpandedBytes: 134217728,
        maxArtifactBytes: 150994944,
        maxFiles: 2048,
        maxEntryJsonBytes: 2097152,
        decoderWorkerLimit: 2,
        maxTextureEdge: 4096,
        maxTextureBytes: 100663296,
      },
      capture: { longEdgePx: 1024, minFramePx: 80, canvasSyncTimeoutMs: 5000 },
    } });
    expect(getSceneConfig).toHaveBeenCalledTimes(1);
  });

  it("allows a Viewer to resolve an asset through the scene service", async () => {
    const response = await createApp().request(`/api/v1/projects/${PROJECT}/three-d/assets/${ASSET}`, { headers: AUTH });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: {
      url: "https://assets.example.test/registered-model.glb", mimeType: "model/gltf-binary", sizeBytes: 5956,
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
