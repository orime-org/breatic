// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * One question to an upstream about a task it is running (inner#1337).
 *
 * The answer is either terminal, or a time to ask again: the job goes back
 * to the queue in between, so nothing here waits. A query that failed for a
 * reason that may clear (a 5xx, a 429, the network) is asked again the same
 * way; a 4xx the upstream gave on purpose is an error of its own.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type * as sharedModule from "@breatic/shared";
import type * as coreModule from "@breatic/core";

const httpRequestMock = vi.fn();

vi.mock("@breatic/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof sharedModule>();
  return { ...actual, httpRequest: (...args: unknown[]) => httpRequestMock(...args) };
});

vi.mock("@breatic/core", async (importOriginal) => {
  const actual = await importOriginal<typeof coreModule>();
  return {
    ...actual,
    getWorkerConfig: () => ({ poll_interval: 3_000, billing_timeout: 30_000 }),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  };
});

const { pollOnce, UpstreamTaskFailed, HttpStatusError } = await import("@worker/providers/http.js");
const { StillRunning } = await import("@worker/handlers/still-running.js");

const NOW = 1_800_000_000_000;

const OPTIONS = {
  statusPath: ["data", "status"],
  successStatuses: new Set(["completed"]),
  failureStatuses: new Set(["failed"]),
  errorPath: ["data", "error"],
  provider: "wavespeed",
};

/**
 * A response the transport hands back.
 * @param status - HTTP status.
 * @param body - JSON body.
 * @returns The response.
 */
function answer(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

beforeEach(() => {
  httpRequestMock.mockReset();
  vi.spyOn(Date, "now").mockReturnValue(NOW);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("pollOnce", () => {
  it("returns the response when the upstream says the task completed", async () => {
    httpRequestMock.mockResolvedValue(answer(200, { data: { status: "completed", outputs: ["https://o/1.mp4"] } }));

    await expect(pollOnce("https://ws/predictions/p1/result", OPTIONS)).resolves.toStrictEqual({
      data: { status: "completed", outputs: ["https://o/1.mp4"] },
    });
  });

  it("throws UpstreamTaskFailed with the upstream's words when it failed the task", async () => {
    httpRequestMock.mockResolvedValue(answer(200, { data: { status: "failed", error: "content refused" } }));

    const err = await pollOnce("https://ws/predictions/p1/result", OPTIONS).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UpstreamTaskFailed);
    expect((err as InstanceType<typeof UpstreamTaskFailed>).upstreamError).toBe("content refused");
  });

  it("asks once and names the next time to ask when the task is still going", async () => {
    httpRequestMock.mockResolvedValue(answer(200, { data: { status: "processing" } }));

    const err = await pollOnce("https://ws/predictions/p1/result", OPTIONS).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StillRunning);
    expect((err as InstanceType<typeof StillRunning>).resumeAt).toBe(NOW + 3_000);
    expect(httpRequestMock).toHaveBeenCalledTimes(1);
  });

  it.each([500, 502, 503, 429])("asks again later when the query answered %i", async (status) => {
    httpRequestMock.mockResolvedValue(answer(status, { message: "busy" }));

    const err = await pollOnce("https://ws/predictions/p1/result", OPTIONS).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StillRunning);
    expect((err as InstanceType<typeof StillRunning>).resumeAt).toBe(NOW + 3_000);
  });

  it("asks again later when the query never got an answer", async () => {
    httpRequestMock.mockRejectedValue(new TypeError("fetch failed"));

    await expect(pollOnce("https://ws/predictions/p1/result", OPTIONS)).rejects.toBeInstanceOf(StillRunning);
  });

  it.each([401, 403, 404])("throws the upstream's %i as an error of its own", async (status) => {
    httpRequestMock.mockResolvedValue(answer(status, { message: "prediction not found" }));

    const err = await pollOnce("https://ws/predictions/p1/result", OPTIONS).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpStatusError);
    expect((err as InstanceType<typeof HttpStatusError>).status).toBe(status);
    expect(err).not.toBeInstanceOf(StillRunning);
  });
});
