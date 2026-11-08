// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * `POST /read-pages` (inner#1664, design §6.2): only our server may ask the
 * Worker to read pages, the body must be a well-formed request whose every
 * URL is http or https, and each call gets a reader instance of its own.
 *
 * The reader class needs a runtime with containers enabled, which this pool
 * does not have, so the namespace is stood in: what is under test is the
 * route in front of it.
 */

import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import type { ReadPagesAnswer, ReadPagesRequest } from "@breatic/shared";

import worker from "@ingest/index.js";

const REQUEST: ReadPagesRequest = {
  urls: ["https://example.com/a", "http://example.org/b"],
  deadlineAt: Date.now() + 60_000,
  pageTimeoutMs: 20_000,
  settleMs: 8_000,
  concurrency: 6,
  maxBytes: 10_000_000,
};

const ANSWER: ReadPagesAnswer = {
  pages: [
    {
      url: "https://example.com/a",
      status: "ok",
      httpStatus: 200,
      finalUrl: "https://example.com/a",
      title: "A",
      kind: "html",
      text: "# A\n\nBody of A.",
    },
    { url: "http://example.org/b", status: "needs_login", httpStatus: 401 },
  ],
  usage: { wallMs: 4_321, cpuUsec: 987_654 },
};

/** A stand-in for the `WEB_READER` namespace, with what it was asked. */
interface StandInReader {
  namespace: unknown;
  /** The name of each instance taken, in order. */
  names: string[];
  /** Each request an instance's `read` was given. */
  asked: unknown[];
  /** The name of the instance each `stop` was called on, in order. */
  stopped: string[];
}

/**
 * A namespace whose every instance answers `read` with `answer`.
 * @param answer - What each instance answers.
 * @returns The namespace and what it was asked.
 */
function readerAnswering(answer: ReadPagesAnswer): StandInReader {
  const run: StandInReader = { namespace: null, names: [], asked: [], stopped: [] };
  run.namespace = {
    idFromName: (name: string): { name: string } => {
      run.names.push(name);
      return { name };
    },
    get: (id: { name: string }) => ({
      read: (request: unknown): Promise<ReadPagesAnswer> => {
        run.asked.push(request);
        return Promise.resolve(answer);
      },
      stop: (): Promise<void> => {
        run.stopped.push(id.name);
        return Promise.resolve();
      },
    }),
  };
  return run;
}

/**
 * A namespace whose every instance's `read` runs until `stop` is called on
 * that instance, then rejects, as the real reader does once destroyed.
 * @returns The namespace and what it was asked.
 */
function readerUntilStopped(): StandInReader {
  const run: StandInReader = { namespace: null, names: [], asked: [], stopped: [] };
  run.namespace = {
    idFromName: (name: string): { name: string } => {
      run.names.push(name);
      return { name };
    },
    get: (id: { name: string }) => {
      let end: (reason: Error) => void = () => undefined;
      const reading = new Promise<ReadPagesAnswer>((_resolve, reject) => {
        end = reject;
      });
      return {
        read: (request: unknown): Promise<ReadPagesAnswer> => {
          run.asked.push(request);
          return reading;
        },
        stop: (): Promise<void> => {
          run.stopped.push(id.name);
          end(new Error("stopped"));
          return Promise.resolve();
        },
      };
    },
  };
  return run;
}

/**
 * Send one request to `/read-pages`.
 * @param body - The body, sent as is when a string.
 * @param bindings - Overrides on the test env; a value of undefined removes it.
 * @param withSecret - Whether it carries our secret.
 * @param signal - The incoming request's signal, aborted when its caller goes.
 * @returns The response.
 */
async function askToRead(
  body: unknown,
  bindings: Record<string, unknown>,
  withSecret = true,
  signal?: AbortSignal,
): Promise<Response> {
  const merged: Record<string, unknown> = { ...env, ...bindings };
  for (const [key, value] of Object.entries(bindings)) if (value === undefined) delete merged[key];
  const headers = new Headers({ "content-type": "application/json" });
  if (withSecret) headers.set("x-ingest-secret", env.INGEST_SHARED_SECRET);
  const ctx = createExecutionContext();
  const response = await worker.fetch(
    new Request("https://ingest.example.com/read-pages", {
      method: "POST",
      headers,
      body: typeof body === "string" ? body : JSON.stringify(body),
      signal,
    }),
    merged as unknown as typeof env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return response;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe("POST /read-pages", () => {
  it("refuses a caller without our secret before taking an instance", async () => {
    const reader = readerAnswering(ANSWER);

    const response = await askToRead(REQUEST, { WEB_READER: reader.namespace }, false);

    expect(response.status).toBe(401);
    expect(reader.names).toEqual([]);
  });

  it.each([
    ["a body that is not JSON", "{not json"],
    ["a body with no urls", { ...REQUEST, urls: undefined }],
    ["a body with no deadline", { ...REQUEST, deadlineAt: undefined }],
    ["a ftp url", { ...REQUEST, urls: ["https://example.com/a", "ftp://example.com/file"] }],
    ["a file url", { ...REQUEST, urls: ["file:///etc/passwd"] }],
    ["a javascript url", { ...REQUEST, urls: ["javascript:alert(1)"] }],
    ["a data url", { ...REQUEST, urls: ["data:text/html,<p>x</p>"] }],
    ["a url that is not a url", { ...REQUEST, urls: ["example.com/a"] }],
  ])("answers 400 for %s before taking an instance", async (_label, body) => {
    const reader = readerAnswering(ANSWER);

    const response = await askToRead(body, { WEB_READER: reader.namespace });

    expect(response.status).toBe(400);
    expect(reader.names).toEqual([]);
  });

  it("names WEB_READER when the config does not bind it", async () => {
    const response = await askToRead(REQUEST, { WEB_READER: undefined });

    expect(response.status).toBe(500);
    await expect(response.text()).resolves.toContain("WEB_READER");
  });

  it("returns the instance's answer as JSON and hands it the request", async () => {
    const reader = readerAnswering(ANSWER);

    const response = await askToRead(REQUEST, { WEB_READER: reader.namespace });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    await expect(response.json()).resolves.toEqual(ANSWER);
    expect(reader.asked).toEqual([REQUEST]);
  });

  it("takes a fresh instance for every call", async () => {
    const reader = readerAnswering(ANSWER);

    const first = await askToRead(REQUEST, { WEB_READER: reader.namespace });
    const second = await askToRead(REQUEST, { WEB_READER: reader.namespace });

    expect([first.status, second.status]).toEqual([200, 200]);
    expect(reader.names).toHaveLength(2);
    expect(reader.names[0]).toMatch(UUID);
    expect(reader.names[1]).toMatch(UUID);
    expect(reader.names[0]).not.toBe(reader.names[1]);
  });
});

describe("POST /read-pages when its caller goes (design §6.2)", () => {
  it("stops that call's instance exactly once when the request's signal aborts mid-read", async () => {
    const reader = readerUntilStopped();
    const caller = new AbortController();

    const answered = askToRead(REQUEST, { WEB_READER: reader.namespace }, true, caller.signal).then(
      (response) => response.status,
      () => "rejected",
    );
    await vi.waitFor(() => expect(reader.asked).toHaveLength(1));
    caller.abort();
    await vi.waitFor(() => expect(reader.stopped).toHaveLength(1));
    await answered;

    expect(reader.names).toHaveLength(1);
    expect(reader.stopped).toEqual([reader.names[0]]);
  });

  it("never stops the instance of a call that completes", async () => {
    const reader = readerAnswering(ANSWER);

    const response = await askToRead(REQUEST, { WEB_READER: reader.namespace });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(ANSWER);
    expect(reader.stopped).toEqual([]);
  });
});
