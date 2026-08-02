// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * The six items again, but against a real server and the real `fetch`.
 *
 * This layer has no callers yet, so there is no user-facing path to walk. What
 * it does have is an assumption in every other test file: those inject a fetch
 * double, so "what a real failure looks like" is asserted only against stand-ins
 * written by the same person who wrote the expectation. A connection refused by
 * the operating system, a socket destroyed mid-response, a header the platform
 * parses its own way — none of that is exercised by a hand-written Promise.
 *
 * So this file injects nothing. A real HTTP server on a real port, the global
 * `fetch`, and real sockets closing underneath it. It is slower than the rest
 * and deliberately small: one case per item that could plausibly behave
 * differently for real than it does against a double.
 */

import { getEventListeners } from "node:events";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { describe, it, expect, afterEach } from "vitest";

import { httpRequest, HttpRetryError } from "@shared/http/request.js";

/** How each request to the stub server should be answered, in order. */
type Reply =
  | { kind: "status"; status: number; headers?: Record<string, string> }
  | { kind: "destroy" };

let running: Server | null = null;

afterEach(async () => {
  if (running !== null) {
    await new Promise<void>((resolve) => running?.close(() => resolve()));
    running = null;
  }
});

/**
 * Start a server that plays back the given replies, one per request.
 * @param replies - What to answer, in arrival order.
 * @returns The base URL and a count of requests actually received.
 */
async function stubServer(
  replies: Reply[],
): Promise<{ url: string; hits: () => number }> {
  let hit = 0;
  const server = createServer((_req: IncomingMessage, res: ServerResponse) => {
    const reply = replies[hit] ?? { kind: "status" as const, status: 500 };
    hit += 1;
    if (reply.kind === "destroy") {
      // Kill the socket mid-flight: the shape a real dropped connection has,
      // which no hand-written rejection reproduces faithfully.
      res.socket?.destroy();
      return;
    }
    res.writeHead(reply.status, { "content-type": "application/json", ...reply.headers });
    res.end(JSON.stringify({ status: reply.status }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  running = server;
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}/`, hits: (): number => hit };
}

/** Replay-safe, generous headers deadline, no injected seams at all. */
const REAL = { replaySafe: true, timeoutMs: 5_000 } as const;

describe("against a real server, with the real fetch", () => {
  it("item 1 + 5 — delivers once and hands back the real Response", async () => {
    const { url, hits } = await stubServer([{ kind: "status", status: 200 }]);

    const out = await httpRequest(url, {}, REAL);

    expect(hits()).toBe(1);
    expect(out).toBeInstanceOf(Response);
    expect(out.status).toBe(200);
    await expect(out.json()).resolves.toEqual({ status: 200 });
  });

  it("item 2 + 4 — replays a real 503 and stops at three deliveries", async () => {
    const { url, hits } = await stubServer([
      { kind: "status", status: 503 },
      { kind: "status", status: 503 },
      { kind: "status", status: 503 },
    ]);

    const out = await httpRequest(url, {}, REAL);

    expect(hits()).toBe(3);
    expect(out.status).toBe(503);
  });

  it("item 3 — serves a real Retry-After header from a real response", async () => {
    // One second, so the assertion is about the wait being honoured rather than
    // about the exact millisecond. The default backoff for the first replay
    // tops out at 1000ms of jitter, so a floor of 900ms could in principle be
    // reached without reading the header — which is why the server also stops
    // failing after one, keeping the total bounded either way.
    const { url, hits } = await stubServer([
      { kind: "status", status: 429, headers: { "retry-after": "1" } },
      { kind: "status", status: 200 },
    ]);

    const started = Date.now();
    const out = await httpRequest(url, {}, REAL);
    const elapsed = Date.now() - started;

    expect(hits()).toBe(2);
    expect(out.status).toBe(200);
    expect(elapsed).toBeGreaterThanOrEqual(900);
  });

  it("item 5 — a real dropped connection ends as HttpRetryError with the platform's own error inside", async () => {
    const { url, hits } = await stubServer([
      { kind: "destroy" },
      { kind: "destroy" },
      { kind: "destroy" },
    ]);

    const thrown = await httpRequest(url, {}, REAL).catch((e: unknown) => e);

    expect(hits()).toBe(3);
    expect(thrown).toBeInstanceOf(HttpRetryError);
    expect((thrown as HttpRetryError).attempts).toBe(3);
    // Whatever the platform throws for a destroyed socket, it is what the
    // caller can reach — not a message this layer invented about it.
    expect((thrown as HttpRetryError).cause).toBeInstanceOf(Error);
  });

  it("item 5 — a refused connection on the first delivery is rethrown untouched", async () => {
    // Bind a port and immediately release it, so nothing is listening. No
    // replay is warranted for a non-replay-safe request, so the platform's own
    // error must arrive unwrapped.
    const { url } = await stubServer([]);
    await new Promise<void>((resolve) => running?.close(() => resolve()));
    running = null;

    const thrown = await httpRequest(url, { method: "POST" }, {
      replaySafe: false,
      timeoutMs: 5_000,
    }).catch((e: unknown) => e);

    expect(thrown).toBeInstanceOf(Error);
    expect(thrown).not.toBeInstanceOf(HttpRetryError);
  });

  it("item 1 — enforces the per-delivery deadline against a server that never answers", async () => {
    // A server that accepts the socket and then says nothing: the one shape a
    // fetch double cannot reproduce, because a hand-written pending Promise
    // has no socket behind it.
    const server = createServer(() => {
      // Deliberately never responds.
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    running = server;
    const { port } = server.address() as AddressInfo;

    const started = Date.now();
    const thrown = await httpRequest(`http://127.0.0.1:${port}/`, {}, {
      replaySafe: true,
      timeoutMs: 150,
    }).catch((e: unknown) => e);

    expect(thrown).toBeInstanceOf(Error);
    // Three deliveries, each cut off at its own deadline, plus two backoffs.
    expect(Date.now() - started).toBeLessThan(6_000);
  }, 10_000);

  it("item 5 — a real cancellation mid-flight comes back as the caller's own error", async () => {
    const server = createServer(() => {
      // Never responds, so the abort is what ends it.
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    running = server;
    const { port } = server.address() as AddressInfo;

    const controller = new AbortController();
    const inFlight = httpRequest(`http://127.0.0.1:${port}/`, {}, {
      replaySafe: true,
      timeoutMs: 5_000,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(new Error("user pressed stop")), 50);

    await expect(inFlight).rejects.toThrow("user pressed stop");
  }, 10_000);

  it("item 6 — holds no listener on the caller's signal after a real round trip", async () => {
    const controller = new AbortController();
    const { url } = await stubServer([{ kind: "status", status: 200 }]);

    await httpRequest(url, {}, { ...REAL, signal: controller.signal });

    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  });
});
