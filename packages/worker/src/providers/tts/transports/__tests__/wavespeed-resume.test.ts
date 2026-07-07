// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect, vi, beforeEach } from "vitest";
import type * as httpModule from "@worker/providers/http.js";

import type { ResolvedModel } from "@worker/providers/shared.js";

/**
 * #1628 (#1625 ⑦) — tts wavespeed transport resume wiring (Tier B).
 *
 * Submit must be at-most-once across BullMQ retries: with a stored vendor
 * task id the transport must SKIP the submit POST and resume polling; on a
 * fresh run it must persist the returned task id before polling. Tier B:
 * WaveSpeed has no client-side idempotency field, so the submit body must
 * stay exactly the params (no injected client id).
 */
const requestWithRetryMock = vi.fn();
const pollUntilDoneMock = vi.fn();

vi.mock("@worker/providers/http.js", async (importOriginal) => {
  const actual = await importOriginal<typeof httpModule>();
  return {
    ...actual,
    requestWithRetry: (...args: unknown[]) => requestWithRetryMock(...args),
    pollUntilDone: (...args: unknown[]) => pollUntilDoneMock(...args),
  };
});

import { generate } from "@worker/providers/tts/transports/wavespeed.js";

const RESOLVED: ResolvedModel = {
  modelName: "elevenlabs-v3-wavespeed",
  modelId: "elevenlabs/eleven-v3",
  providerName: "wavespeed",
  baseUrl: "https://api.wavespeed.test/v3",
  apiKey: "ws-key",
  timeout: 60,
  maxConcurrency: 5,
  costPerCall: 0,
  extraParams: {},
  litellmModel: undefined,
  tokenPrice: undefined,
  creditPrice: undefined,
} as unknown as ResolvedModel;

const COMPLETED_RESULT = {
  data: {
    status: "completed",
    outputs: ["https://cdn.wavespeed.test/a.mp3"],
  },
};

describe("tts wavespeed transport resume (#1628 ⑦)", () => {
  beforeEach(() => {
    requestWithRetryMock.mockReset();
    pollUntilDoneMock.mockReset();
    pollUntilDoneMock.mockResolvedValue(COMPLETED_RESULT);
  });

  it("fresh run: submits without any client id, persists the vendor id, then polls", async () => {
    requestWithRetryMock.mockResolvedValue({ data: { id: "ws-777" } });
    const persistTaskId = vi.fn(async () => {});

    const r = await generate("hello", RESOLVED, { text: "hello" }, {
      storedTaskId: null,
      persistTaskId,
      externalTaskId: "breatic-task-abc",
    });

    expect(requestWithRetryMock).toHaveBeenCalledTimes(1);
    const submitBody = JSON.parse(
      (requestWithRetryMock.mock.calls[0]![1] as { body: string }).body,
    ) as Record<string, unknown>;
    expect(submitBody).toEqual({ text: "hello" }); // Tier B: no client id injected
    expect(persistTaskId).toHaveBeenCalledWith("ws-777");
    expect(String(pollUntilDoneMock.mock.calls[0]![0])).toContain("ws-777");
    expect(r.url).toBe("https://cdn.wavespeed.test/a.mp3");
  });

  it("INVARIANT — stored id present: NO submit POST, resumes polling the stored id", async () => {
    const persistTaskId = vi.fn(async () => {});

    const r = await generate("hello", RESOLVED, { text: "hello" }, {
      storedTaskId: "ws-stored-42",
      persistTaskId,
      externalTaskId: "breatic-task-abc",
    });

    expect(requestWithRetryMock).toHaveBeenCalledTimes(0); // ⑦ core: no duplicate generation
    expect(persistTaskId).toHaveBeenCalledTimes(0);
    expect(String(pollUntilDoneMock.mock.calls[0]![0])).toContain("ws-stored-42");
    expect(r.url).toBe("https://cdn.wavespeed.test/a.mp3");
  });

  it("no resume ctx (legacy caller): submits and polls as before", async () => {
    requestWithRetryMock.mockResolvedValue({ data: { id: "ws-999" } });

    const r = await generate("hello", RESOLVED, { text: "hello" });

    expect(requestWithRetryMock).toHaveBeenCalledTimes(1);
    const submitBody = JSON.parse(
      (requestWithRetryMock.mock.calls[0]![1] as { body: string }).body,
    ) as Record<string, unknown>;
    expect(submitBody).toEqual({ text: "hello" });
    expect(String(pollUntilDoneMock.mock.calls[0]![0])).toContain("ws-999");
    expect(r.url).toBe("https://cdn.wavespeed.test/a.mp3");
  });

  it("sync submit response (outputs inline): no poll HTTP call, id still persisted", async () => {
    requestWithRetryMock.mockResolvedValue({
      data: { id: "ws-sync-1", outputs: ["https://cdn.wavespeed.test/sync.mp3"] },
    });
    const persistTaskId = vi.fn(async () => {});

    const r = await generate("hello", RESOLVED, { text: "hello" }, {
      storedTaskId: null,
      persistTaskId,
      externalTaskId: "breatic-task-abc",
    });

    expect(requestWithRetryMock).toHaveBeenCalledTimes(1);
    expect(pollUntilDoneMock).toHaveBeenCalledTimes(0); // sync short-circuit preserved
    expect(persistTaskId).toHaveBeenCalledWith("ws-sync-1");
    expect(r.url).toBe("https://cdn.wavespeed.test/sync.mp3");
  });
});
