// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect, vi, beforeEach } from "vitest";
import type * as httpModule from "@worker/providers/http.js";

import type { ResolvedModel } from "@worker/providers/shared.js";

/**
 * #1628 (#1625 ⑦) — klingai transport resume wiring (the Tier-A proof).
 *
 * Submit must be at-most-once across BullMQ retries: with a stored vendor
 * task id the transport must SKIP the submit POST and resume polling; on a
 * fresh run it must persist the returned task id before polling and send a
 * deterministic `external_task_id` (Kling's account-unique client id) so even
 * an ambiguous submit failure cannot double-create the task.
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

import { generate } from "@worker/providers/video/transports/klingai.js";

const RESOLVED: ResolvedModel = {
  modelName: "kling-o3-pro",
  modelId: "kling-o3-pro",
  providerName: "klingai",
  baseUrl: "https://api.klingai.test/v1",
  apiKey: "ak:sk",
  timeout: 60,
  maxConcurrency: 5,
  costPerCall: 100,
  extraParams: {},
  litellmModel: undefined,
  tokenPrice: undefined,
  creditPrice: undefined,
} as unknown as ResolvedModel;

const SUCCEED_RESULT = {
  code: 0,
  data: {
    task_status: "succeed",
    task_result: { videos: [{ url: "https://cdn.kling.test/v.mp4" }] },
  },
};

describe("klingai transport resume (#1628 ⑦)", () => {
  beforeEach(() => {
    requestWithRetryMock.mockReset();
    pollUntilDoneMock.mockReset();
    pollUntilDoneMock.mockResolvedValue(SUCCEED_RESULT);
  });

  it("fresh run: submits with external_task_id, persists the vendor id, then polls", async () => {
    requestWithRetryMock.mockResolvedValue({ code: 0, data: { task_id: "kling-777" } });
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
    expect(submitBody.external_task_id).toBe("breatic-task-abc"); // Tier A
    expect(persistTaskId).toHaveBeenCalledWith("kling-777");
    expect(String(pollUntilDoneMock.mock.calls[0]![0])).toContain("kling-777");
    expect(r.url).toBe("https://cdn.kling.test/v.mp4");
  });

  it("INVARIANT — stored id present: NO submit POST, resumes polling the stored id", async () => {
    const persistTaskId = vi.fn(async () => {});

    const r = await generate("a cat", RESOLVED, {}, {
      storedTaskId: "kling-stored-42",
      persistTaskId,
      externalTaskId: "breatic-task-abc",
    });

    expect(requestWithRetryMock).toHaveBeenCalledTimes(0); // ⑦ core: no duplicate generation
    expect(persistTaskId).toHaveBeenCalledTimes(0);
    expect(String(pollUntilDoneMock.mock.calls[0]![0])).toContain("kling-stored-42");
    expect(r.url).toBe("https://cdn.kling.test/v.mp4");
  });

  it("no resume ctx (legacy caller): submits and polls as before, without external_task_id", async () => {
    requestWithRetryMock.mockResolvedValue({ code: 0, data: { task_id: "kling-999" } });

    const r = await generate("a cat", RESOLVED, {});

    expect(requestWithRetryMock).toHaveBeenCalledTimes(1);
    const submitBody = JSON.parse(
      (requestWithRetryMock.mock.calls[0]![1] as { body: string }).body,
    ) as Record<string, unknown>;
    expect(submitBody.external_task_id).toBeUndefined();
    expect(r.url).toBe("https://cdn.kling.test/v.mp4");
  });
});
