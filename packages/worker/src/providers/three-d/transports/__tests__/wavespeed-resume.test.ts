// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, it, expect, vi, beforeEach } from "vitest";
import type * as httpModule from "@worker/providers/http.js";

import type { ResolvedModel } from "@worker/providers/shared.js";

/**
 * #1628 (#1625 ⑦) — three-d wavespeed transport resume wiring (Tier B).
 *
 * Submit must be at-most-once across BullMQ retries: with a stored vendor
 * task id the transport must SKIP the submit POST and resume polling; on a
 * fresh run it must persist the returned task id before polling. WaveSpeed
 * has no client-side idempotency field, so the submit body carries only the
 * generation params (Tier B: persist the server-returned id, nothing more).
 */
const requestWithRetryMock = vi.fn();
const pollOnceMock = vi.fn();
const queryBillingMock = vi.fn();

vi.mock("@worker/providers/http.js", async (importOriginal) => {
  const actual = await importOriginal<typeof httpModule>();
  return {
    ...actual,
    requestWithRetry: (...args: unknown[]) => requestWithRetryMock(...args),
    pollOnce: (...args: unknown[]) => pollOnceMock(...args),
    queryBilling: (...args: unknown[]) => queryBillingMock(...args),
  };
});

import { generate } from "@worker/providers/three-d/transports/wavespeed.js";
import { StillRunning, TaskDeadlinePassed } from "@worker/providers/still-running.js";

/** A deadline no case here reaches unless it says so. */
const LATER = Number.MAX_SAFE_INTEGER;

const RESOLVED: ResolvedModel = {
  modelName: "meshy-6",
  modelId: "meshy/meshy-6",
  providerName: "wavespeed",
  baseUrl: "https://api.wavespeed.test/v3",
  apiKey: "ws-key",
  timeout: 60,
  maxConcurrency: 5,
};

const COMPLETED_RESULT = {
  data: {
    status: "completed",
    outputs: ["https://cdn.wavespeed.test/model.glb"],
  },
};

describe("three-d wavespeed transport resume (#1628 ⑦)", () => {
  beforeEach(() => {
    requestWithRetryMock.mockReset();
    pollOnceMock.mockReset();
    queryBillingMock.mockReset();
    pollOnceMock.mockResolvedValue(COMPLETED_RESULT);
    queryBillingMock.mockResolvedValue(0.42);
  });

  it("fresh run: submits without any client id, persists the vendor id, then polls", async () => {
    requestWithRetryMock.mockResolvedValue({ data: { id: "ws-777" } });
    const persistTaskId = vi.fn(async () => {});

    const r = await generate("a chair", RESOLVED, { quality: "high" }, {
      storedTaskId: null,
      persistTaskId,
      externalTaskId: "breatic-task-abc",
    }, LATER);

    expect(requestWithRetryMock).toHaveBeenCalledTimes(1);
    const submitBody = JSON.parse(
      (requestWithRetryMock.mock.calls[0]![1] as { body: string }).body,
    ) as Record<string, unknown>;
    expect(submitBody).toEqual({ quality: "high", prompt: "a chair" }); // Tier B: no client id field
    expect(persistTaskId).toHaveBeenCalledWith("ws-777");
    expect(String(pollOnceMock.mock.calls[0]![0])).toContain("ws-777");
    expect(queryBillingMock).toHaveBeenCalledWith(RESOLVED, "ws-777");
    expect(r.url).toBe("https://cdn.wavespeed.test/model.glb");
  });

  it("INVARIANT — stored id present: NO submit POST, resumes polling the stored id", async () => {
    const persistTaskId = vi.fn(async () => {});

    const r = await generate("a chair", RESOLVED, {}, {
      storedTaskId: "ws-stored-42",
      persistTaskId,
      externalTaskId: "breatic-task-abc",
    }, LATER);

    expect(requestWithRetryMock).toHaveBeenCalledTimes(0); // ⑦ core: no duplicate generation
    expect(persistTaskId).toHaveBeenCalledTimes(0);
    expect(String(pollOnceMock.mock.calls[0]![0])).toContain("ws-stored-42");
    expect(queryBillingMock).toHaveBeenCalledWith(RESOLVED, "ws-stored-42");
    expect(r.url).toBe("https://cdn.wavespeed.test/model.glb");
  });

  describe("against the task's two-hour deadline (inner#1337)", () => {
    it("submits nothing once the deadline has passed", async () => {
      const persistTaskId = vi.fn(async () => {});

      await expect(
        generate("a chair", RESOLVED, {}, { storedTaskId: null, persistTaskId, externalTaskId: "x" }, Date.now() - 1),
      ).rejects.toBeInstanceOf(TaskDeadlinePassed);
      expect(requestWithRetryMock).not.toHaveBeenCalled();
    });

    it("goes back to the queue while the upstream is still going before the deadline", async () => {
      pollOnceMock.mockRejectedValue(new StillRunning(123));

      const err = await generate(
        "a chair",
        RESOLVED,
        {},
        { storedTaskId: "ws-stored-42", persistTaskId: vi.fn(), externalTaskId: "x" },
        LATER,
      ).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(StillRunning);
      expect(queryBillingMock).not.toHaveBeenCalled();
    });

    it("hands a still-going answer up as it is at the deadline, for dispatch to judge", async () => {
      pollOnceMock.mockRejectedValue(new StillRunning(123));

      await expect(
        generate(
          "a chair",
          RESOLVED,
          {},
          { storedTaskId: "ws-stored-42", persistTaskId: vi.fn(), externalTaskId: "x" },
          Date.now() - 1,
        ),
      ).rejects.toBeInstanceOf(StillRunning);
    });
  });
});
