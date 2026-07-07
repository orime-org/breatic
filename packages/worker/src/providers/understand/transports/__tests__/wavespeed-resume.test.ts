// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect, vi, beforeEach } from "vitest";
import type * as httpModule from "@worker/providers/http.js";

import type { ResolvedModel } from "@worker/providers/shared.js";
import type { AnyUnderstandFamily } from "@worker/providers/understand/models/types.js";

/**
 * #1628 (#1625 ⑦) — understand/wavespeed (ASR) transport resume wiring.
 *
 * Submit must be at-most-once across BullMQ retries: with a stored vendor
 * task id the transport must SKIP the submit POST and resume polling; on a
 * fresh run it must persist the server-returned task id before polling.
 * WaveSpeed is Tier B: no client-side idempotency field is added to the
 * submit body — only the server-returned id is persisted.
 */
const requestWithRetryMock = vi.fn();
const pollUntilDoneMock = vi.fn();
const queryBillingMock = vi.fn();

vi.mock("@worker/providers/http.js", async (importOriginal) => {
  const actual = await importOriginal<typeof httpModule>();
  return {
    ...actual,
    requestWithRetry: (...args: unknown[]) => requestWithRetryMock(...args),
    pollUntilDone: (...args: unknown[]) => pollUntilDoneMock(...args),
    queryBilling: (...args: unknown[]) => queryBillingMock(...args),
  };
});

import { generate } from "@worker/providers/understand/transports/wavespeed.js";

const RESOLVED: ResolvedModel = {
  modelName: "whisper-large-v3",
  modelId: "wavespeed-ai/whisper-large-v3",
  providerName: "wavespeed",
  baseUrl: "https://api.wavespeed.test/v3",
  apiKey: "ws-key",
  timeout: 60,
  maxConcurrency: 5,
  costPerCall: 0,
  extraParams: {},
};

const FAMILY: AnyUnderstandFamily = {
  MODELS: new Set(["whisper-large-v3"]),
  buildRequest: async (): Promise<[string, Record<string, unknown>]> => [
    "",
    { audio: "https://cdn.test/a.mp3" },
  ],
};

const COMPLETED_RESULT = {
  code: 0,
  data: { status: "completed", outputs: "hello transcript" },
};

describe("understand wavespeed transport resume (#1628 ⑦)", () => {
  beforeEach(() => {
    requestWithRetryMock.mockReset();
    pollUntilDoneMock.mockReset();
    queryBillingMock.mockReset();
    pollUntilDoneMock.mockResolvedValue(COMPLETED_RESULT);
    queryBillingMock.mockResolvedValue(0.42);
  });

  it("fresh run: submits without any client id field, persists the vendor id, then polls", async () => {
    requestWithRetryMock.mockResolvedValue({ code: 0, data: { id: "ws-777" } });
    const persistTaskId = vi.fn(async () => {});

    const r = await generate(RESOLVED, FAMILY, "transcribe this", {}, {
      storedTaskId: null,
      persistTaskId,
      externalTaskId: "breatic-task-abc",
    });

    expect(requestWithRetryMock).toHaveBeenCalledTimes(1);
    const submitBody = JSON.parse(
      (requestWithRetryMock.mock.calls[0]![1] as { body: string }).body,
    ) as Record<string, unknown>;
    expect(submitBody).toEqual({ audio: "https://cdn.test/a.mp3" }); // Tier B: no client id injected
    expect(persistTaskId).toHaveBeenCalledWith("ws-777");
    expect(String(pollUntilDoneMock.mock.calls[0]![0])).toContain("ws-777");
    expect(r.text).toBe("hello transcript");
    expect(r.cost).toBe(0.42);
  });

  it("INVARIANT — stored id present: NO submit POST, resumes polling the stored id", async () => {
    const persistTaskId = vi.fn(async () => {});

    const r = await generate(RESOLVED, FAMILY, "transcribe this", {}, {
      storedTaskId: "ws-stored-42",
      persistTaskId,
      externalTaskId: "breatic-task-abc",
    });

    expect(requestWithRetryMock).toHaveBeenCalledTimes(0); // ⑦ core: no duplicate generation
    expect(persistTaskId).toHaveBeenCalledTimes(0);
    expect(String(pollUntilDoneMock.mock.calls[0]![0])).toContain("ws-stored-42");
    expect(r.text).toBe("hello transcript");
  });

  it("no resume ctx (legacy caller): submits and polls as before", async () => {
    requestWithRetryMock.mockResolvedValue({ code: 0, data: { id: "ws-999" } });

    const r = await generate(RESOLVED, FAMILY, "transcribe this", {});

    expect(requestWithRetryMock).toHaveBeenCalledTimes(1);
    expect(String(pollUntilDoneMock.mock.calls[0]![0])).toContain("ws-999");
    expect(r.text).toBe("hello transcript");
  });

  it("inline answer: no polling round, vendor id still persisted for post-provider retries", async () => {
    requestWithRetryMock.mockResolvedValue({
      code: 0,
      data: { id: "ws-inline-1", outputs: "inline transcript" },
    });
    const persistTaskId = vi.fn(async () => {});

    const r = await generate(RESOLVED, FAMILY, "transcribe this", {}, {
      storedTaskId: null,
      persistTaskId,
      externalTaskId: "breatic-task-abc",
    });

    expect(pollUntilDoneMock).toHaveBeenCalledTimes(0); // inline answer short-circuits poll
    expect(persistTaskId).toHaveBeenCalledWith("ws-inline-1");
    expect(r.text).toBe("inline transcript");
    expect(r.cost).toBe(0.42);
  });

  it("inline answer without a vendor id: returns the result and persists nothing", async () => {
    requestWithRetryMock.mockResolvedValue({
      code: 0,
      data: { outputs: "inline transcript" },
    });
    const persistTaskId = vi.fn(async () => {});

    const r = await generate(RESOLVED, FAMILY, "transcribe this", {}, {
      storedTaskId: null,
      persistTaskId,
      externalTaskId: "breatic-task-abc",
    });

    expect(pollUntilDoneMock).toHaveBeenCalledTimes(0);
    expect(persistTaskId).toHaveBeenCalledTimes(0); // no id → nothing to resume by
    expect(r.text).toBe("inline transcript");
    expect(r.cost).toBe(0); // no id → no billing query
  });
});
