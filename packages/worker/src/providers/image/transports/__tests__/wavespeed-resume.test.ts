// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect, vi, beforeEach } from "vitest";
import type * as httpModule from "@worker/providers/http.js";

import type { ResolvedModel } from "@worker/providers/shared.js";

/**
 * #1628 (#1625 ⑦) — wavespeed image transport resume wiring (Tier B).
 *
 * Submit must be at-most-once across BullMQ retries: with a stored vendor
 * task id the transport must SKIP the submit POST and resume polling; on a
 * fresh run it must persist the server-returned task id before polling.
 * Tier B: WaveSpeed has no client-side idempotency field, so the submit body
 * must NOT carry any client id — only the returned id is persisted.
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

import { generate } from "@worker/providers/image/transports/wavespeed.js";

const RESOLVED: ResolvedModel = {
  modelName: "seedream-4",
  modelId: "bytedance/seedream-4",
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
    outputs: ["https://cdn.wavespeed.test/i.png"],
  },
};

describe("wavespeed image transport resume (#1628 ⑦)", () => {
  beforeEach(() => {
    requestWithRetryMock.mockReset();
    pollUntilDoneMock.mockReset();
    queryBillingMock.mockReset();
    pollUntilDoneMock.mockResolvedValue(COMPLETED_RESULT);
    queryBillingMock.mockResolvedValue(0.02);
  });

  it("fresh run: submits WITHOUT a client id, persists the vendor id, then polls", async () => {
    requestWithRetryMock.mockResolvedValue({ data: { id: "ws-777" } });
    const persistTaskId = vi.fn(async () => {});

    const r = await generate("a cat", RESOLVED, { size: "1024*1024" }, {
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
    expect(r.url).toBe("https://cdn.wavespeed.test/i.png");
    expect(r.cost).toBe(0.02);
  });

  it("INVARIANT — stored id present: NO submit POST, resumes polling the stored id", async () => {
    const persistTaskId = vi.fn(async () => {});

    const r = await generate("a cat", RESOLVED, {}, {
      storedTaskId: "ws-stored-42",
      persistTaskId,
      externalTaskId: "breatic-task-abc",
    });

    expect(requestWithRetryMock).toHaveBeenCalledTimes(0); // ⑦ core: no duplicate generation
    expect(persistTaskId).toHaveBeenCalledTimes(0);
    expect(String(pollUntilDoneMock.mock.calls[0]![0])).toContain("ws-stored-42");
    expect(queryBillingMock).toHaveBeenCalledWith(RESOLVED, "ws-stored-42");
    expect(r.url).toBe("https://cdn.wavespeed.test/i.png");
  });

  it("no resume ctx (legacy caller): submits and polls as before", async () => {
    requestWithRetryMock.mockResolvedValue({ data: { id: "ws-999" } });

    const r = await generate("a cat", RESOLVED, {});

    expect(requestWithRetryMock).toHaveBeenCalledTimes(1);
    expect(String(pollUntilDoneMock.mock.calls[0]![0])).toContain("ws-999");
    expect(r.url).toBe("https://cdn.wavespeed.test/i.png");
  });

  it("sync response with task id: no poll round, still persists the id, bills by it", async () => {
    requestWithRetryMock.mockResolvedValue({
      data: { id: "ws-777", outputs: ["https://cdn.wavespeed.test/sync.png"] },
    });
    const persistTaskId = vi.fn(async () => {});

    const r = await generate("a cat", RESOLVED, {}, {
      storedTaskId: null,
      persistTaskId,
      externalTaskId: "breatic-task-abc",
    });

    expect(pollUntilDoneMock).toHaveBeenCalledTimes(0);
    expect(persistTaskId).toHaveBeenCalledWith("ws-777");
    expect(queryBillingMock).toHaveBeenCalledWith(RESOLVED, "ws-777");
    expect(r.url).toBe("https://cdn.wavespeed.test/sync.png");
    expect(r.cost).toBe(0.02);
  });

  it("sync response without task id: delivered as-is, nothing persisted, cost 0", async () => {
    requestWithRetryMock.mockResolvedValue({
      data: { outputs: ["https://cdn.wavespeed.test/sync.png"] },
    });
    const persistTaskId = vi.fn(async () => {});

    const r = await generate("a cat", RESOLVED, {}, {
      storedTaskId: null,
      persistTaskId,
      externalTaskId: "breatic-task-abc",
    });

    expect(pollUntilDoneMock).toHaveBeenCalledTimes(0);
    expect(persistTaskId).toHaveBeenCalledTimes(0);
    expect(queryBillingMock).toHaveBeenCalledTimes(0);
    expect(r.url).toBe("https://cdn.wavespeed.test/sync.png");
    expect(r.cost).toBe(0);
  });
});
