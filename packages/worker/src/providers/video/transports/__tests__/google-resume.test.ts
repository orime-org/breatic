// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect, vi, beforeEach } from "vitest";
import type * as httpModule from "@worker/providers/http.js";

import type { ResolvedModel } from "@worker/providers/shared.js";

/**
 * #1628 (#1625 ⑦) — google VEO video transport resume wiring.
 *
 * Caught by the adversarial pass: google.ts is an async submit+poll transport
 * (long-running operations, manual poll loop) that the rollout missed because
 * it uses neither pollUntilDone nor a task_id field. A BullMQ retry would
 * re-submit a NEW billed VEO operation. Same contract as the others: persist
 * the operation name after submit; with a stored operation name, skip the
 * submit POST and resume polling.
 */
const requestWithRetryMock = vi.fn();

vi.mock("@worker/providers/http.js", async (importOriginal) => {
  const actual = await importOriginal<typeof httpModule>();
  return {
    ...actual,
    requestWithRetry: (...args: unknown[]) => requestWithRetryMock(...args),
  };
});

import { generate } from "@worker/providers/video/transports/google.js";

const RESOLVED: ResolvedModel = {
  modelName: "veo-3.1",
  modelId: "veo-3.1",
  providerName: "google",
  baseUrl: "https://genlang.test/v1beta",
  apiKey: "gkey",
  timeout: 60,
  maxConcurrency: 5,
  costPerCall: 100,
  extraParams: {},
  litellmModel: undefined,
  tokenPrice: undefined,
  creditPrice: undefined,
} as unknown as ResolvedModel;

const DONE_RESULT = {
  done: true,
  response: {
    generateVideoResponse: {
      generatedSamples: [{ video: { uri: "https://cdn.google.test/v.mp4" } }],
    },
  },
};

/**
 * Count mock calls whose fetch options carry the given HTTP method.
 * @param method - HTTP method to count ("POST" submits / "GET" polls)
 * @returns Number of matching calls
 */
function callsWithMethod(method: string): number {
  return requestWithRetryMock.mock.calls.filter(
    (c) => (c[1] as { method?: string }).method === method,
  ).length;
}

describe("google VEO transport resume (#1628 ⑦)", () => {
  beforeEach(() => {
    requestWithRetryMock.mockReset();
  });

  it("fresh run: submits once, persists the operation name, then polls it", async () => {
    requestWithRetryMock.mockImplementation(async (_url: unknown, opts: unknown) =>
      (opts as { method: string }).method === "POST"
        ? { name: "operations/op-777" }
        : DONE_RESULT,
    );
    const persistTaskId = vi.fn(async () => {});

    const r = await generate("a dog", RESOLVED, {}, {
      storedTaskId: null,
      persistTaskId,
      externalTaskId: "breatic-task-abc",
    });

    expect(callsWithMethod("POST")).toBe(1);
    expect(persistTaskId).toHaveBeenCalledWith("operations/op-777");
    const pollUrl = String(
      requestWithRetryMock.mock.calls.find(
        (c) => (c[1] as { method: string }).method === "GET",
      )![0],
    );
    expect(pollUrl).toContain("operations/op-777");
    expect(r.url).toBe("https://cdn.google.test/v.mp4");
  });

  it("INVARIANT — stored operation name: NO submit POST, resumes polling it", async () => {
    requestWithRetryMock.mockResolvedValue(DONE_RESULT);
    const persistTaskId = vi.fn(async () => {});

    const r = await generate("a dog", RESOLVED, {}, {
      storedTaskId: "operations/op-stored-42",
      persistTaskId,
      externalTaskId: "breatic-task-abc",
    });

    expect(callsWithMethod("POST")).toBe(0); // ⑦ core: no duplicate VEO operation
    expect(persistTaskId).toHaveBeenCalledTimes(0);
    expect(String(requestWithRetryMock.mock.calls[0]![0])).toContain(
      "operations/op-stored-42",
    );
    expect(r.url).toBe("https://cdn.google.test/v.mp4");
  });

  it("no resume ctx (legacy caller): submits and polls as before", async () => {
    requestWithRetryMock.mockImplementation(async (_url: unknown, opts: unknown) =>
      (opts as { method: string }).method === "POST"
        ? { name: "operations/op-999" }
        : DONE_RESULT,
    );

    const r = await generate("a dog", RESOLVED, {});

    expect(callsWithMethod("POST")).toBe(1);
    expect(r.url).toBe("https://cdn.google.test/v.mp4");
  });
});
