// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * A model run, a canvas generation or a model mini-tool, as provider is handed it (inner#1743): the prompt lifted
 * out before the params are validated (#1967), the run laid out in our param names, the route the estimate used,
 * Nano Banana 2's prompt rewritten only when the run is opened, and what a task from before provider left behind.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as sharedModule from "@breatic/shared";
import type { LegacyRows, MediaInput } from "@breatic/provider/media";

const h = vi.hoisted(() => ({
  runMedia: vi.fn(),
  rewrittenPrompt: vi.fn(),
  createMediaRunner: vi.fn(),
  getByIdInternal: vi.fn(),
  listSteps: vi.fn(),
  resolveOwnerStudioId: vi.fn(),
  findHashByStorageKey: vi.fn(),
  getProviderTicket: vi.fn(),
  withUnderstandSlot: vi.fn((read: () => Promise<unknown>) => read()),
}));

vi.mock("@breatic/core", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  getWorkerConfig: () => ({ poll_interval: 5000 }),
  getUnderstandConfig: () => ({ max_media_bytes: 20_000_000 }),
  getStorageAdapter: async () => ({ keyFromUrl: (url: string) => (url.startsWith("https://assets/") ? url.slice("https://assets/".length) : null) }),
}));
vi.mock("@breatic/domain", () => ({
  provider: () => ({ name: "the-provider" }),
  taskRepo: { getProviderTicket: h.getProviderTicket },
  taskService: { getByIdInternal: h.getByIdInternal },
  upstreamStepRepo: { listSteps: h.listSteps },
  upstreamCloneRepo: { name: "upstreamCloneRepo" },
  assetService: { resolveOwnerStudioId: h.resolveOwnerStudioId },
  assetRepo: { findHashByStorageKey: h.findHashByStorageKey },
}));
vi.mock("@breatic/shared", async (importOriginal) => ({ ...(await importOriginal<typeof sharedModule>()) }));
vi.mock("@breatic/provider/media", () => ({ createMediaRunner: h.createMediaRunner }));
vi.mock("@worker/handlers/media-run.js", () => ({ runMedia: h.runMedia }));
vi.mock("@worker/handlers/prompt-rewrite.js", () => ({ rewrittenPrompt: h.rewrittenPrompt, REWRITTEN_MODELS: new Set(["nano-banana-2"]) }));
vi.mock("@worker/handlers/understand-slots.js", () => ({ withUnderstandSlot: h.withUnderstandSlot }));
// The validator behaves like the real one: it drops every key the model does not declare.
vi.mock("@worker/handlers/model-params.js", () => ({
  validateModelParams: (_modality: string, model: string, params: Record<string, unknown>): [string, Record<string, unknown>] => {
    const declared = MODELS[model]!.params;
    return [model, Object.fromEntries(Object.entries(params).filter(([k]) => k in declared))];
  },
  entryOf: (_modality: string, model: string): unknown => MODELS[model],
}));

/** The catalog entries the runs below use; none declares a `prompt`. */
const MODELS: Record<string, { name: string; takes_prompt: boolean; params: Record<string, object> }> = {
  "kling-o3-pro": { name: "kling-o3-pro", takes_prompt: true, params: { image: { fill: "canvas" }, duration: { fill: "panel" } } },
  "nano-banana-2": {
    name: "nano-banana-2",
    takes_prompt: true,
    params: { resolution: { fill: "panel" }, enable_camera: { fill: "panel" }, camera: { fill: "panel" } },
  },
};

import { runModelTask, type ModelTask } from "@worker/handlers/model-task.js";

const TASK: ModelTask = {
  taskId: "task-1",
  modality: "video",
  model: "kling-o3-pro",
  params: { prompt: "a <b>drone</b> shot", image: "https://cdn/x.png", duration: 5, node_ids: ["n1"], project_id: "p1", model: "x", stray: 1 },
  projectId: "p1",
  outputCount: 1,
  deadlineAt: Date.now() + 60_000,
  lastAttempt: true,
};

/**
 * The run handed to runMedia, and the input it builds for a task that left the given rows.
 * @param task - The task.
 * @param legacy - What the task left behind.
 * @returns The run and its input.
 */
async function handed(task: ModelTask, legacy: LegacyRows = {}): Promise<{ run: Record<string, unknown>; input: MediaInput }> {
  await runModelTask(task);
  const [run] = h.runMedia.mock.calls.at(-1)! as [{ input: (rows: LegacyRows) => Promise<MediaInput> } & Record<string, unknown>];
  return { run, input: await run.input(legacy) };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.runMedia.mockResolvedValue({ outputs: [], costs: [], servedBy: "wavespeed" });
  h.resolveOwnerStudioId.mockResolvedValue("studio-1");
  h.rewrittenPrompt.mockResolvedValue('{"subject":"rewritten"}');
});

describe("runModelTask", () => {
  it("hands provider the cleaned prompt and only the declared params, under our names", async () => {
    const { run, input } = await handed(TASK);

    expect(input).toEqual({ prompt: "a drone shot", params: { image: "https://cdn/x.png", duration: 5 } });
    expect(run).toMatchObject({ taskId: "task-1", studioId: "studio-1", model: "kling-o3-pro", outputCount: 1, deadlineAt: TASK.deadlineAt, lastAttempt: true });
  });

  it("runs on the route the estimate used, and on the default one when the task names none", async () => {
    const pinned = await handed({ ...TASK, params: { ...TASK.params, route: { mode: "upstream", upstream: "fal" } } });
    expect(pinned.run.route).toEqual({ mode: "upstream", upstream: "fal" });
    expect(pinned.input.params).not.toHaveProperty("route");

    expect((await handed(TASK)).run.route).toEqual({ mode: "default" });
  });

  it("leaves the clone cache alone for a task with no project", async () => {
    const { run } = await handed({ ...TASK, projectId: undefined });
    expect(run.studioId).toBeNull();
    expect(h.resolveOwnerStudioId).not.toHaveBeenCalled();
  });

  it("keys a source by its asset's hash, and a url that is not ours by nothing", async () => {
    h.findHashByStorageKey.mockResolvedValue("sha-1");
    await runModelTask(TASK);
    const deps = h.runMedia.mock.calls[0]![1] as { sourceKeyOf(url: string): Promise<string | null> };

    expect(await deps.sourceKeyOf("https://assets/k/a.png")).toBe("sha-1");
    expect(h.findHashByStorageKey).toHaveBeenCalledWith("k/a.png");
    expect(await deps.sourceKeyOf("https://elsewhere/a.png")).toBeNull();
  });

  // The description a video element is created with is a reading of media like a canvas one (inner#1337 §3.3).
  it("describes inside one of this process's reading places", async () => {
    await runModelTask(TASK);
    const deps = h.runMedia.mock.calls[0]![1] as { readingPlace: unknown };
    expect(deps.readingPlace).toBe(h.withUnderstandSlot);
  });

  it("builds the process's one media runner once, with the reading limit and the poll pace", async () => {
    // A fresh module, so the runner an earlier case built does not count.
    vi.resetModules();
    h.createMediaRunner.mockReturnValue({ name: "runner" });
    const fresh = await import("@worker/handlers/model-task.js");
    await fresh.runModelTask(TASK);
    await fresh.runModelTask(TASK);

    expect(h.createMediaRunner).toHaveBeenCalledTimes(1);
    expect(h.createMediaRunner).toHaveBeenCalledWith({ name: "the-provider" }, { mediaLimits: { maxMediaBytes: 20_000_000 }, pollIntervalMs: 5000 });
  });
});

describe("what a task from before provider left behind", () => {
  it("hands over its stored vendor task id and its steps, the container job left out", async () => {
    h.getByIdInternal.mockResolvedValue({ providerTaskId: "pred-0" });
    const step = { id: "s1", position: 0, kind: "generate", endpoint: "kwaivgi/x", itemIndex: null, status: "submitted", predictionId: "pred-1", output: {}, inlineCostUsd: 0 };
    h.listSteps.mockResolvedValue([step, { ...step, id: "s2", position: 1, kind: "container_job" }]);
    await runModelTask(TASK);
    const deps = h.runMedia.mock.calls[0]![1] as { legacy(taskId: string): Promise<LegacyRows> };

    expect(await deps.legacy("task-1")).toEqual({
      providerTaskId: "pred-0",
      steps: [{ position: 0, kind: "generate", endpoint: "kwaivgi/x", itemIndex: null, status: "submitted", predictionId: "pred-1", output: {}, inlineCostUsd: 0 }],
    });
  });
});

describe("Nano Banana 2's rewrite", () => {
  const NANO: ModelTask = { ...TASK, modality: "image", model: "nano-banana-2", params: { prompt: "a cat", resolution: "1k", enable_camera: true, camera: "ARRI Alexa 35" } };

  it("rewrites a new run's prompt, the catalog's own shape as its fallback", async () => {
    const { input } = await handed(NANO);

    expect(input.prompt).toBe('{"subject":"rewritten"}');
    expect(h.rewrittenPrompt).toHaveBeenCalledWith(
      "a cat",
      { resolution: "1k", enable_camera: true, camera: "ARRI Alexa 35" },
      JSON.stringify({ subject: "a cat", technical: { camera: "ARRI Alexa 35" } }),
      NANO.deadlineAt,
    );
    expect(input.params).toEqual({ resolution: "1k" });
  });

  it("rewrites a run from before provider whose generate step was never submitted", async () => {
    const pending = { position: 0, kind: "generate", endpoint: "google/nano-banana-2", itemIndex: null, status: "pending", predictionId: null, output: {}, inlineCostUsd: 0 } as const;
    expect((await handed(NANO, { steps: [pending] })).input.prompt).toBe('{"subject":"rewritten"}');
  });

  it("does not rewrite a run whose generate step an upstream already took", async () => {
    const submitted = { position: 0, kind: "generate", endpoint: "google/nano-banana-2", itemIndex: null, status: "submitted", predictionId: "pred-1", output: {}, inlineCostUsd: 0 } as const;
    const camera = JSON.stringify({ subject: "a cat", technical: { camera: "ARRI Alexa 35" } });

    expect((await handed(NANO, { steps: [submitted] })).input.prompt).toBe(camera);
    expect((await handed(NANO, { providerTaskId: "pred-0" })).input.prompt).toBe(camera);
    expect(h.rewrittenPrompt).not.toHaveBeenCalled();
  });

  it("leaves every other model's prompt as written", async () => {
    await handed(TASK);
    expect(h.rewrittenPrompt).not.toHaveBeenCalled();
  });
});

describe("abandonedCosts", () => {
  it("asks provider what a held ticket cost, and answers nothing for a task holding none", async () => {
    vi.resetModules();
    const abandon = vi.fn(() => ({ costs: [{ state: "pending", lookup: { upstream: "fal" } }] }));
    h.createMediaRunner.mockReturnValue({ abandon });
    h.getProviderTicket
      .mockResolvedValueOnce({ ticket: { version: 3 }, sendingAt: null })
      .mockResolvedValueOnce({ ticket: null, sendingAt: null });
    const fresh = await import("@worker/handlers/model-task.js");

    expect(await fresh.abandonedCosts("task-1")).toEqual([{ state: "pending", lookup: { upstream: "fal" } }]);
    expect(abandon).toHaveBeenCalledWith({ version: 3 });
    expect(await fresh.abandonedCosts("task-2")).toEqual([]);
  });
});
