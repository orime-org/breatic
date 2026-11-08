// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Asking the ingest Worker's page reader for a set of pages (inner#1664
 * design §6.2).
 *
 * The transport is stubbed the way `ingest-client.test.ts` stubs it for
 * `fetchUrlToIngest`: what is checked is what the transport is told, and how
 * the answer is read. One call starts one container that bills for its run,
 * so it is never sent twice.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ZodError } from "zod";

import { httpRequest } from "@shared/http/request.js";
import { DeadlinePassed } from "@shared/http/deadline.js";
import { INGEST_FAILURE_HEADER } from "@shared/upload/ingest-failure.js";
import { readPagesAtIngest, UploadHttpError } from "@shared/upload/ingest-client.js";
import type { ReadPagesAnswer, ReadPagesRequest } from "@shared/agent/read-pages.js";
import * as sharedEntry from "@shared/index.js";

vi.mock("@shared/http/request.js", () => ({ httpRequest: vi.fn() }));

const mockedRequest = vi.mocked(httpRequest);

const WORKER_URL = "https://ingest.example.com";
const SECRET = "shared-secret";

/**
 * A request whose deadline is `inMs` from now.
 * @param inMs - Time left until the deadline.
 * @returns The request.
 */
function requestDueIn(inMs: number): ReadPagesRequest {
  return {
    urls: ["https://example.com/a", "https://b.org/paper.pdf"],
    deadlineAt: Date.now() + inMs,
    pageTimeoutMs: 30_000,
    settleMs: 8_000,
    concurrency: 6,
    maxBytes: 20_971_520,
  };
}

const ANSWER: ReadPagesAnswer = {
  pages: [
    { url: "https://example.com/a", status: "ok", finalUrl: "https://example.com/a", title: "A", kind: "html", text: "# A" },
    { url: "https://b.org/paper.pdf", status: "too_slow" },
  ],
  usage: { wallMs: 41_700, cpuUsec: 12_345_678 },
};

/**
 * An answer with `body` as its JSON, and the failure it named if any.
 * @param status - The HTTP status.
 * @param body - The JSON body.
 * @param failure - The failure code header, if any.
 * @returns The stub response.
 */
function answers(status: number, body: unknown, failure?: string): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    headers: {
      get: (name: string) => (name === INGEST_FAILURE_HEADER ? (failure ?? null) : null),
    },
  } as unknown as Response;
}

/**
 * The transport options of the first call.
 * @returns The options.
 */
function options(): { replaySafe: boolean; timeoutMs?: number; signal?: AbortSignal } {
  const given = mockedRequest.mock.calls[0]?.[2];
  if (given === undefined) throw new Error("the transport was not called");
  return given;
}

beforeEach(() => {
  mockedRequest.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("readPagesAtIngest", () => {
  it("is exported from the main entry", () => {
    expect(sharedEntry.readPagesAtIngest).toBe(readPagesAtIngest);
  });

  it("posts the request as JSON to the read-pages endpoint with the shared secret", async () => {
    mockedRequest.mockResolvedValueOnce(answers(200, ANSWER));
    const request = requestDueIn(90_000);

    await readPagesAtIngest(WORKER_URL, SECRET, request);

    expect(mockedRequest).toHaveBeenCalledTimes(1);
    expect(String(mockedRequest.mock.calls[0]?.[0])).toBe(`${WORKER_URL}/read-pages`);
    const init = mockedRequest.mock.calls[0]?.[1];
    expect(init?.method).toBe("POST");
    expect(init?.headers).toEqual({ "x-ingest-secret": SECRET, "content-type": "application/json" });
    expect(JSON.parse(String(init?.body))).toEqual(request);
  });

  it("answers what the Worker read, as parsed", async () => {
    mockedRequest.mockResolvedValueOnce(answers(200, ANSWER));

    await expect(readPagesAtIngest(WORKER_URL, SECRET, requestDueIn(90_000))).resolves.toEqual(ANSWER);
  });

  // Each delivery starts a fresh container that bills for its run.
  it("tells the transport that sending it again costs something", async () => {
    mockedRequest.mockResolvedValueOnce(answers(200, ANSWER));

    await readPagesAtIngest(WORKER_URL, SECRET, requestDueIn(90_000));

    expect(options().replaySafe).toBe(false);
  });

  it("delivers once when the Worker answers 5xx, and throws UploadHttpError with the status and code", async () => {
    mockedRequest.mockResolvedValueOnce(answers(502, {}, "store_failed"));

    const read = readPagesAtIngest(WORKER_URL, SECRET, requestDueIn(90_000));

    await expect(read).rejects.toBeInstanceOf(UploadHttpError);
    await expect(read).rejects.toMatchObject({ status: 502, code: "store_failed" });
    expect(mockedRequest).toHaveBeenCalledTimes(1);
  });

  it("throws UploadHttpError carrying the status when the Worker refuses", async () => {
    mockedRequest.mockResolvedValueOnce(answers(400, {}));

    const read = readPagesAtIngest(WORKER_URL, SECRET, requestDueIn(90_000));

    await expect(read).rejects.toBeInstanceOf(UploadHttpError);
    await expect(read).rejects.toMatchObject({ status: 400, code: null });
  });

  it("rejects an answer that does not have the answer's shape", async () => {
    mockedRequest.mockResolvedValueOnce(
      answers(200, { pages: [{ url: "https://example.com/a", status: "maybe" }], usage: { wallMs: 1, cpuUsec: null } }),
    );

    await expect(readPagesAtIngest(WORKER_URL, SECRET, requestDueIn(90_000))).rejects.toBeInstanceOf(ZodError);
  });

  it("rejects an answer without usage", async () => {
    mockedRequest.mockResolvedValueOnce(answers(200, { pages: ANSWER.pages }));

    await expect(readPagesAtIngest(WORKER_URL, SECRET, requestDueIn(90_000))).rejects.toBeInstanceOf(ZodError);
  });

  it("stops the call when the caller's signal is raised", async () => {
    mockedRequest.mockResolvedValueOnce(answers(200, ANSWER));
    const stop = new AbortController();

    await readPagesAtIngest(WORKER_URL, SECRET, requestDueIn(90_000), stop.signal);

    expect(options().signal?.aborted).toBe(false);
    stop.abort();
    expect(options().signal?.aborted).toBe(true);
  });

  it("lets each delivery run until the deadline and no shorter", async () => {
    mockedRequest.mockResolvedValueOnce(answers(200, ANSWER));

    await readPagesAtIngest(WORKER_URL, SECRET, requestDueIn(90_000));

    expect(options().timeoutMs).toBeGreaterThan(89_000);
    expect(options().timeoutMs).toBeLessThanOrEqual(90_000);
  });

  it("raises the call's signal at the deadline, with the caller's signal still down", async () => {
    vi.useFakeTimers();
    mockedRequest.mockResolvedValueOnce(answers(200, ANSWER));
    const stop = new AbortController();

    await readPagesAtIngest(WORKER_URL, SECRET, requestDueIn(90_000), stop.signal);

    expect(options().signal?.aborted).toBe(false);
    vi.advanceTimersByTime(90_000);
    expect(options().signal?.aborted).toBe(true);
    expect(options().signal?.reason).toBeInstanceOf(DeadlinePassed);
    expect(stop.signal.aborted).toBe(false);
  });

  it("sends nothing once the deadline has come", async () => {
    const read = readPagesAtIngest(WORKER_URL, SECRET, requestDueIn(-1));

    await expect(read).rejects.toBeInstanceOf(DeadlinePassed);
    expect(mockedRequest).toHaveBeenCalledTimes(0);
  });
});
