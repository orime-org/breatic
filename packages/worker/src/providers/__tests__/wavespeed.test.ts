// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * One WaveSpeed prediction, the one upstream every model runs on (#2156):
 * submitted once across BullMQ retries (#1628), resumed by the stored id,
 * and answered from the submit response when that already carries outputs.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type * as httpModule from "@worker/providers/http.js";

const requestWithRetryMock = vi.fn();
const pollOnceMock = vi.fn();

vi.mock("@worker/providers/http.js", async (importOriginal) => {
  const actual = await importOriginal<typeof httpModule>();
  return {
    ...actual,
    requestWithRetry: (...args: unknown[]) => requestWithRetryMock(...args),
    pollOnce: (...args: unknown[]) => pollOnceMock(...args),
  };
});

import { runPrediction, type WavespeedEndpoint } from "@worker/providers/wavespeed.js";
import { StillRunning } from "@worker/providers/still-running.js";

/** A run with nothing submitted yet, whose id goes nowhere. */
const FRESH = { storedTaskId: null, persistTaskId: async (): Promise<void> => {}, externalTaskId: "t-0" };

const ENDPOINT: WavespeedEndpoint = {
  baseUrl: "https://api.wavespeed.test/v3",
  apiKey: "ws-key",
  timeout: 60,
};

const COMPLETED = { data: { status: "completed", outputs: ["https://cdn.test/out.mp4"] } };

/**
 * The JSON body of the n-th submit call.
 * @param n - Call index.
 * @returns The parsed body.
 */
function submittedBody(n = 0): Record<string, unknown> {
  return JSON.parse((requestWithRetryMock.mock.calls[n]![1] as { body: string }).body) as Record<
    string,
    unknown
  >;
}

describe("runPrediction", () => {
  beforeEach(() => {
    requestWithRetryMock.mockReset();
    pollOnceMock.mockReset();
    pollOnceMock.mockResolvedValue(COMPLETED);
  });

  it("posts the body verbatim to the model's endpoint, stores the id, then polls it", async () => {
    requestWithRetryMock.mockResolvedValue({ data: { id: "ws-1" } });
    const persistTaskId = vi.fn(async (): Promise<void> => {});

    const run = await runPrediction(ENDPOINT, "vendor/model/t2v", { text: "hi", duration: 5 }, {
      storedTaskId: null,
      persistTaskId,
      externalTaskId: "t-1",
    });

    expect(requestWithRetryMock.mock.calls[0]![0]).toBe("https://api.wavespeed.test/v3/vendor/model/t2v");
    expect(submittedBody()).toEqual({ text: "hi", duration: 5 });
    expect(persistTaskId).toHaveBeenCalledWith("ws-1");
    expect(pollOnceMock.mock.calls[0]![0]).toBe(
      "https://api.wavespeed.test/v3/predictions/ws-1/result",
    );
    expect(run).toEqual({ outputs: ["https://cdn.test/out.mp4"], taskId: "ws-1" });
  });

  it("does not submit again when a retry carries the stored id", async () => {
    const run = await runPrediction(ENDPOINT, "vendor/model/t2v", { text: "hi" }, {
      storedTaskId: "ws-9",
      persistTaskId: vi.fn(async (): Promise<void> => {}),
      externalTaskId: "t-1",
    });

    expect(requestWithRetryMock).not.toHaveBeenCalled();
    expect(pollOnceMock.mock.calls[0]![0]).toBe(
      "https://api.wavespeed.test/v3/predictions/ws-9/result",
    );
    expect(run.taskId).toBe("ws-9");
  });

  it("answers from the submit response when it already carries outputs", async () => {
    requestWithRetryMock.mockResolvedValue({
      data: { id: "ws-2", outputs: ["https://cdn.test/sync.png"] },
    });

    const run = await runPrediction(ENDPOINT, "vendor/model/t2i", {}, FRESH);

    expect(pollOnceMock).not.toHaveBeenCalled();
    expect(run).toEqual({ outputs: ["https://cdn.test/sync.png"], taskId: "ws-2" });
  });

  it("stores nothing for a sync answer that carries no id, and reports no id to bill", async () => {
    requestWithRetryMock.mockResolvedValue({ data: { outputs: ["https://cdn.test/sync.png"] } });
    const persistTaskId = vi.fn(async (): Promise<void> => {});

    const run = await runPrediction(ENDPOINT, "vendor/model/t2i", {}, {
      storedTaskId: null,
      persistTaskId,
      externalTaskId: "t-1",
    });

    expect(persistTaskId).not.toHaveBeenCalled();
    expect(run.taskId).toBe("");
  });

  it("fails when the submit response carries neither an id nor outputs", async () => {
    requestWithRetryMock.mockResolvedValue({ data: {} });

    await expect(runPrediction(ENDPOINT, "vendor/model/t2i", {}, FRESH)).rejects.toThrow(
      "No task ID or outputs in WaveSpeed response",
    );
  });

  it("keeps the new id and hands up a still-going answer from the first question", async () => {
    requestWithRetryMock.mockResolvedValue({ data: { id: "ws-3" } });
    pollOnceMock.mockRejectedValue(new StillRunning(123));
    const persistTaskId = vi.fn(async (): Promise<void> => {});

    await expect(
      runPrediction(ENDPOINT, "vendor/model/t2v", {}, { storedTaskId: null, persistTaskId, externalTaskId: "t-3" }),
    ).rejects.toBeInstanceOf(StillRunning);
    expect(persistTaskId).toHaveBeenCalledWith("ws-3");
  });
});
