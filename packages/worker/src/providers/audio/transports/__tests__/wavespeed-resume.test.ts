// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect, vi, beforeEach } from "vitest";

import type { ResolvedModel } from "@worker/providers/shared.js";

/**
 * #1628 (#1625 ⑦) — audio wavespeed transport resume wiring (Tier B).
 *
 * Submit must be at-most-once across BullMQ retries: with a stored vendor
 * task id the transport must SKIP the submit POST and resume polling; on a
 * fresh run it must persist the server-returned task id before polling.
 * Tier B: no client id / idempotency field is added to the submit body —
 * only the server-returned id is persisted.
 */
const requestWithRetryMock = vi.fn();
const pollUntilDoneMock = vi.fn();
const queryBillingMock = vi.fn();

vi.mock("@worker/providers/http.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@worker/providers/http.js")>();
  return {
    ...actual,
    requestWithRetry: (...args: unknown[]) => requestWithRetryMock(...args),
    pollUntilDone: (...args: unknown[]) => pollUntilDoneMock(...args),
    queryBilling: (...args: unknown[]) => queryBillingMock(...args),
  };
});

import { generate } from "@worker/providers/audio/transports/wavespeed.js";

const RESOLVED: ResolvedModel = {
  modelName: "minimax-music",
  modelId: "minimax/music-01",
  providerName: "wavespeed",
  baseUrl: "https://api.wavespeed.test/v3",
  apiKey: "ws-key",
  timeout: 60,
  maxConcurrency: 5,
  costPerCall: 100,
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

describe("audio wavespeed transport resume (#1628 ⑦)", () => {
  beforeEach(() => {
    requestWithRetryMock.mockReset();
    pollUntilDoneMock.mockReset();
    queryBillingMock.mockReset();
    pollUntilDoneMock.mockResolvedValue(COMPLETED_RESULT);
    queryBillingMock.mockResolvedValue(0.42);
  });

  it("fresh run: submits without any client id field, persists the vendor id, then polls", async () => {
    requestWithRetryMock.mockResolvedValue({ data: { id: "ws-777" } });
    const persistTaskId = vi.fn(async () => {});

    const r = await generate("a song", RESOLVED, {}, {
      storedTaskId: null,
      persistTaskId,
      externalTaskId: "breatic-task-abc",
    });

    expect(requestWithRetryMock).toHaveBeenCalledTimes(1);
    const submitBody = JSON.parse(
      (requestWithRetryMock.mock.calls[0]![1] as { body: string }).body,
    ) as Record<string, unknown>;
    expect(submitBody.external_task_id).toBeUndefined(); // Tier B: no client id
    expect(persistTaskId).toHaveBeenCalledWith("ws-777");
    expect(String(pollUntilDoneMock.mock.calls[0]![0])).toContain("ws-777");
    expect(queryBillingMock).toHaveBeenCalledWith(RESOLVED, "ws-777");
    expect(r.url).toBe("https://cdn.wavespeed.test/a.mp3");
    expect(r.cost).toBe(0.42);
  });

  it("INVARIANT — stored id present: NO submit POST, resumes polling the stored id", async () => {
    const persistTaskId = vi.fn(async () => {});

    const r = await generate("a song", RESOLVED, {}, {
      storedTaskId: "ws-stored-42",
      persistTaskId,
      externalTaskId: "breatic-task-abc",
    });

    expect(requestWithRetryMock).toHaveBeenCalledTimes(0); // ⑦ core: no duplicate generation
    expect(persistTaskId).toHaveBeenCalledTimes(0);
    expect(String(pollUntilDoneMock.mock.calls[0]![0])).toContain("ws-stored-42");
    expect(queryBillingMock).toHaveBeenCalledWith(RESOLVED, "ws-stored-42");
    expect(r.url).toBe("https://cdn.wavespeed.test/a.mp3");
  });

  it("no resume ctx (legacy caller): submits and polls as before", async () => {
    requestWithRetryMock.mockResolvedValue({ data: { id: "ws-999" } });

    const r = await generate("a song", RESOLVED, {});

    expect(requestWithRetryMock).toHaveBeenCalledTimes(1);
    expect(String(pollUntilDoneMock.mock.calls[0]![0])).toContain("ws-999");
    expect(r.url).toBe("https://cdn.wavespeed.test/a.mp3");
  });

  it("fresh run with synchronous outputs: returns the submit result without polling", async () => {
    requestWithRetryMock.mockResolvedValue({
      data: { id: "ws-sync-1", outputs: ["https://cdn.wavespeed.test/sync.mp3"] },
    });
    const persistTaskId = vi.fn(async () => {});

    const r = await generate("a song", RESOLVED, {}, {
      storedTaskId: null,
      persistTaskId,
      externalTaskId: "breatic-task-abc",
    });

    expect(pollUntilDoneMock).toHaveBeenCalledTimes(0);
    expect(persistTaskId).toHaveBeenCalledWith("ws-sync-1");
    expect(queryBillingMock).toHaveBeenCalledWith(RESOLVED, "ws-sync-1");
    expect(r.url).toBe("https://cdn.wavespeed.test/sync.mp3");
  });
});
