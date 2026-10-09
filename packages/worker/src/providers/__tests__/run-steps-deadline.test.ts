// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * A task's steps against its two-hour deadline (inner#1337 §3.2).
 *
 * A step with no upstream id yet is where money is spent, so past the
 * deadline none is started — not its submit, not the LLM or vision call that
 * builds its body. A step already submitted is asked once more and, when the
 * upstream is still going, goes back to the queue until the deadline, then
 * ends as expired. A pickup of a submitted step makes no outside call before
 * that question.
 */

import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import { initCore } from "@breatic/core";
import type { upstreamStepRepo } from "@breatic/domain";
import type * as httpModule from "@worker/providers/http.js";

type Step = upstreamStepRepo.UpstreamStep;

const runPredictionMock = vi.fn();

vi.mock("@worker/providers/wavespeed.js", () => ({
  runPrediction: (...args: unknown[]) => runPredictionMock(...args),
}));

vi.mock("@worker/providers/http.js", async (importOriginal) => {
  const actual = await importOriginal<typeof httpModule>();
  return { ...actual, queryBilling: async () => 0 };
});

const { runCatalogTask } = await import("@worker/providers/run-steps.js");
const { FAMILIES } = await import("@worker/providers/generate.js");
const { StillRunning, TaskDeadlinePassed } = await import("@worker/providers/still-running.js");

beforeAll(() => {
  initCore({ DATABASE_URL: "postgres://localhost:5432/breatic_test", WAVESPEED_API_KEY: "test-key" });
});

const NOW = 1_800_000_000_000;
const TASK = "0f5c2c7e-1111-4222-8333-944455556666";

/**
 * In-memory step storage, optionally holding steps a previous pickup left.
 * @param preset - Steps already stored.
 * @returns The steps and the dependencies.
 */
function stores(preset: Step[] = []): { steps: Step[]; deps: Parameters<typeof runCatalogTask>[0] } {
  const steps: Step[] = preset.map((s) => ({ ...s }));
  const find = (id: string): Step => steps.find((s) => s.id === id)!;
  const deps: Parameters<typeof runCatalogTask>[0] = {
    steps: {
      ensureSteps: async (_taskId, plan) => {
        if (steps.length === 0) {
          plan.forEach((p, position) =>
            steps.push({ ...p, id: `step-${position}`, position, status: "pending", predictionId: null, output: {}, inlineCostUsd: 0 }),
          );
        }
        return steps.map((s) => ({ ...s }));
      },
      markSubmitted: async (id, predictionId) => {
        Object.assign(find(id), { status: "submitted", predictionId });
      },
      markDone: async (id, output) => {
        Object.assign(find(id), { status: "done", output: { ...find(id).output, ...output } });
      },
      markFailed: async (id, reason) => {
        Object.assign(find(id), { status: "failed", output: { ...find(id).output, error: reason } });
      },
      recordInline: async (id, output, cost) => {
        const step = find(id);
        Object.assign(step, { output: { ...step.output, ...output }, inlineCostUsd: step.inlineCostUsd + cost });
      },
    },
    clones: {
      findClone: async () => null,
      recordClone: async () => true,
      retireClone: async () => undefined,
    },
    sourceKeyOf: async () => null,
    describeImage: vi.fn(async (url: string) => ({ text: `a picture at ${url}`, costUsd: 0.002 })),
  };
  return { steps, deps };
}

/**
 * The run's context with a deadline relative to now.
 * @param offsetMs - Milliseconds from now; negative means already passed.
 * @returns The context.
 */
function ctx(offsetMs: number): Parameters<typeof runCatalogTask>[1] {
  return { taskId: TASK, studioId: null, deadlineAt: NOW + offsetMs };
}

/**
 * A step a previous pickup submitted and left waiting.
 * @param endpoint - The model path it was submitted to.
 * @returns The step.
 */
function submitted(endpoint: string): Step {
  return {
    id: "step-0",
    taskId: TASK,
    position: 0,
    kind: "generate",
    endpoint,
    itemIndex: null,
    status: "submitted",
    predictionId: "pred-kept",
    output: {},
    inlineCostUsd: 0,
  } as Step;
}

beforeEach(() => {
  runPredictionMock.mockReset();
  vi.spyOn(Date, "now").mockReturnValue(NOW);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("a step with no upstream id", () => {
  it("is not submitted once the deadline has passed", async () => {
    const { deps } = stores();

    await expect(
      runCatalogTask(deps, ctx(-1), "tts", "hello", "minimax-speech-2.8-hd", { voice_id: "Wise_Woman" }, 1),
    ).rejects.toBeInstanceOf(TaskDeadlinePassed);
    expect(runPredictionMock).not.toHaveBeenCalled();
  });

  it("does not describe an element image once the deadline has passed", async () => {
    const { deps } = stores();

    await expect(
      runCatalogTask(deps, ctx(-1), "video", "Element 1 waves", "kling-video-o3-4k-image-to-video", {
        elements: ["https://a/cat.png"],
      }, 1),
    ).rejects.toBeInstanceOf(TaskDeadlinePassed);
    expect(deps.describeImage).not.toHaveBeenCalled();
    expect(runPredictionMock).not.toHaveBeenCalled();
  });

  it("does not rewrite a prompt with the LLM once the deadline has passed", async () => {
    const prepare = vi.spyOn(FAMILIES.get("nano-banana-2")!, "prepare");
    const { deps } = stores();

    await expect(runCatalogTask(deps, ctx(-1), "image", "a cat", "nano-banana-2", {}, 1)).rejects.toBeInstanceOf(
      TaskDeadlinePassed,
    );
    expect(prepare).not.toHaveBeenCalled();
  });
});

describe("a step already submitted", () => {
  it("goes back to the queue, not failed, while the upstream is still going before the deadline", async () => {
    runPredictionMock.mockRejectedValue(new StillRunning(NOW + 3_000));
    const { deps, steps } = stores([submitted("google/nano-banana-2/text-to-image")]);

    const err = await runCatalogTask(deps, ctx(60_000), "image", "a cat", "nano-banana-2", {}, 1).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(StillRunning);
    expect((err as InstanceType<typeof StillRunning>).resumeAt).toBe(NOW + 3_000);
    expect(steps[0]!.status).toBe("submitted");
  });

  it("ends as expired when the upstream is still going at the deadline", async () => {
    runPredictionMock.mockRejectedValue(new StillRunning(NOW + 3_000));
    const { deps } = stores([submitted("google/nano-banana-2/text-to-image")]);

    await expect(runCatalogTask(deps, ctx(0), "image", "a cat", "nano-banana-2", {}, 1)).rejects.toBeInstanceOf(
      TaskDeadlinePassed,
    );
  });

  it("is asked once more past the deadline, and keeps a result the upstream had ready", async () => {
    runPredictionMock.mockResolvedValue({ outputs: ["https://o/cat.png"], taskId: "pred-kept" });
    const { deps } = stores([submitted("google/nano-banana-2/text-to-image")]);

    const result = await runCatalogTask(deps, ctx(-1), "image", "a cat", "nano-banana-2", {}, 1);

    expect(result.outputs).toStrictEqual([{ url: "https://o/cat.png" }]);
    expect(runPredictionMock).toHaveBeenCalledTimes(1);
  });

  it("makes no LLM call to rebuild a body it will not send", async () => {
    const prepare = vi.spyOn(FAMILIES.get("nano-banana-2")!, "prepare");
    runPredictionMock.mockRejectedValue(new StillRunning(NOW + 3_000));
    const { deps } = stores([submitted("google/nano-banana-2/text-to-image")]);

    await runCatalogTask(deps, ctx(60_000), "image", "a cat", "nano-banana-2", {}, 1).catch(() => undefined);

    expect(prepare).not.toHaveBeenCalled();
    expect(runPredictionMock.mock.calls[0]![3]).toMatchObject({ storedTaskId: "pred-kept" });
  });
});
