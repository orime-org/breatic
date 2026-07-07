// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect, vi, beforeEach } from "vitest";
import type * as httpModule from "@worker/providers/http.js";

import type { ResolvedModel } from "@worker/providers/shared.js";

/**
 * #1628 (#1625 ⑦) — tts fal transport resume wiring (Tier B).
 *
 * Submit must be at-most-once across BullMQ retries: with a stored vendor
 * request id the transport must SKIP the submit POST and resume polling by
 * the documented default queue URLs derived from the stored id; on a fresh
 * run it must persist the returned request id before polling. Tier B: fal
 * has no client-side idempotency field, so the submit body must stay exactly
 * the mapped F5 input (no injected client id).
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

import { generate } from "@worker/providers/tts/transports/fal.js";

const RESOLVED: ResolvedModel = {
  modelName: "f5-tts",
  modelId: "fal-ai/f5-tts",
  providerName: "fal",
  baseUrl: "https://queue.fal.test",
  apiKey: "fal-key",
  timeout: 60,
  maxConcurrency: 5,
  costPerCall: 0,
  extraParams: {},
  litellmModel: undefined,
  tokenPrice: undefined,
  creditPrice: undefined,
} as unknown as ResolvedModel;

const SUBMIT_RESPONSE = {
  request_id: "fal-777",
  status_url: "https://queue.fal.test/fal-ai/f5-tts/requests/fal-777/status",
  response_url: "https://queue.fal.test/fal-ai/f5-tts/requests/fal-777/response",
};

const RESULT_RESPONSE = { audio_url: "https://cdn.fal.test/a.wav" };

describe("tts fal transport resume (#1628 ⑦)", () => {
  beforeEach(() => {
    requestWithRetryMock.mockReset();
    pollUntilDoneMock.mockReset();
    pollUntilDoneMock.mockResolvedValue({ status: "COMPLETED" });
  });

  it("fresh run: submits without any client id, persists the vendor id, then polls", async () => {
    requestWithRetryMock
      .mockResolvedValueOnce(SUBMIT_RESPONSE)
      .mockResolvedValueOnce(RESULT_RESPONSE);
    const persistTaskId = vi.fn(async () => {});

    const r = await generate("hello", RESOLVED, { text: "hello" }, {
      storedTaskId: null,
      persistTaskId,
      externalTaskId: "breatic-task-abc",
    });

    // Call 0 = submit POST, call 1 = result GET
    expect(requestWithRetryMock).toHaveBeenCalledTimes(2);
    const submitBody = JSON.parse(
      (requestWithRetryMock.mock.calls[0]![1] as { body: string }).body,
    ) as Record<string, unknown>;
    expect(submitBody).toEqual({
      input: { model_type: "F5-TTS", gen_text: "hello" },
    }); // Tier B: no client id injected
    expect(persistTaskId).toHaveBeenCalledWith("fal-777");
    expect(String(pollUntilDoneMock.mock.calls[0]![0])).toContain("fal-777");
    expect(String(requestWithRetryMock.mock.calls[1]![0])).toContain(
      "fal-777/response",
    );
    expect(r.url).toBe("https://cdn.fal.test/a.wav");
  });

  it("INVARIANT — stored id present: NO submit POST, resumes polling the stored id", async () => {
    requestWithRetryMock.mockResolvedValueOnce(RESULT_RESPONSE);
    const persistTaskId = vi.fn(async () => {});

    const r = await generate("hello", RESOLVED, { text: "hello" }, {
      storedTaskId: "fal-stored-42",
      persistTaskId,
      externalTaskId: "breatic-task-abc",
    });

    // ⑦ core: the only HTTP request is the result GET — no duplicate generation
    expect(requestWithRetryMock).toHaveBeenCalledTimes(1);
    expect(
      (requestWithRetryMock.mock.calls[0]![1] as { method: string }).method,
    ).toBe("GET");
    expect(persistTaskId).toHaveBeenCalledTimes(0);
    expect(String(pollUntilDoneMock.mock.calls[0]![0])).toBe(
      "https://queue.fal.test/fal-ai/f5-tts/requests/fal-stored-42/status",
    );
    expect(String(requestWithRetryMock.mock.calls[0]![0])).toBe(
      "https://queue.fal.test/fal-ai/f5-tts/requests/fal-stored-42/response",
    );
    expect(r.url).toBe("https://cdn.fal.test/a.wav");
  });

  it("no resume ctx (legacy caller): submits and polls as before", async () => {
    requestWithRetryMock
      .mockResolvedValueOnce(SUBMIT_RESPONSE)
      .mockResolvedValueOnce(RESULT_RESPONSE);

    const r = await generate("hello", RESOLVED, { text: "hello" });

    expect(requestWithRetryMock).toHaveBeenCalledTimes(2);
    const submitBody = JSON.parse(
      (requestWithRetryMock.mock.calls[0]![1] as { body: string }).body,
    ) as Record<string, unknown>;
    expect(submitBody).toEqual({
      input: { model_type: "F5-TTS", gen_text: "hello" },
    });
    expect(String(pollUntilDoneMock.mock.calls[0]![0])).toContain("fal-777");
    expect(r.url).toBe("https://cdn.fal.test/a.wav");
  });
});
