// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * One task run as its upstream steps, against the real catalog (#2156,
 * design §15): each step posts once, resumes by its stored prediction id,
 * feeds what it answered into the next, and the run is billed across all of
 * them.
 */

import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { initCore } from "@breatic/core";
import type { upstreamStepRepo } from "@breatic/domain";
import type * as httpModule from "@worker/providers/http.js";

type Step = upstreamStepRepo.UpstreamStep;

const runPredictionMock = vi.fn();
const queryBillingMock = vi.fn();

vi.mock("@worker/providers/wavespeed.js", () => ({
  runPrediction: (...args: unknown[]) => runPredictionMock(...args),
}));

vi.mock("@worker/providers/http.js", async (importOriginal) => {
  const actual = await importOriginal<typeof httpModule>();
  return { ...actual, queryBilling: (...args: unknown[]) => queryBillingMock(...args) };
});

const { runCatalogTask } = await import("@worker/providers/run-steps.js");
const { validateModelParams } = await import("@worker/providers/generate.js");
const { UpstreamTaskFailed } = await import("@worker/providers/http.js");

beforeAll(() => {
  initCore({ DATABASE_URL: "postgres://localhost:5432/breatic_test", WAVESPEED_API_KEY: "test-key" });
});

/** In-memory stand-ins for the step and clone repositories. */
function stores(preset: Step[] = []): {
  steps: Step[];
  clones: Map<string, string>;
  retired: string[];
  deps: Parameters<typeof runCatalogTask>[0];
} {
  const steps: Step[] = preset.map((s) => ({ ...s }));
  const clones = new Map<string, string>();
  const retired: string[] = [];
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
        const step = find(id);
        Object.assign(step, { status: "done", output: { ...step.output, ...output } });
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
      findClone: async (_studio, kind, key) => clones.get(`${kind}:${key}`) ?? null,
      recordClone: async (_studio, kind, key, id) => {
        if (clones.has(`${kind}:${key}`)) return false;
        clones.set(`${kind}:${key}`, id);
        return true;
      },
      retireClone: async (_studio, kind, id) => {
        retired.push(`${kind}:${id}`);
        for (const [k, v] of clones) if (v === id) clones.delete(k);
      },
    },
    sourceKeyOf: async (url) => `sha-of-${url}`,
    describeImage: async (url) => ({ text: `a picture at ${url}`, costUsd: 0.002 }),
  };
  return { steps, clones, retired, deps };
}

const CTX = { taskId: "0f5c2c7e-1111-4222-8333-944455556666", studioId: "studio-1" };

/**
 * The model path and body of the n-th prediction.
 * @param n - Call index.
 * @returns Both.
 */
function call(n: number): { endpoint: string; body: Record<string, unknown> } {
  const args = runPredictionMock.mock.calls[n]! as [unknown, string, Record<string, unknown>];
  return { endpoint: args[1], body: args[2] };
}

/**
 * Answer predictions in turn, each with its own id.
 * @param outputs - The outputs of each call.
 */
function answers(...outputs: unknown[][]): void {
  outputs.forEach((out, i) => runPredictionMock.mockResolvedValueOnce({ outputs: out, taskId: `pred-${i}` }));
}

beforeEach(() => {
  runPredictionMock.mockReset();
  queryBillingMock.mockReset();
  queryBillingMock.mockResolvedValue(0.01);
});

describe("runCatalogTask", () => {
  it("runs a plain model as one step and bills its prediction", async () => {
    const { deps, steps } = stores();
    answers(["https://cdn/out.mp3"]);

    const result = await runCatalogTask(deps, CTX, "tts", "hello", "minimax-speech-2.8-hd", { voice_id: "Wise_Woman" });

    expect(call(0)).toMatchObject({ endpoint: "minimax/speech-2.8-hd", body: { text: "hello", voice_id: "Wise_Woman" } });
    expect(steps.map((s) => s.status)).toEqual(["done"]);
    expect(result).toEqual({ outputs: [{ url: "https://cdn/out.mp3" }], model: "minimax-speech-2.8-hd", cost: 0.01 });
  });

  it("resumes a submitted step by its stored prediction id", async () => {
    const { deps } = stores([
      { id: "s0", position: 0, kind: "generate", endpoint: "minimax/speech-2.8-hd", itemIndex: null, status: "submitted", predictionId: "pred-old", output: {}, inlineCostUsd: 0 },
    ]);
    answers(["https://cdn/out.mp3"]);

    await runCatalogTask(deps, CTX, "tts", "hello", "minimax-speech-2.8-hd", { voice_id: "Wise_Woman" });

    expect((runPredictionMock.mock.calls[0]![3] as { storedTaskId: string }).storedTaskId).toBe("pred-old");
  });

  it("uploads the reference song and clones the vocal before the song, feeding their ids in", async () => {
    const { deps, clones } = stores();
    answers(
      [{ id: "u1", purpose: "reference", reference_id: "ref-1" }],
      [{ id: "v1", vocal_id: "voc-1" }],
      ["https://cdn/song.mp3"],
    );

    const result = await runCatalogTask(deps, CTX, "audio", "pop", "mureka-v9.5-generate-song", {
      lyrics: "la la",
      song: "https://a/song.mp3",
      vocal: "https://a/vocal.mp3",
    });

    expect(call(0)).toEqual({ endpoint: "mureka-ai/create-upload-id", body: { audio: "https://a/song.mp3", purpose: "reference" } });
    expect(call(1)).toEqual({ endpoint: "mureka-ai/vocal-clone", body: { audio: "https://a/vocal.mp3" } });
    expect(call(2).body).toMatchObject({ reference_id: "ref-1", vocal_id: "voc-1", lyrics: "la la", prompt: "pop" });
    expect(clones.get("vocal:sha-of-https://a/vocal.mp3")).toBe("voc-1");
    expect(result.cost).toBeCloseTo(0.03, 10);
  });

  it("reuses a cached vocal without cloning it again", async () => {
    const { deps, clones } = stores();
    clones.set("vocal:sha-of-https://a/vocal.mp3", "voc-cached");
    answers(["https://cdn/song.mp3"]);

    await runCatalogTask(deps, CTX, "audio", "pop", "mureka-v9.5-generate-song", {
      lyrics: "la la",
      vocal: "https://a/vocal.mp3",
    });

    expect(runPredictionMock).toHaveBeenCalledTimes(1);
    expect(call(0).body).toMatchObject({ vocal_id: "voc-cached" });
  });

  it("clones the voice without text, then speaks the prompt with it", async () => {
    const { deps, clones } = stores();
    answers([], ["https://cdn/speech.mp3"]);

    const [, params] = validateModelParams("tts", "minimax-voice-clone", { audio: "https://a/me.mp3" });
    const result = await runCatalogTask(deps, CTX, "tts", "read this", "minimax-voice-clone", params);

    const clone = call(0);
    expect(clone.endpoint).toBe("minimax/voice-clone");
    expect(clone.body).toMatchObject({ audio: "https://a/me.mp3", model: "speech-2.8-hd" });
    expect(clone.body).not.toHaveProperty("text");
    const voiceId = clone.body.custom_voice_id as string;
    expect(voiceId).toMatch(/^[A-Za-z][A-Za-z0-9]{7,}$/);
    expect(voiceId).toMatch(/\d/);
    expect(call(1)).toEqual({ endpoint: "minimax/speech-2.8-hd", body: { text: "read this", voice_id: voiceId } });
    expect(clones.get("voice:sha-of-https://a/me.mp3")).toBe(voiceId);
    expect(result.outputs).toEqual([{ url: "https://cdn/speech.mp3" }]);
  });

  it("skips the steps a previous delivery finished and uses what they answered", async () => {
    const { deps } = stores([
      { id: "s0", position: 0, kind: "voice", endpoint: "minimax/voice-clone", itemIndex: null, status: "done", predictionId: "pred-a", output: { voiceId: "Breatic0f5c", cached: false, prediction: "pred-a" }, inlineCostUsd: 0 },
      { id: "s1", position: 1, kind: "speak", endpoint: "minimax/speech-2.8-hd", itemIndex: null, status: "pending", predictionId: null, output: {}, inlineCostUsd: 0 },
    ]);
    answers(["https://cdn/speech.mp3"]);

    const result = await runCatalogTask(deps, CTX, "tts", "read this", "minimax-voice-clone", { audio: "https://a/me.mp3" });

    expect(runPredictionMock).toHaveBeenCalledTimes(1);
    expect(call(0).body).toEqual({ text: "read this", voice_id: "Breatic0f5c" });
    expect(queryBillingMock.mock.calls.map((c) => c[1])).toEqual(["pred-a", "pred-0"]);
    expect(result.cost).toBeCloseTo(0.02, 10);
  });

  it("marks a step failed when the upstream fails it, and not when the request itself fails", async () => {
    const failed = stores();
    runPredictionMock.mockRejectedValueOnce(new UpstreamTaskFailed("wavespeed", "bad input"));
    await expect(
      runCatalogTask(failed.deps, CTX, "tts", "hello", "minimax-speech-2.8-hd", { voice_id: "Wise_Woman" }),
    ).rejects.toThrow("wavespeed task failed: bad input");
    expect(failed.steps[0]!.status).toBe("failed");

    const refused = stores();
    runPredictionMock.mockRejectedValueOnce(new Error("socket hang up"));
    await expect(
      runCatalogTask(refused.deps, CTX, "tts", "hello", "minimax-speech-2.8-hd", { voice_id: "Wise_Woman" }),
    ).rejects.toThrow("socket hang up");
    expect(refused.steps[0]!.status).toBe("pending");
  });

  it("keeps the upstream's words on a step it failed", async () => {
    const { deps, steps } = stores();
    runPredictionMock.mockRejectedValueOnce(new UpstreamTaskFailed("wavespeed", "prompt refused"));

    await expect(
      runCatalogTask(deps, CTX, "tts", "hello", "minimax-speech-2.8-hd", { voice_id: "Wise_Woman" }),
    ).rejects.toThrow(UpstreamTaskFailed);
    expect(steps[0]).toMatchObject({ status: "failed", output: { error: "prompt refused" } });
  });

  it("answers a task whose step already failed with the upstream's own words", async () => {
    const { deps } = stores([
      { id: "s0", position: 0, kind: "generate", endpoint: "minimax/speech-2.8-hd", itemIndex: null, status: "failed", predictionId: "p", output: { error: "prompt refused" }, inlineCostUsd: 0 },
    ]);

    const run = runCatalogTask(deps, CTX, "tts", "hello", "minimax-speech-2.8-hd", { voice_id: "Wise_Woman" });
    await expect(run).rejects.toBeInstanceOf(UpstreamTaskFailed);
    await expect(run).rejects.toThrow("prompt refused");
    expect(runPredictionMock).not.toHaveBeenCalled();
  });

  it("resumes a submitted clone step by its own prediction, not the cache, and bills it", async () => {
    const { deps, clones } = stores([
      { id: "s0", position: 0, kind: "voice", endpoint: "minimax/voice-clone", itemIndex: null, status: "submitted", predictionId: "pred-clone", output: {}, inlineCostUsd: 0 },
      { id: "s1", position: 1, kind: "speak", endpoint: "minimax/speech-2.8-hd", itemIndex: null, status: "pending", predictionId: null, output: {}, inlineCostUsd: 0 },
    ]);
    clones.set("voice:sha-of-https://a/me.mp3", "BreaticOther");
    answers([], ["https://cdn/said.mp3"]);

    const result = await runCatalogTask(deps, CTX, "tts", "read this", "minimax-voice-clone", { audio: "https://a/me.mp3" });

    expect((runPredictionMock.mock.calls[0]![3] as { storedTaskId: unknown }).storedTaskId).toBe("pred-clone");
    expect(call(1).body).toMatchObject({ voice_id: `Breatic${CTX.taskId.replace(/-/g, "")}` });
    expect(result.cost).toBeCloseTo(0.02, 10);
  });

  it("forgets a cached voice the upstream no longer knows", async () => {
    const { deps, clones, retired } = stores();
    clones.set("voice:sha-of-https://a/me.mp3", "BreaticGone1");
    runPredictionMock.mockRejectedValueOnce(
      new UpstreamTaskFailed("wavespeed", "Voice ID does not exist. Please check if the voice_id parameter is correct."),
    );

    await expect(
      runCatalogTask(deps, CTX, "tts", "read this", "minimax-voice-clone", { audio: "https://a/me.mp3" }),
    ).rejects.toThrow(/Voice ID does not exist/);
    expect(retired).toEqual(["voice:BreaticGone1"]);
  });

  // The text Kling answered on 2026-09-29 for an element id it never issued.
  it("forgets a cached element the upstream no longer knows", async () => {
    const { deps, clones, retired } = stores();
    clones.set("element:sha-of-https://a/cat.png:Element 1", "el-gone");
    runPredictionMock.mockRejectedValueOnce(new UpstreamTaskFailed("wavespeed", "Element id not found: el-gone"));

    await expect(
      runCatalogTask(deps, CTX, "video", "Element 1 waves", "kling-video-o3-4k-image-to-video", {
        image: "https://a/first.png",
        elements: ["https://a/cat.png"],
        duration: 5,
      }),
    ).rejects.toThrow(/Element id not found/);
    expect(retired).toEqual(["element:el-gone"]);
  });

  it("forgets only the cached element the upstream names", async () => {
    const { deps, clones, retired } = stores();
    clones.set("element:sha-of-https://a/cat.png:Element 1", "el-kept");
    clones.set("element:sha-of-https://a/dog.png:Element 2", "el-gone");
    runPredictionMock.mockRejectedValueOnce(new UpstreamTaskFailed("wavespeed", "Element id not found: el-gone"));

    await expect(
      runCatalogTask(deps, CTX, "video", "Element 1 meets Element 2", "kling-video-o3-4k-image-to-video", {
        image: "https://a/first.png",
        elements: ["https://a/cat.png", "https://a/dog.png"],
        duration: 5,
      }),
    ).rejects.toThrow(/Element id not found/);
    expect(retired).toEqual(["element:el-gone"]);
  });

  // Mureka answers an unknown vocal id with the same words it uses for any
  // refused input, so a refusal says nothing about the cached vocal.
  it("keeps a cached vocal through Mureka's general refusal", async () => {
    const { deps, clones, retired } = stores();
    clones.set("vocal:sha-of-https://a/voice.mp3", "163346152292353");
    runPredictionMock.mockRejectedValueOnce(
      new UpstreamTaskFailed("wavespeed", "The provider rejected the request. Please check your inputs and try again."),
    );

    await expect(
      runCatalogTask(deps, CTX, "audio", "a song", "mureka-v9.5-generate-song", { vocal: "https://a/voice.mp3" }),
    ).rejects.toThrow(/provider rejected/);
    expect(call(0)).toMatchObject({ endpoint: "mureka-ai/mureka-v9.5/generate-song", body: { vocal_id: "163346152292353" } });
    expect(retired).toEqual([]);
  });

  it("makes one element per reference image, named by its place, and sends their ids with the video", async () => {
    const { deps, clones, steps } = stores();
    answers([{ element_id: "el-1" }], [{ element_id: "el-2" }], ["https://cdn/video.mp4"]);

    const result = await runCatalogTask(deps, CTX, "video", "Element 1 hands Element 2 a cup", "kling-video-o3-4k-image-to-video", {
      image: "https://a/first.png",
      elements: ["https://a/cat.png", "https://a/dog.png"],
      duration: 5,
    });

    expect(call(0)).toEqual({
      endpoint: "kwaivgi/kling-elements",
      body: {
        name: "Element 1",
        description: "a picture at https://a/cat.png",
        image: "https://a/cat.png",
        element_refer_list: ["https://a/cat.png"],
      },
    });
    expect(call(1).body).toMatchObject({ name: "Element 2", image: "https://a/dog.png" });
    expect(call(2).body).toMatchObject({ element_list: [{ element_id: "el-1" }, { element_id: "el-2" }] });
    expect(clones.get("element:sha-of-https://a/cat.png:Element 1")).toBe("el-1");
    expect(steps[0]!.output).toMatchObject({ description: "a picture at https://a/cat.png" });
    expect(result.cost).toBeCloseTo(0.03 + 0.004, 10);
  });

  it("reuses a cached element without describing or creating it again", async () => {
    const { deps, clones } = stores();
    clones.set("element:sha-of-https://a/cat.png:Element 1", "el-cached");
    const describe = vi.spyOn(deps, "describeImage");
    answers(["https://cdn/video.mp4"]);

    await runCatalogTask(deps, CTX, "video", "Element 1 waves", "kling-video-o3-4k-image-to-video", {
      image: "https://a/first.png",
      elements: ["https://a/cat.png"],
      duration: 5,
    });

    expect(describe).not.toHaveBeenCalled();
    expect(call(0).body).toMatchObject({ element_list: [{ element_id: "el-cached" }] });
  });

  it("bills nothing for a prediction that answered without an id", async () => {
    const { deps } = stores();
    runPredictionMock.mockResolvedValueOnce({ outputs: ["https://cdn/out.mp3"], taskId: "" });

    const result = await runCatalogTask(deps, CTX, "tts", "hello", "minimax-speech-2.8-hd", { voice_id: "Wise_Woman" });

    expect(queryBillingMock).not.toHaveBeenCalled();
    expect(result.cost).toBe(0);
  });

  it("fails a run whose last step answered no output", async () => {
    const { deps } = stores();
    answers([]);

    await expect(
      runCatalogTask(deps, CTX, "tts", "hello", "minimax-speech-2.8-hd", { voice_id: "Wise_Woman" }),
    ).rejects.toThrow("No output URL after WaveSpeed polling");
  });
});

describe("runCatalogTask outputs", () => {
  it("keeps every upstream output up to the count asked for, in upstream order", async () => {
    const { deps, steps } = stores();
    answers(["https://cdn/vocals.mp3", "https://cdn/backing.mp3"]);

    const result = await runCatalogTask(deps, CTX, "audio", "", "vocal-remover", { audio: "https://a/song.mp3" }, 2);

    expect(result.outputs).toEqual([{ url: "https://cdn/vocals.mp3" }, { url: "https://cdn/backing.mp3" }]);
    expect(steps[0]!.output.urls).toEqual(["https://cdn/vocals.mp3", "https://cdn/backing.mp3"]);
  });

  it("hands on only the first output when one is asked for", async () => {
    const { deps } = stores();
    answers(["https://cdn/vocals.mp3", "https://cdn/backing.mp3"]);

    const result = await runCatalogTask(deps, CTX, "audio", "", "vocal-remover", { audio: "https://a/song.mp3" }, 1);

    expect(result.outputs).toEqual([{ url: "https://cdn/vocals.mp3" }]);
  });

  it("answers both outputs again when it resumes after the generate step finished", async () => {
    const { deps } = stores([
      { id: "s0", position: 0, kind: "generate", endpoint: "wavespeed-ai/audio-vocal-isolator", itemIndex: null, status: "done", predictionId: "pred-a", output: { urls: ["https://cdn/v.mp3", "https://cdn/b.mp3"], prediction: "pred-a" }, inlineCostUsd: 0 },
    ]);

    const result = await runCatalogTask(deps, CTX, "audio", "", "vocal-remover", { audio: "https://a/song.mp3" }, 2);

    expect(runPredictionMock).not.toHaveBeenCalled();
    expect(result.outputs).toEqual([{ url: "https://cdn/v.mp3" }, { url: "https://cdn/b.mp3" }]);
  });

  it("reads a step finished before outputs were stored as a list as one output", async () => {
    const { deps } = stores([
      { id: "s0", position: 0, kind: "generate", endpoint: "minimax/speech-2.8-hd", itemIndex: null, status: "done", predictionId: "pred-a", output: { url: "https://cdn/old.mp3", prediction: "pred-a" }, inlineCostUsd: 0 },
    ]);

    const result = await runCatalogTask(deps, CTX, "tts", "hello", "minimax-speech-2.8-hd", { voice_id: "Wise_Woman" }, 1);

    expect(result.outputs).toEqual([{ url: "https://cdn/old.mp3" }]);
  });
});

