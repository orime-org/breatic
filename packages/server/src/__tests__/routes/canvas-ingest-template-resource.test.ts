// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * `POST /canvas/ingest-url` with `template_resource` (inner#1345, design 6.6).
 *
 * A template's resource node is fetched into the reader's storage through the
 * same lane as any address, but the client sends only the storage path the
 * template declares. The server checks that some template in the registry
 * declares that path, builds the address with `voiceSampleUrl(path)` and hands
 * that address to everything the lane already does with one. A path no
 * template declares is refused before anything is opened.
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
vi.mock("ai", () => ({
  tool: (c: Record<string, unknown>) => c,
  streamText: vi.fn(),
  generateText: vi.fn(),
  stepCountIs: vi.fn(),
}));

vi.mock("@breatic/core", async (importOriginal) => {
  const { coreMock } = await import("../helpers/mock-core.js");
  const base = await coreMock(importOriginal);
  return {
    ...base,
    // The lane reads the ticket lifetime and the task budget; the shared
    // double carries neither.
    getStorageConfig: () => ({
      upload: { max_upload_bytes: 1024 },
      ingest: { ticket_expires_seconds: 600 },
    }),
    getNodeTaskConfig: () => ({ default_budget_ms: 7_200_000 }),
  };
});

/** A base no real config has, so the assertions prove the route asked `voiceSampleUrl`. */
const RESOURCE_BASE = "https://resource.test.invalid";

vi.mock("@breatic/domain", async () => {
  const { domainMock } = await import("../helpers/mock-core.js");
  return {
    ...domainMock(),
    voiceSampleUrl: vi.fn((key: string) => `${RESOURCE_BASE}/${key}`),
  };
});

vi.mock("@server/modules", async (importOriginal) => {
  const { serverModulesMock } = await import("../helpers/mock-core.js");
  return serverModulesMock(importOriginal);
});

// The grant and the row are pinned by ingest-url.integration.test.ts; here
// only what the route hands them matters.
vi.mock("../../modules/asset/upload-opening.js", () => ({
  openUpload: vi.fn(async () => ({ key: "image/k.png", studioId: "studio-1", taskId: "task-1" })),
}));

import { GENERATION_TEMPLATES, type GenerationTemplate } from "@breatic/shared";
import { createApp } from "../../app.js";
import { mocks, mockQueueAdd } from "../helpers/mock-core.js";
import { openUpload } from "../../modules/asset/upload-opening.js";

const AUTH = { Cookie: "breatic_session=valid-token" };
const PROJECT = "11111111-1111-4111-8111-111111111111";
const SPACE = "33333333-3333-4333-8333-333333333333";
const NODE = "44444444-4444-4444-8444-444444444444";

const DECLARED = "templates/test-resource-template/style.png";

/** A template that declares one hosted resource wired into its anchor. */
const FIXTURE: GenerationTemplate = {
  id: "test-resource-template",
  anchor: "sheet",
  nodes: [
    {
      key: "sheet",
      role: "generate",
      type: "image",
      mode: "i2i",
      model: "nano-banana-pro-edit-ultra",
      params: {},
    },
    { key: "style", role: "source", type: "image", resource: DECLARED },
  ],
  edges: [{ from: "style", to: "sheet" }],
  inputs: [],
  steps: [],
  agentNote: "a test template with one hosted resource",
};

// The registry is the one the route reads; the fixture joins it for this file
// only, and leaves it as it was found.
beforeAll(() => {
  (GENERATION_TEMPLATES as GenerationTemplate[]).push(FIXTURE);
});

afterAll(() => {
  const list = GENERATION_TEMPLATES as GenerationTemplate[];
  const at = list.indexOf(FIXTURE);
  if (at >= 0) list.splice(at, 1);
});

/**
 * Submit a request to the lane.
 * @param body - The fields beside project, space and node.
 * @returns The route's answer.
 */
async function submit(body: Record<string, unknown>): Promise<Response> {
  const app = createApp();
  return app.request("/api/v1/canvas/ingest-url", {
    method: "POST",
    headers: { ...AUTH, "content-type": "application/json" },
    body: JSON.stringify({ project_id: PROJECT, space_id: SPACE, node_id: NODE, ...body }),
  });
}

describe("POST /canvas/ingest-url — template_resource", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockQueueAdd.mockResolvedValue({ id: "job-1" });
  });

  it("still takes a plain address the way it always has (harness control)", async () => {
    const res = await submit({ url: "https://cdn.test.invalid/a/clip.mp4" });

    expect(res.status).toBe(201);
    expect(mockQueueAdd).toHaveBeenCalledTimes(1);
    expect(mockQueueAdd.mock.calls[0]![1]).toMatchObject({
      url: "https://cdn.test.invalid/a/clip.mp4",
    });
  });

  it("builds the address of a declared path with voiceSampleUrl and queues it", async () => {
    const res = await submit({ template_resource: DECLARED });

    expect(res.status).toBe(201);
    expect(mockQueueAdd).toHaveBeenCalledTimes(1);
    expect(mockQueueAdd.mock.calls[0]![0]).toBe("ingest-url");
    expect(mockQueueAdd.mock.calls[0]![1]).toMatchObject({
      url: `${RESOURCE_BASE}/${DECLARED}`,
      projectId: PROJECT,
      spaceId: SPACE,
      nodeId: NODE,
    });
  });

  it("names the stored extension and the row's label from the built address", async () => {
    await submit({ template_resource: DECLARED });

    const opened = vi.mocked(openUpload).mock.calls;
    expect(opened).toHaveLength(1);
    expect(opened[0]![0]).toMatchObject({ ext: ".png", taskType: "url" });
    expect(opened[0]![1]).toMatchObject({
      label: `${RESOURCE_BASE}/${DECLARED}`,
      action: "upload",
      budgetMs: 7_200_000,
    });
  });

  it("goes through the same access and storage gates as an address", async () => {
    await submit({ template_resource: DECLARED });

    expect(mocks.projectService.assertAccess).toHaveBeenCalledWith(PROJECT, "user-1", "editor");
    expect(mocks.assertStorageAllowance).toHaveBeenCalledWith(PROJECT, "upload");
  });

  it.each([
    ["a file the template does not declare", "templates/test-resource-template/other.png"],
    ["a path under a template id the registry does not have", "templates/no-such-template/style.png"],
    ["a declared path walked out of with ..", "templates/test-resource-template/../../secret.png"],
    ["a full address instead of a path", "https://evil.test.invalid/templates/test-resource-template/style.png"],
  ])("answers 422 to %s and opens nothing", async (_label, path) => {
    const res = await submit({ template_resource: path });

    expect(res.status).toBe(422);
    expect(vi.mocked(openUpload)).not.toHaveBeenCalled();
    expect(mockQueueAdd).not.toHaveBeenCalled();
  });

  it("refuses a request carrying both an address and a template_resource", async () => {
    // Design 6.6: the two are one or the other.
    const res = await submit({
      url: "https://cdn.test.invalid/a/clip.mp4",
      template_resource: DECLARED,
    });

    expect(res.status).toBe(422);
    expect(vi.mocked(openUpload)).not.toHaveBeenCalled();
    expect(mockQueueAdd).not.toHaveBeenCalled();
  });
});
