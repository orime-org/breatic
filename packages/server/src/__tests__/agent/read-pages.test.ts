// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * How the server reads pages for one `web_fetch` call (inner#1664, design
 * 6.1): counted against the user's `web-fetch` limit once per call, however
 * many links it carries; over the limit the call is refused before anything
 * reaches the ingest Worker, and under it the request goes to the Worker
 * with the shared secret every other ingest call uses.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type * as CoreModule from "@breatic/core";
import type * as SharedModule from "@breatic/shared";
import type { ReadPagesAnswer, ReadPagesRequest } from "@breatic/shared";
import type * as RateLimitsModule from "@server/config/rate-limits.js";

const checkRateLimit = vi.fn();
const readPagesAtIngest = vi.fn();
const getRateLimit = vi.fn((_action: string) => ({ max: 10, windowSeconds: 60 }));
const log = { warn: vi.fn(), error: vi.fn(), info: vi.fn() };
const REDIS = { redis: "db0" };

vi.mock("@breatic/core", async (importOriginal) => ({
  ...(await importOriginal<typeof CoreModule>()),
  checkRateLimit,
  getRedis: () => REDIS,
  logger: log,
  env: { INGEST_BASE_URL: "https://ingest.test", INGEST_SHARED_SECRET: "shared-secret" },
}));
vi.mock("@breatic/shared", async (importOriginal) => ({
  ...(await importOriginal<typeof SharedModule>()),
  readPagesAtIngest,
}));
vi.mock("@server/config/rate-limits.js", () => ({ getRateLimit }));

const { ReadPagesRefused } = await import("@breatic/domain");
const { readPagesFor } = await import("@server/agent/read-pages.js");

const REQUEST: ReadPagesRequest = {
  urls: ["https://a.example/one", "https://b.example/two", "https://c.example/three"],
  deadlineAt: 1_800_000_000_000,
  pageTimeoutMs: 30_000,
  settleMs: 8_000,
  concurrency: 6,
  maxBytes: 20_971_520,
};

const ANSWER: ReadPagesAnswer = {
  pages: [
    { url: "https://a.example/one", status: "ok", httpStatus: 200, finalUrl: "https://a.example/one", title: "One", kind: "html", text: "Body one" },
    { url: "https://b.example/two", status: "unreachable", httpStatus: 404 },
    { url: "https://c.example/three", status: "needs_login", httpStatus: 401 },
  ],
  usage: { wallMs: 4_200, cpuUsec: 1_300_000 },
};

/**
 * The error a read ended with.
 * @param call - The pending read.
 * @returns The error.
 */
async function refusalOf(call: Promise<unknown>): Promise<unknown> {
  return call.then(
    () => {
      throw new Error("expected a refusal");
    },
    (err: unknown) => err,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  checkRateLimit.mockResolvedValue({ allowed: true });
  readPagesAtIngest.mockResolvedValue(ANSWER);
});

describe("readPagesFor", () => {
  it("counts one hit per call on the user's web-fetch key, whatever the number of links", async () => {
    await readPagesFor({ userId: "u1" })(REQUEST);

    expect(getRateLimit).toHaveBeenCalledWith("web-fetch");
    expect(checkRateLimit).toHaveBeenCalledTimes(1);
    expect(checkRateLimit).toHaveBeenCalledWith(REDIS, [{ key: "web-fetch:u1", max: 10, windowSeconds: 60 }]);
  });

  it("sends the request to the ingest Worker with the shared secret and the caller's signal, and answers with what it read", async () => {
    const stop = new AbortController();

    const answer = await readPagesFor({ userId: "u1" })(REQUEST, stop.signal);

    expect(readPagesAtIngest).toHaveBeenCalledTimes(1);
    expect(readPagesAtIngest).toHaveBeenCalledWith("https://ingest.test", "shared-secret", REQUEST, stop.signal);
    expect(answer).toEqual(ANSWER);
    expect(checkRateLimit.mock.invocationCallOrder[0]).toBeLessThan(readPagesAtIngest.mock.invocationCallOrder[0] ?? 0);
  });

  it("counts each user on their own key", async () => {
    await readPagesFor({ userId: "u1" })(REQUEST);
    await readPagesFor({ userId: "u2" })(REQUEST);

    expect(checkRateLimit.mock.calls.map((call) => (call[1] as Array<{ key: string }>)[0]?.key)).toEqual(["web-fetch:u1", "web-fetch:u2"]);
  });

  it("refuses over the limit as rate_limited, logged as a hit, without reaching the Worker", async () => {
    checkRateLimit.mockResolvedValue({ allowed: false, retryAfterSeconds: 42 });

    const err = await refusalOf(readPagesFor({ userId: "u1" })(REQUEST));

    expect(err).toBeInstanceOf(ReadPagesRefused);
    expect((err as InstanceType<typeof ReadPagesRefused>).reason).toBe("rate_limited");
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledWith(expect.objectContaining({ action: "web-fetch", key: "u1" }), "rate_limit_hit");
    expect(readPagesAtIngest).not.toHaveBeenCalled();
  });
});

// Plan §14 rows 7 and 8: domain's web_fetch now answers a failed read with
// pages marked not read, so this is the one place that sees why the read failed.
describe("readPagesFor when the Worker's read fails", () => {
  it("logs web_fetch_read_failed with the error and the user, then throws the same error", async () => {
    const failure = new Error("Asset upload failed (HTTP 502)");
    readPagesAtIngest.mockRejectedValue(failure);

    const err = await refusalOf(readPagesFor({ userId: "u1" })(REQUEST, new AbortController().signal));

    expect(err).toBe(failure);
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledWith(expect.objectContaining({ err: failure, userId: "u1" }), "web_fetch_read_failed");
  });

  it("logs it when no signal was given", async () => {
    readPagesAtIngest.mockRejectedValue(new Error("socket hang up"));

    await refusalOf(readPagesFor({ userId: "u1" })(REQUEST));

    expect(log.warn).toHaveBeenCalledWith(expect.objectContaining({ userId: "u1" }), "web_fetch_read_failed");
  });

  it("does not log a read the caller stopped, and still throws", async () => {
    const stop = new AbortController();
    const aborted = new DOMException("aborted", "AbortError");
    readPagesAtIngest.mockImplementation(async () => {
      stop.abort();
      throw aborted;
    });

    const err = await refusalOf(readPagesFor({ userId: "u1" })(REQUEST, stop.signal));

    expect(err).toBe(aborted);
    expect(log.warn).not.toHaveBeenCalled();
  });
});

describe("the web-fetch limit in config/rate-limits.yaml", () => {
  it("is ten calls per user per sixty seconds", async () => {
    const actual = await vi.importActual<typeof RateLimitsModule>("@server/config/rate-limits.js");
    expect(actual.getRateLimit("web-fetch")).toEqual({ max: 10, windowSeconds: 60 });
  });
});
