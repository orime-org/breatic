// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * A task's steps against its two-hour deadline (inner#1337 §3.2).
 *
 * A step with no upstream id yet is where money is spent, so past the
 * deadline none is started — not its submit, not the LLM or vision call that
 * builds its body. A step already submitted is asked once more; a still-going
 * answer is handed up as it is, and dispatch decides whether the run goes
 * back to the queue or has run out of its two hours. A pickup of a submitted
 * step makes no outside call before that question.
 */

import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import { initCore } from "@breatic/core";
import type { upstreamStepRepo } from "@breatic/domain";
import type * as httpModule from "@worker/providers/http.js";
import type * as coreModule from "@breatic/core";

type Step = upstreamStepRepo.UpstreamStep;

const runPredictionMock = vi.fn();

vi.mock("@worker/providers/wavespeed.js", () => ({
  runPrediction: (...args: unknown[]) => runPredictionMock(...args),
}));

const { warnMock, infoMock } = vi.hoisted(() => ({ warnMock: vi.fn(), infoMock: vi.fn() }));

vi.mock("@breatic/core", async (importOriginal) => {
  const actual = await importOriginal<typeof coreModule>();
  return { ...actual, logger: { info: infoMock, warn: warnMock, error: vi.fn(), debug: vi.fn() } };
});

vi.mock("@worker/providers/http.js", async (importOriginal) => {
  const actual = await importOriginal<typeof httpModule>();
  return { ...actual, queryBilling: async () => 0 };
});

const { runCatalogTask } = await import("@worker/providers/run-steps.js");
const { FAMILIES } = await import("@worker/providers/generate.js");
const { StillRunning, TaskDeadlinePassed } = await import("@worker/providers/still-running.js");
const { HttpStatusError } = await import("@worker/providers/http.js");

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
function ctx(offsetMs: number, retryStarting = false): Parameters<typeof runCatalogTask>[1] {
  return { taskId: TASK, studioId: null, deadlineAt: NOW + offsetMs, retryStarting };
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
  warnMock.mockReset();
  infoMock.mockReset();
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

  it("does not submit when describing an element image runs past the deadline", async () => {
    const { deps } = stores();
    deps.describeImage = vi.fn(async (url: string) => {
      vi.spyOn(Date, "now").mockReturnValue(NOW + 10_000);
      return { text: `a picture at ${url}`, costUsd: 0.002 };
    });

    await expect(
      runCatalogTask(deps, ctx(5_000), "video", "Element 1 waves", "kling-video-o3-4k-image-to-video", {
        elements: ["https://a/cat.png"],
      }, 1),
    ).rejects.toBeInstanceOf(TaskDeadlinePassed);
    expect(deps.describeImage).toHaveBeenCalledTimes(1);
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

  it("hands a still-going answer up as it is at the deadline, for dispatch to judge", async () => {
    runPredictionMock.mockRejectedValue(new StillRunning(NOW + 3_000));
    const { deps } = stores([submitted("google/nano-banana-2/text-to-image")]);

    await expect(runCatalogTask(deps, ctx(0), "image", "a cat", "nano-banana-2", {}, 1)).rejects.toBeInstanceOf(
      StillRunning,
    );
  });

  it("spends an attempt on a 4xx answer past the deadline, not an expiry", async () => {
    runPredictionMock.mockRejectedValue(new HttpStatusError("wavespeed", 404, "prediction not found"));
    const { deps, steps } = stores([submitted("google/nano-banana-2/text-to-image")]);

    const err = await runCatalogTask(deps, ctx(-1), "image", "a cat", "nano-banana-2", {}, 1).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(HttpStatusError);
    expect(steps[0]!.status).toBe("submitted");
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

describe("a step submitted on this pickup", () => {
  beforeEach(() => {
    vi.spyOn(FAMILIES.get("nano-banana-2")!, "prepare").mockResolvedValue({ prompt: "a cat", fields: {} });
  });

  /**
   * The upstream takes the submit, then answers the first question with `err`.
   * @param err - What the first question throws.
   */
  function submitThenAsk(err: Error): void {
    runPredictionMock.mockImplementation(
      async (_endpoint: unknown, _model: unknown, _body: unknown, resume: { persistTaskId: (id: string) => Promise<void> }) => {
        await resume.persistTaskId("pred-new");
        throw err;
      },
    );
  }

  it("keeps the new upstream id and goes back to the queue while the upstream is still going", async () => {
    submitThenAsk(new StillRunning(NOW + 3_000));
    const { deps, steps } = stores();

    const err = await runCatalogTask(deps, ctx(60_000), "image", "a cat", "nano-banana-2", {}, 1).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(StillRunning);
    expect(steps[0]).toMatchObject({ status: "submitted", predictionId: "pred-new" });
  });

  it("keeps the new upstream id when the first question reaches the deadline, for dispatch to judge", async () => {
    submitThenAsk(new StillRunning(NOW + 3_000));
    const { deps, steps } = stores();

    const err = await runCatalogTask(deps, ctx(1), "image", "a cat", "nano-banana-2", {}, 1).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(StillRunning);
    expect(steps[0]).toMatchObject({ status: "submitted", predictionId: "pred-new" });
  });

  it("keeps the new upstream id and spends an attempt when the first question gets a 4xx", async () => {
    submitThenAsk(new HttpStatusError("wavespeed", 404, "prediction not found"));
    const { deps, steps } = stores();

    const err = await runCatalogTask(deps, ctx(60_000), "image", "a cat", "nano-banana-2", {}, 1).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(HttpStatusError);
    expect(steps[0]).toMatchObject({ status: "submitted", predictionId: "pred-new" });
  });
});

describe("which step a retry hands its duplicate-cost check to", () => {
  beforeEach(() => {
    vi.spyOn(FAMILIES.get("nano-banana-2")!, "prepare").mockResolvedValue({ prompt: "a cat", fields: {} });
  });

  /**
   * The `retryStarting` each prediction was given, in call order.
   * @returns The flags.
   */
  function flags(): unknown[] {
    return runPredictionMock.mock.calls.map((call) => (call[3] as { retryStarting: unknown }).retryStarting);
  }

  it("goes to the step a retry pickup starts at when it holds no upstream id", async () => {
    runPredictionMock.mockResolvedValue({ outputs: ["https://o/a.mp3"], taskId: "pred-1" });
    const { deps } = stores();

    await runCatalogTask(deps, ctx(60_000, true), "tts", "hello", "minimax-speech-2.8-hd", { voice_id: "Wise_Woman" }, 1);

    expect(flags()).toStrictEqual([true]);
  });

  // The rewrite is a paid LLM call that runs again before the submit, so the
  // warning comes ahead of it, once for the retry.
  it("warns before rewriting a prompt again, and hands the submit no warning", async () => {
    runPredictionMock.mockResolvedValue({ outputs: ["https://o/cat.png"], taskId: "pred-1" });
    vi.mocked(FAMILIES.get("nano-banana-2")!.prepare).mockImplementation(async () => {
      expect(duplicateWarnings()).toHaveLength(1);
      return { prompt: "a cat", fields: {} };
    });
    const { deps } = stores();

    await runCatalogTask(deps, ctx(60_000, true), "image", "a cat", "nano-banana-2", {}, 1);

    expect(duplicateWarnings()).toStrictEqual([{ taskId: TASK, submit: `breatic-${TASK}-0` }]);
    expect(flags()).toStrictEqual([false]);
  });

  it("keeps the warning when the rewrite runs past the deadline", async () => {
    vi.mocked(FAMILIES.get("nano-banana-2")!.prepare).mockImplementation(async () => {
      vi.spyOn(Date, "now").mockReturnValue(NOW + 10_000);
      return { prompt: "a cat", fields: {} };
    });
    const { deps } = stores();

    await expect(
      runCatalogTask(deps, ctx(5_000, true), "image", "a cat", "nano-banana-2", {}, 1),
    ).rejects.toBeInstanceOf(TaskDeadlinePassed);

    expect(duplicateWarnings()).toHaveLength(1);
    expect(runPredictionMock).not.toHaveBeenCalled();
  });

  it("does not go to a step that only asks about its stored id", async () => {
    runPredictionMock.mockResolvedValue({ outputs: ["https://o/cat.png"], taskId: "pred-kept" });
    const { deps } = stores([submitted("google/nano-banana-2/text-to-image")]);

    await runCatalogTask(deps, ctx(60_000, true), "image", "a cat", "nano-banana-2", {}, 1);

    expect(flags()).toStrictEqual([false]);
  });

  it("does not go to a later step the failed attempt never reached", async () => {
    // The first pickup submits the voice clone and leaves it waiting.
    runPredictionMock.mockImplementationOnce(
      async (_e: unknown, _m: unknown, _b: unknown, resume: { persistTaskId: (id: string) => Promise<void> }) => {
        await resume.persistTaskId("pred-voice");
        throw new StillRunning(NOW + 3_000);
      },
    );
    const { deps } = stores();
    await runCatalogTask(deps, ctx(60_000), "tts", "read this", "minimax-voice-clone", { audio: "https://a/me.mp3" }, 1).catch(
      () => undefined,
    );
    runPredictionMock.mockReset();
    // The retry pickup: the clone answers, then the speech is submitted for the first time.
    runPredictionMock
      .mockResolvedValueOnce({ outputs: [], taskId: "pred-voice" })
      .mockResolvedValueOnce({ outputs: ["https://o/speech.mp3"], taskId: "pred-speak" });

    await runCatalogTask(deps, ctx(60_000, true), "tts", "read this", "minimax-voice-clone", { audio: "https://a/me.mp3" }, 1);

    expect(flags()).toStrictEqual([false, false]);
  });

  /**
   * The duplicate-cost warnings written, by their context.
   * @returns The first argument of each warning.
   */
  function duplicateWarnings(): unknown[] {
    return warnMock.mock.calls
      .filter((call) => call[1] === "provider_reinvoked_on_retry_potential_duplicate_cost")
      .map((call) => call[0]);
  }

  const ELEMENT = { elements: ["https://a/cat.png"] };

  // A missing description means the attempt before stopped at or before the
  // describe, so the describe is what may be paid for twice and the submit is new.
  it("warns before describing an element image again, and hands the submit no warning", async () => {
    runPredictionMock.mockResolvedValue({ outputs: [{ element_id: "el-1" }], taskId: "pred-1" });
    const { deps } = stores();
    deps.describeImage = vi.fn(async (url: string) => {
      expect(duplicateWarnings()).toHaveLength(1);
      return { text: `a picture at ${url}`, costUsd: 0.002 };
    });

    await runCatalogTask(deps, ctx(60_000, true), "video", "Element 1 waves", "kling-video-o3-4k-image-to-video", ELEMENT, 1).catch(
      () => undefined,
    );

    expect(deps.describeImage).toHaveBeenCalledTimes(1);
    expect(duplicateWarnings()).toStrictEqual([{ taskId: TASK, submit: `breatic-${TASK}-0` }]);
    expect(flags()[0]).toBe(false);
  });

  it("keeps the warning when no reading place is free for the describe", async () => {
    const { deps } = stores();
    deps.describeImage = vi.fn(async () => {
      throw new StillRunning(NOW + 3_000);
    });

    await expect(
      runCatalogTask(deps, ctx(60_000, true), "video", "Element 1 waves", "kling-video-o3-4k-image-to-video", ELEMENT, 1),
    ).rejects.toBeInstanceOf(StillRunning);

    expect(duplicateWarnings()).toHaveLength(1);
  });

  it("hands the submit the warning when the element was described but never submitted", async () => {
    runPredictionMock.mockResolvedValue({ outputs: [{ element_id: "el-1" }], taskId: "pred-1" });
    const described = {
      id: "step-0", taskId: TASK, position: 0, kind: "element", endpoint: "kwaivgi/kling-elements",
      itemIndex: 0, status: "pending", predictionId: null, output: { description: "a cat" }, inlineCostUsd: 0.002,
    } as Step;
    const { deps } = stores([described]);

    await runCatalogTask(deps, ctx(60_000, true), "video", "Element 1 waves", "kling-video-o3-4k-image-to-video", ELEMENT, 1).catch(
      () => undefined,
    );

    expect(deps.describeImage).not.toHaveBeenCalled();
    expect(flags()[0]).toBe(true);
  });

  it("logs the stored upstream id a retry resumes", async () => {
    runPredictionMock.mockResolvedValue({ outputs: ["https://o/cat.png"], taskId: "pred-kept" });
    const { deps } = stores([submitted("google/nano-banana-2/text-to-image")]);

    await runCatalogTask(deps, ctx(60_000, true), "image", "a cat", "nano-banana-2", {}, 1);

    expect(infoMock).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: TASK, providerTaskId: "pred-kept" }),
      "async_resume_stored_provider_task",
    );
  });

  it("logs no resumed id on a pickup that is not a retry", async () => {
    runPredictionMock.mockResolvedValue({ outputs: ["https://o/cat.png"], taskId: "pred-kept" });
    const { deps } = stores([submitted("google/nano-banana-2/text-to-image")]);

    await runCatalogTask(deps, ctx(60_000), "image", "a cat", "nano-banana-2", {}, 1);

    expect(infoMock).not.toHaveBeenCalledWith(expect.anything(), "async_resume_stored_provider_task");
  });
});
