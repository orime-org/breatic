// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect, vi, beforeEach } from "vitest";

import type { ResolvedModel } from "@worker/providers/shared.js";

/**
 * #1628 (#1625 ⑦) — audio fal transport resume wiring (Tier B).
 *
 * Submit must be at-most-once across BullMQ retries: with a stored vendor
 * request id the transport must SKIP the submit POST and resume polling on
 * queue URLs reconstructed from that id; on a fresh run it must persist the
 * server-returned request id before polling. Tier B: no client id /
 * idempotency field is added to the submit body — only the server-returned
 * id is persisted.
 */
const requestWithRetryMock = vi.fn();
const pollUntilDoneMock = vi.fn();

vi.mock("@worker/providers/http.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@worker/providers/http.js")>();
  return {
    ...actual,
    requestWithRetry: (...args: unknown[]) => requestWithRetryMock(...args),
    pollUntilDone: (...args: unknown[]) => pollUntilDoneMock(...args),
  };
});

import { generate } from "@worker/providers/audio/transports/fal.js";

const RESOLVED: ResolvedModel = {
  modelName: "elevenlabs-sfx-v2",
  modelId: "fal-ai/elevenlabs/sound-effects/v2",
  providerName: "fal",
  baseUrl: "https://queue.fal.test",
  apiKey: "fal-key",
  timeout: 60,
  maxConcurrency: 5,
  costPerCall: 100,
  extraParams: {},
  litellmModel: undefined,
  tokenPrice: undefined,
  creditPrice: undefined,
} as unknown as ResolvedModel;

const RESULT_PAYLOAD = { audio: { url: "https://cdn.fal.test/a.mp3" } };

describe("audio fal transport resume (#1628 ⑦)", () => {
  beforeEach(() => {
    requestWithRetryMock.mockReset();
    pollUntilDoneMock.mockReset();
    pollUntilDoneMock.mockResolvedValue({ status: "COMPLETED" });
  });

  it("fresh run: submits without any client id field, persists the vendor id, then polls", async () => {
    requestWithRetryMock
      .mockResolvedValueOnce({
        request_id: "fal-777",
        status_url: "https://queue.fal.test/status/fal-777",
        response_url: "https://queue.fal.test/response/fal-777",
      })
      .mockResolvedValueOnce(RESULT_PAYLOAD);
    const persistTaskId = vi.fn(async () => {});

    const r = await generate("a boom", RESOLVED, { prompt: "a boom" }, {
      storedTaskId: null,
      persistTaskId,
      externalTaskId: "breatic-task-abc",
    });

    expect(requestWithRetryMock).toHaveBeenCalledTimes(2); // submit POST + result GET
    expect(
      (requestWithRetryMock.mock.calls[0]![1] as { method: string }).method,
    ).toBe("POST");
    const submitBody = JSON.parse(
      (requestWithRetryMock.mock.calls[0]![1] as { body: string }).body,
    ) as Record<string, unknown>;
    expect(submitBody.external_task_id).toBeUndefined(); // Tier B: no client id
    expect(submitBody).toEqual({ input: { text: "a boom" } });
    expect(persistTaskId).toHaveBeenCalledWith("fal-777");
    expect(String(pollUntilDoneMock.mock.calls[0]![0])).toBe(
      "https://queue.fal.test/status/fal-777",
    );
    expect(String(requestWithRetryMock.mock.calls[1]![0])).toBe(
      "https://queue.fal.test/response/fal-777",
    );
    expect(r.url).toBe("https://cdn.fal.test/a.mp3");
  });

  it("INVARIANT — stored id present: NO submit POST, resumes polling reconstructed URLs", async () => {
    requestWithRetryMock.mockResolvedValueOnce(RESULT_PAYLOAD);
    const persistTaskId = vi.fn(async () => {});

    const r = await generate("a boom", RESOLVED, { prompt: "a boom" }, {
      storedTaskId: "fal-stored-42",
      persistTaskId,
      externalTaskId: "breatic-task-abc",
    });

    // ⑦ core: no duplicate generation — the only HTTP call is the result GET
    expect(requestWithRetryMock).toHaveBeenCalledTimes(1);
    expect(
      (requestWithRetryMock.mock.calls[0]![1] as { method: string }).method,
    ).toBe("GET");
    expect(persistTaskId).toHaveBeenCalledTimes(0);
    expect(String(pollUntilDoneMock.mock.calls[0]![0])).toBe(
      `${RESOLVED.baseUrl}/${RESOLVED.modelId}/requests/fal-stored-42/status`,
    );
    expect(String(requestWithRetryMock.mock.calls[0]![0])).toBe(
      `${RESOLVED.baseUrl}/${RESOLVED.modelId}/requests/fal-stored-42/response`,
    );
    expect(r.url).toBe("https://cdn.fal.test/a.mp3");
  });

  it("no resume ctx (legacy caller): submits and polls as before", async () => {
    requestWithRetryMock
      .mockResolvedValueOnce({ request_id: "fal-999" })
      .mockResolvedValueOnce(RESULT_PAYLOAD);

    const r = await generate("a boom", RESOLVED, { prompt: "a boom" });

    expect(requestWithRetryMock).toHaveBeenCalledTimes(2);
    expect(
      (requestWithRetryMock.mock.calls[0]![1] as { method: string }).method,
    ).toBe("POST");
    expect(String(pollUntilDoneMock.mock.calls[0]![0])).toBe(
      `${RESOLVED.baseUrl}/${RESOLVED.modelId}/requests/fal-999/status`,
    );
    expect(r.url).toBe("https://cdn.fal.test/a.mp3");
  });
});
