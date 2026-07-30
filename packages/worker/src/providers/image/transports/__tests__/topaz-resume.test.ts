// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect, vi, beforeEach } from "vitest";
import type * as httpModule from "@worker/providers/http.js";

import type { ResolvedModel } from "@worker/providers/shared.js";

/**
 * #1628 (#1625 ⑦) — topaz image transport resume wiring (Tier B).
 *
 * Submit must be at-most-once across BullMQ retries: with a stored vendor
 * process id the transport must SKIP the submit POST and resume polling; on
 * a fresh run it must persist the server-returned process id before polling.
 * Tier B: Topaz has no client-side idempotency field, so the submit form
 * must NOT carry any client id — only the returned id is persisted.
 *
 * Only the async endpoint path (`modelId` ending in `/async`) is resumable.
 * The cost-estimate call goes through the shared transport too, stubbed here
 * to a non-ok response so it short-circuits to cost 0 and never leaves the
 * process.
 */
const requestWithRetryMock = vi.fn();
const pollUntilDoneMock = vi.fn();
const requestRawMock = vi.fn();

vi.mock("@worker/providers/http.js", async (importOriginal) => {
  const actual = await importOriginal<typeof httpModule>();
  return {
    ...actual,
    requestWithRetry: (...args: unknown[]) => requestWithRetryMock(...args),
    pollUntilDone: (...args: unknown[]) => pollUntilDoneMock(...args),
    requestRaw: (...args: unknown[]) => requestRawMock(...args),
  };
});

import { generate } from "@worker/providers/image/transports/topaz.js";

const RESOLVED: ResolvedModel = {
  modelName: "topaz-upscale",
  modelId: "enhance-gen/async",
  providerName: "topaz",
  baseUrl: "https://api.topaz.test/image/v1",
  apiKey: "tp-key",
  timeout: 60,
  maxConcurrency: 5,
  costPerCall: 0,
  extraParams: {},
  litellmModel: undefined,
  tokenPrice: undefined,
  creditPrice: 0.01,
} as unknown as ResolvedModel;

const COMPLETED_RESULT = {
  status: "completed",
  output_url: "https://cdn.topaz.test/i.png",
};

describe("topaz image transport resume (#1628 ⑦)", () => {
  beforeEach(() => {
    requestWithRetryMock.mockReset();
    pollUntilDoneMock.mockReset();
    requestRawMock.mockReset();
    pollUntilDoneMock.mockResolvedValue(COMPLETED_RESULT);
    requestRawMock.mockResolvedValue({ ok: false });
  });

  it("fresh run: submits WITHOUT a client id, persists the vendor id, then polls", async () => {
    requestWithRetryMock.mockResolvedValue({ process_id: "tp-777" });
    const persistTaskId = vi.fn(async () => {});

    const r = await generate("", RESOLVED, { source_url: "https://src.test/a.png" }, {
      storedTaskId: null,
      persistTaskId,
      externalTaskId: "breatic-task-abc",
    });

    expect(requestWithRetryMock).toHaveBeenCalledTimes(1);
    const submitForm = (requestWithRetryMock.mock.calls[0]![1] as { body: URLSearchParams }).body;
    expect(submitForm.get("external_task_id")).toBeNull(); // Tier B: no client id
    expect(persistTaskId).toHaveBeenCalledWith("tp-777");
    expect(String(pollUntilDoneMock.mock.calls[0]![0])).toContain("/status/tp-777");
    expect(r.url).toBe("https://cdn.topaz.test/i.png");
  });

  it("INVARIANT — stored id present: NO submit POST, resumes polling the stored id", async () => {
    const persistTaskId = vi.fn(async () => {});

    const r = await generate("", RESOLVED, { source_url: "https://src.test/a.png" }, {
      storedTaskId: "tp-stored-42",
      persistTaskId,
      externalTaskId: "breatic-task-abc",
    });

    expect(requestWithRetryMock).toHaveBeenCalledTimes(0); // ⑦ core: no duplicate generation
    expect(persistTaskId).toHaveBeenCalledTimes(0);
    expect(String(pollUntilDoneMock.mock.calls[0]![0])).toContain("/status/tp-stored-42");
    expect(r.url).toBe("https://cdn.topaz.test/i.png");
  });

  it("no resume ctx (legacy caller): submits and polls as before", async () => {
    requestWithRetryMock.mockResolvedValue({ process_id: "tp-999" });

    const r = await generate("", RESOLVED, { source_url: "https://src.test/a.png" });

    expect(requestWithRetryMock).toHaveBeenCalledTimes(1);
    expect(String(pollUntilDoneMock.mock.calls[0]![0])).toContain("/status/tp-999");
    expect(r.url).toBe("https://cdn.topaz.test/i.png");
  });

  it("immediate output without process_id: delivered as-is, nothing persisted, no poll", async () => {
    requestWithRetryMock.mockResolvedValue({
      output_url: "https://cdn.topaz.test/immediate.png",
    });
    const persistTaskId = vi.fn(async () => {});

    const r = await generate("", RESOLVED, { source_url: "https://src.test/a.png" }, {
      storedTaskId: null,
      persistTaskId,
      externalTaskId: "breatic-task-abc",
    });

    expect(pollUntilDoneMock).toHaveBeenCalledTimes(0);
    expect(persistTaskId).toHaveBeenCalledTimes(0);
    expect(r.url).toBe("https://cdn.topaz.test/immediate.png");
  });
});
