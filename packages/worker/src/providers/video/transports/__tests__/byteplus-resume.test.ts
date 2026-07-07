// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect, vi, beforeEach } from "vitest";

import type { ResolvedModel } from "@worker/providers/shared.js";

/**
 * #1628 (#1625 ⑦) — byteplus video transport resume wiring (Tier B).
 *
 * Submit must be at-most-once across BullMQ retries: with a stored vendor
 * task id the transport must SKIP the submit POST and resume polling; on a
 * fresh run it must persist the server-returned task id before polling.
 * Tier B: BytePlus has no idempotent client-side submit id, so the submit
 * body must NOT carry any client-generated id field.
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

import { generate } from "@worker/providers/video/transports/byteplus.js";

const RESOLVED: ResolvedModel = {
  modelName: "seedance-2.0",
  modelId: "seedance-2-0",
  providerName: "byteplus",
  baseUrl: "https://api.byteplus.test/v3",
  apiKey: "bp-key",
  timeout: 60,
  maxConcurrency: 5,
  costPerCall: 100,
  extraParams: {},
  litellmModel: undefined,
  tokenPrice: undefined,
  creditPrice: undefined,
} as unknown as ResolvedModel;

const SUCCEEDED_RESULT = {
  status: "succeeded",
  data: [{ url: "https://cdn.byteplus.test/v.mp4" }],
  usage: { total_cost: 0.5 },
};

describe("byteplus video transport resume (#1628 ⑦)", () => {
  beforeEach(() => {
    requestWithRetryMock.mockReset();
    pollUntilDoneMock.mockReset();
    pollUntilDoneMock.mockResolvedValue(SUCCEEDED_RESULT);
  });

  it("fresh run: submits without any client id field, persists the vendor id, then polls", async () => {
    requestWithRetryMock.mockResolvedValue({ task_id: "bp-777", status: "pending" });
    const persistTaskId = vi.fn(async () => {});

    const r = await generate("a cat", RESOLVED, {}, {
      storedTaskId: null,
      persistTaskId,
      externalTaskId: "breatic-task-abc",
    });

    expect(requestWithRetryMock).toHaveBeenCalledTimes(1);
    const submitBody = JSON.parse(
      (requestWithRetryMock.mock.calls[0]![1] as { body: string }).body,
    ) as Record<string, unknown>;
    expect(submitBody.external_task_id).toBeUndefined(); // Tier B: no client id
    expect(persistTaskId).toHaveBeenCalledWith("bp-777");
    expect(String(pollUntilDoneMock.mock.calls[0]![0])).toContain("bp-777");
    expect(r.url).toBe("https://cdn.byteplus.test/v.mp4");
    expect(r.cost).toBe(0.5);
  });

  it("INVARIANT — stored id present: NO submit POST, resumes polling the stored id", async () => {
    const persistTaskId = vi.fn(async () => {});

    const r = await generate("a cat", RESOLVED, {}, {
      storedTaskId: "bp-stored-42",
      persistTaskId,
      externalTaskId: "breatic-task-abc",
    });

    expect(requestWithRetryMock).toHaveBeenCalledTimes(0); // ⑦ core: no duplicate generation
    expect(persistTaskId).toHaveBeenCalledTimes(0);
    expect(String(pollUntilDoneMock.mock.calls[0]![0])).toContain("bp-stored-42");
    expect(r.url).toBe("https://cdn.byteplus.test/v.mp4");
  });

  it("no resume ctx (legacy caller): submits and polls as before", async () => {
    requestWithRetryMock.mockResolvedValue({ task_id: "bp-999", status: "pending" });

    const r = await generate("a cat", RESOLVED, {});

    expect(requestWithRetryMock).toHaveBeenCalledTimes(1);
    expect(String(pollUntilDoneMock.mock.calls[0]![0])).toContain("bp-999");
    expect(r.url).toBe("https://cdn.byteplus.test/v.mp4");
  });
});
