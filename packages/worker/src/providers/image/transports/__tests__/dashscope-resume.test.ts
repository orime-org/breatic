// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import type * as httpModule from "@worker/providers/http.js";

import type { ResolvedModel } from "@worker/providers/shared.js";

/**
 * #1628 (#1625 ⑦) — dashscope image transport resume wiring (Tier B).
 *
 * Submit must be at-most-once across BullMQ retries: with a stored vendor
 * task id the transport must SKIP the submit POST and resume polling; on a
 * fresh run it must persist the server-returned task id before polling.
 * Tier B: DashScope has no client-side idempotency field, so the submit body
 * must NOT carry any client id — only the returned id is persisted.
 *
 * DashScope submits via raw `fetch` (not `requestWithRetry`), so the global
 * fetch is stubbed; polling still goes through the shared `pollUntilDone`.
 */
const pollUntilDoneMock = vi.fn();

vi.mock("@worker/providers/http.js", async (importOriginal) => {
  const actual = await importOriginal<typeof httpModule>();
  return {
    ...actual,
    pollUntilDone: (...args: unknown[]) => pollUntilDoneMock(...args),
  };
});

import { generate } from "@worker/providers/image/transports/dashscope.js";

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

const RESOLVED: ResolvedModel = {
  modelName: "qwen-image",
  modelId: "wanx2.1-t2i-turbo",
  providerName: "dashscope",
  baseUrl: "https://dashscope.test/api/v1",
  apiKey: "ds-key",
  timeout: 60,
  maxConcurrency: 5,
  costPerCall: 0,
  extraParams: {},
  litellmModel: undefined,
  tokenPrice: undefined,
  creditPrice: undefined,
} as unknown as ResolvedModel;

const SUCCEEDED_RESULT = {
  output: {
    task_status: "SUCCEEDED",
    results: [{ url: "https://cdn.dashscope.test/i.png" }],
  },
  usage: { total_cost: 0.03 },
};

describe("dashscope image transport resume (#1628 ⑦)", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    pollUntilDoneMock.mockReset();
    pollUntilDoneMock.mockResolvedValue(SUCCEEDED_RESULT);
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ output: { task_id: "ds-777" } }),
    });
  });

  afterAll(() => {
    vi.unstubAllGlobals();
  });

  it("fresh run: submits WITHOUT a client id, persists the vendor id, then polls", async () => {
    const persistTaskId = vi.fn(async () => {});

    const r = await generate("a cat", RESOLVED, { size: "1024*1024" }, {
      storedTaskId: null,
      persistTaskId,
      externalTaskId: "breatic-task-abc",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const submitBody = JSON.parse(
      (fetchMock.mock.calls[0]![1] as { body: string }).body,
    ) as Record<string, unknown>;
    expect(submitBody.model).toBe("wanx2.1-t2i-turbo");
    expect(submitBody.external_task_id).toBeUndefined(); // Tier B: no client id
    expect(persistTaskId).toHaveBeenCalledWith("ds-777");
    expect(String(pollUntilDoneMock.mock.calls[0]![0])).toContain("/tasks/ds-777");
    expect(r.url).toBe("https://cdn.dashscope.test/i.png");
    expect(r.cost).toBe(0.03);
  });

  it("INVARIANT — stored id present: NO submit POST, resumes polling the stored id", async () => {
    const persistTaskId = vi.fn(async () => {});

    const r = await generate("a cat", RESOLVED, {}, {
      storedTaskId: "ds-stored-42",
      persistTaskId,
      externalTaskId: "breatic-task-abc",
    });

    expect(fetchMock).toHaveBeenCalledTimes(0); // ⑦ core: no duplicate generation
    expect(persistTaskId).toHaveBeenCalledTimes(0);
    expect(String(pollUntilDoneMock.mock.calls[0]![0])).toContain("/tasks/ds-stored-42");
    expect(r.url).toBe("https://cdn.dashscope.test/i.png");
  });

  it("no resume ctx (legacy caller): submits and polls as before", async () => {
    const r = await generate("a cat", RESOLVED, {});

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(pollUntilDoneMock.mock.calls[0]![0])).toContain("/tasks/ds-777");
    expect(r.url).toBe("https://cdn.dashscope.test/i.png");
  });
});
