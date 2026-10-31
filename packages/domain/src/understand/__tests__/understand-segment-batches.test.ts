// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { beforeEach, describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import {
  LongMediaBatchFailureError,
  understandMediaInBatches,
} from "@domain/understand/understand-segment-batches.js";

const understandMediaAtMock = vi.fn();
vi.mock("@domain/understand/understand-at.js", () => ({
  understandMediaAt: (...args: unknown[]) => understandMediaAtMock(...args),
}));

const request = {
  question: "Describe the recording.",
  maxBytes: 5,
  fetchTimeoutMs: 30_000,
  minBytesPerSec: 65_536,
  readFloorMs: 5_000,
  timeoutMs: 180_000,
  model: "google/gemini-3.8-flash",
  backend: "google-vertex",
  apiKey: "unit-test-key",
  baseUrl: "https://openrouter.ai/api/v1",
  maxOutputTokens: 2048,
  maxItems: 2,
  onBilled: vi.fn(),
};

const segments = [
  { url: "https://media.example/0.mp3", ledgerType: "audio/mpeg", sizeBytes: 3, startUs: "-500000", endUs: "300000000" },
  { url: "https://media.example/1.mp3", ledgerType: "audio/mpeg", sizeBytes: 2, startUs: "300000000", endUs: "600000000" },
  { url: "https://media.example/2.mp3", ledgerType: "audio/mpeg", sizeBytes: 2, startUs: "600000000", endUs: "900000000" },
  { url: "https://media.example/3.mp3", ledgerType: "audio/mpeg", sizeBytes: 1, startUs: "900000000", endUs: "1200000000" },
];

beforeEach(() => {
  understandMediaAtMock.mockReset();
});

describe("understandMediaInBatches", () => {
  it("understands several consecutive segments in each API call and returns batch results in order", async () => {
    understandMediaAtMock
      .mockResolvedValueOnce({ text: "First interval.", finishReason: "stop", kind: "audio", kinds: ["audio", "audio"] })
      .mockResolvedValueOnce({ text: "Second interval.", finishReason: "stop", kind: "audio", kinds: ["audio", "audio"] });

    const answer = await understandMediaInBatches(request, segments);

    expect(understandMediaAtMock).toHaveBeenCalledTimes(2);
    expect(understandMediaAtMock).toHaveBeenNthCalledWith(1, expect.objectContaining({
      maxBytes: 5,
      items: segments.slice(0, 2).map(({ url, ledgerType }) => ({ url, ledgerType })),
      question: expect.stringContaining("item 1: [-00:00:00.500000, 00:05:00.000000); item 2: [00:05:00.000000, 00:10:00.000000)"),
    }));
    expect(understandMediaAtMock).toHaveBeenNthCalledWith(2, expect.objectContaining({
      maxBytes: 5,
      items: segments.slice(2).map(({ url, ledgerType }) => ({ url, ledgerType })),
      question: expect.stringContaining("item 1: [00:10:00.000000, 00:15:00.000000); item 2: [00:15:00.000000, 00:20:00.000000)"),
    }));
    expect(answer).toEqual({
      text: "Original source interval: [-00:00:00.500000, 00:10:00.000000).\nFirst interval.\n\n" +
        "Original source interval: [00:10:00.000000, 00:20:00.000000).\nSecond interval.",
      finishReason: "stop",
      kind: "audio",
      kinds: ["audio", "audio", "audio", "audio"],
    });
  });

  it("stops after the first failed batch and propagates its failure", async () => {
    const failure = new Error("The second batch was refused.");
    understandMediaAtMock.mockResolvedValueOnce({
      text: "First interval.", finishReason: "stop", kind: "audio", kinds: ["audio", "audio"],
    }).mockRejectedValueOnce(failure);

    const thrown = await understandMediaInBatches(request, segments).then(() => null, (err: unknown) => err);
    if (!(thrown instanceof LongMediaBatchFailureError)) throw new Error("The batch failure lost its interval state.");
    expect(thrown.completedIntervals).toEqual([{ startUs: "-500000", endUs: "600000000" }]);
    expect(thrown.failedInterval).toEqual({ startUs: "600000000", endUs: "1200000000" });
    expect(thrown.cause).toBe(failure);
    expect(thrown.message).toContain("Completed intervals: [-00:00:00.500000, 00:10:00.000000)");
    expect(thrown.message).toContain("Failed interval: [00:10:00.000000, 00:20:00.000000)");
    expect(thrown.message).not.toContain("First interval.");
    expect(understandMediaAtMock).toHaveBeenCalledTimes(2);
  });

  it("reuses persisted answers but does not retry an unknown later batch", async () => {
    const states = new Map<string, {
      kind: "sending" | "unknown" | "ready";
      answer?: { text: string; kind: "audio"; kinds: Array<"audio"> };
    }>();
    const checkpoint = {
      begin: vi.fn(async (key: string) => {
        const current = states.get(key);
        if (current?.kind === "ready") return { kind: "ready" as const, answer: current.answer! };
        if (current?.kind === "unknown") return { kind: "unknown" as const };
        if (current?.kind === "sending") {
          states.set(key, { kind: "unknown" });
          return { kind: "unknown" as const };
        }
        states.set(key, { kind: "sending" });
        return { kind: "prepared" as const, attemptId: key };
      }),
      markSending: vi.fn(async () => undefined),
      saveAttempt: vi.fn(async (key: string, _inputDigest: string, _attemptId: string, answer: { text: string; kind: "audio"; kinds: Array<"audio"> }) => {
        states.set(key, { kind: "ready", answer });
      }),
      markUnknown: vi.fn(async (key: string) => {
        states.set(key, { kind: "unknown" });
      }),
    };
    understandMediaAtMock.mockResolvedValueOnce({
      text: "First interval.", finishReason: "stop", kind: "audio", kinds: ["audio", "audio"],
    }).mockRejectedValueOnce(new Error("The second batch was refused."));

    await expect(understandMediaInBatches({ ...request, checkpoint }, segments)).rejects.toThrow();
    understandMediaAtMock.mockClear();
    await expect(understandMediaInBatches({ ...request, checkpoint }, segments)).rejects.toMatchObject({
      completedIntervals: [{ startUs: "-500000", endUs: "600000000" }],
      failedInterval: { startUs: "600000000", endUs: "1200000000" },
    });

    expect(understandMediaAtMock).not.toHaveBeenCalled();
  });

  it("does not resend a batch when its prior model response was not durably saved", async () => {
    let attemptState: "pending" | "sending" | "unknown" = "pending";
    const checkpoint = {
      begin: vi.fn(async () => {
        if (attemptState === "pending") {
          attemptState = "sending";
          return { kind: "prepared" as const, attemptId: "attempt-1" };
        }
        if (attemptState === "sending") {
          attemptState = "unknown";
          return { kind: "unknown" as const };
        }
        return { kind: "unknown" as const };
      }),
      markSending: vi.fn(async () => undefined),
      saveAttempt: vi.fn(async () => {
        throw new Error("The answer checkpoint could not be committed.");
      }),
      markUnknown: vi.fn(async () => {
        attemptState = "unknown";
      }),
    };
    understandMediaAtMock.mockResolvedValueOnce({
      text: "The model answered before persistence failed.",
      finishReason: "stop",
      kind: "audio",
      kinds: ["audio", "audio"],
    });

    await expect(understandMediaInBatches({ ...request, checkpoint }, segments))
      .rejects.toMatchObject({ failedInterval: { startUs: "-500000", endUs: "600000000" } });
    await expect(understandMediaInBatches({ ...request, checkpoint }, segments))
      .rejects.toMatchObject({ failedInterval: { startUs: "-500000", endUs: "600000000" } });

    expect(checkpoint.begin).toHaveBeenCalledTimes(2);
    expect(understandMediaAtMock).toHaveBeenCalledTimes(1);
  });

  it("never resends an unknown batch across repeated retries", async () => {
    await fc.assert(fc.asyncProperty(fc.integer({ min: 1, max: 8 }), async (retryCount) => {
      understandMediaAtMock.mockReset().mockResolvedValueOnce({
        text: "The model answered before persistence failed.",
        finishReason: "stop",
        kind: "audio",
        kinds: ["audio", "audio"],
      });
      let state: "pending" | "sending" | "unknown" = "pending";
      const checkpoint = {
        begin: vi.fn(async () => {
          if (state === "pending") {
            state = "sending";
            return { kind: "prepared" as const, attemptId: "attempt-1" };
          }
          return { kind: "unknown" as const };
        }),
        markSending: vi.fn(async () => undefined),
        saveAttempt: vi.fn(async () => {
          throw new Error("The answer checkpoint could not be committed.");
        }),
        markUnknown: vi.fn(async () => {
          state = "unknown";
        }),
      };

      await expect(understandMediaInBatches({ ...request, checkpoint }, segments)).rejects.toThrow();
      for (let retry = 0; retry < retryCount; retry += 1) {
        await expect(understandMediaInBatches({ ...request, checkpoint }, segments)).rejects.toMatchObject({
          failedInterval: { startUs: "-500000", endUs: "600000000" },
        });
      }

      expect(understandMediaAtMock).toHaveBeenCalledTimes(1);
    }), { numRuns: 20 });
  });

  it("does not return partial text when a required batch stops before completion", async () => {
    understandMediaAtMock
      .mockResolvedValueOnce({ text: "First interval.", finishReason: "stop", kind: "audio", kinds: ["audio", "audio"] })
      .mockResolvedValueOnce({ text: "Second interval is partial.", finishReason: "length", kind: "audio", kinds: ["audio", "audio"] });

    await expect(understandMediaInBatches(request, segments)).rejects.toMatchObject({
      completedIntervals: [{ startUs: "-500000", endUs: "600000000" }],
      failedInterval: { startUs: "600000000", endUs: "1200000000" },
      cause: expect.objectContaining({ message: "Long-media batch stopped before completion (length)." }),
    });

    expect(understandMediaAtMock).toHaveBeenCalledTimes(2);
  });

  it("rejects an empty segment list before calling the model", async () => {
    await expect(understandMediaInBatches(request, [])).rejects.toThrow(RangeError);
    expect(understandMediaAtMock).not.toHaveBeenCalled();
  });
});
