// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * The two VALIDATING execution paths hand the user's prompt to the provider
 * (#1966 / #1967).
 *
 * `dispatch.ts` numbers three: `runMiniTool`, `runUnderstand`, `runAigcDirect`.
 * Only the first and third validate params against the model, so only they can
 * get the lift-then-validate ORDER wrong, and only they go through
 * `takePromptAndValidate`. `runUnderstand` also hands a prompt to a provider,
 * but it builds its params from scratch and never calls `validateParams`, so
 * there is no order in it to pin.
 *
 * `prompt-params.test.ts` pins what `takePromptAndValidate` does. This pins
 * that those two paths CALL it — a separate invariant, and one that was
 * unguarded: adversarial round 2 reversed `runMiniTool` back to
 * validate-then-read and all 246 worker tests stayed green.
 *
 * The models here declare NO `prompt` param, which is the shape the whole
 * change created: #1966 deleted every `params.prompt` from the catalog, so a
 * path that validates first hands the provider an empty string and the user's
 * words are gone with one `unknown_param_dropped` line in the log.
 */

import { vi, describe, it, expect, beforeEach } from "vitest";

const mockGenerateAsync = vi.hoisted(() => vi.fn());
const mockResolveMiniToolEntry = vi.hoisted(() => vi.fn());

vi.mock("@breatic/core", () => ({
  env: { ENV: "test", CREDIT_MULTIPLIER: 1 },
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  publishNodeEvent: vi.fn(),
  getStreamRedis: vi.fn(),
  getRedis: vi.fn(),
  getWorkerConfig: vi.fn(),
  getAgentConfig: vi.fn(),
  projectActivitiesRepo: {},
  publishActivityNew: vi.fn(),
  downloadAndStore: vi.fn(),
  getStorageAdapter: vi.fn(),
  storageKey: vi.fn(),
  sha256Hex: vi.fn(),
  NotFoundError: class NotFoundError extends Error {},
}));

vi.mock("@breatic/domain", () => ({
  taskService: {},
  nodeHistoryService: {},
  assetService: {},
  getModel: vi.fn(),
  buildAgentConfig: vi.fn(),
  generateTextRetry: vi.fn(),
  // The real one; the prompt must reach the provider stripped, and that is
  // part of what this file asserts.
  extractPromptText: (x: unknown) => String(x ?? "").replace(/<[^>]*>/g, ""),
  releaseCanvasNodeLock: vi.fn(),
  reacquireCanvasNodeLock: vi.fn(),
}));

vi.mock("@breatic/shared", () => ({
  canvasSpaceDocName: (pid: string, sid: string) => `project-${pid}/canvas-${sid}`,
}));

vi.mock("@worker/mini-tool-registry.js", () => ({
  resolveMiniToolEntry: mockResolveMiniToolEntry,
}));

vi.mock("@worker/handlers/local/index.js", () => ({
  runLocalHandler: vi.fn(),
}));

vi.mock("ai", () => ({
  tool: (c: Record<string, unknown>) => c,
  generateText: vi.fn(),
  streamText: vi.fn(),
  stepCountIs: vi.fn(),
}));

// The provider module `importProvider` reaches for. Its validator behaves like
// the real `validateParams`: it drops every key the model does not declare.
vi.mock("@worker/providers/video/index.js", () => ({
  validateVideoParams: (
    model: string | undefined,
    params?: Record<string, unknown>,
  ): [string, Record<string, unknown>] => {
    const DECLARED = ["image", "duration"];
    const kept: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(params ?? {})) {
      if (DECLARED.includes(k)) kept[k] = v;
    }
    return [model ?? "kling-o3-pro", kept];
  },
  generateAsync: mockGenerateAsync,
}));

import { runAigcDirect, runMiniTool } from "@worker/handlers/dispatch.js";

/** The resume context both validating paths thread through; nothing reads it. */
const RESUME = {} as Parameters<typeof runAigcDirect>[3];

beforeEach(() => {
  mockGenerateAsync.mockReset();
  mockGenerateAsync.mockResolvedValue({ cost: 0 });
  mockResolveMiniToolEntry.mockReset();
});

describe("both validating execution paths carry the prompt to the provider", () => {
  it("runMiniTool: the provider gets the prompt even though the model declares none", async () => {
    mockResolveMiniToolEntry.mockReturnValue({
      kind: "provider",
      model: "kling-o3-pro",
    });

    await runMiniTool({
      toolName: "extend",
      taskType: "video",
      params: {
        prompt: "a drone shot over a canyon",
        image: "https://cdn/x.png",
        node_ids: ["n1"],
        project_id: "p1",
      },
      jobId: "job-1",
      userId: "u1",
      projectId: "p1",
      resume: RESUME,
    });

    expect(mockGenerateAsync).toHaveBeenCalledTimes(1);
    const [prompt, model, params] = mockGenerateAsync.mock.calls[0]!;
    expect(prompt).toBe("a drone shot over a canyon");
    expect(model).toBe("kling-o3-pro");
    // The validator dropped everything undeclared, and that is exactly why the
    // prompt had to leave `params` before it ran.
    expect(params).toEqual({ image: "https://cdn/x.png" });
  });

  it("runAigcDirect: same, from the other path", async () => {
    await runAigcDirect(
      "video",
      "kling-o3-pro",
      {
        prompt: "a drone shot over a canyon",
        image: "https://cdn/x.png",
        node_ids: ["n1"],
        project_id: "p1",
      },
      RESUME,
    );

    expect(mockGenerateAsync).toHaveBeenCalledTimes(1);
    const [prompt, , params] = mockGenerateAsync.mock.calls[0]!;
    expect(prompt).toBe("a drone shot over a canyon");
    expect(params).toEqual({ image: "https://cdn/x.png" });
  });

  it("runMiniTool: the prompt arrives stripped, like every AIGC prompt must", async () => {
    mockResolveMiniToolEntry.mockReturnValue({
      kind: "provider",
      model: "kling-o3-pro",
    });

    await runMiniTool({
      toolName: "extend",
      taskType: "video",
      params: { prompt: "<b>bold</b> plan" },
      jobId: "job-1",
      userId: "u1",
      projectId: "p1",
      resume: RESUME,
    });

    expect(mockGenerateAsync.mock.calls[0]![0]).toBe("bold plan");
  });

  it("both validating paths read `text` too — the key TTS models carry the same argument under", async () => {
    mockResolveMiniToolEntry.mockReturnValue({
      kind: "provider",
      model: "kling-o3-pro",
    });
    await runMiniTool({
      toolName: "extend",
      taskType: "video",
      params: { text: "spoken line" },
      jobId: "job-1",
      userId: "u1",
      projectId: "p1",
      resume: RESUME,
    });
    expect(mockGenerateAsync.mock.calls[0]![0]).toBe("spoken line");

    mockGenerateAsync.mockClear();
    await runAigcDirect("video", "kling-o3-pro", { text: "spoken line" }, RESUME);
    expect(mockGenerateAsync.mock.calls[0]![0]).toBe("spoken line");
  });
});
