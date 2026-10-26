// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { Aborted, BodyTooLarge, HttpStatus, NoAnswer, NotSent } from "../errors.js";
import { aiSdkFetch, fetchJson, send } from "../request.js";

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((done) => s.close(() => done()))));
});

/**
 * Start a loopback server that answers each request by its arrival number.
 * @param handler - Called with the request, the response and the 1-based request count.
 * @returns The base URL and a counter of requests received.
 */
async function serve(
  handler: (req: IncomingMessage, res: ServerResponse, n: number) => void,
): Promise<{ url: string; count: () => number }> {
  let n = 0;
  const server = createServer((req, res) => handler(req, res, ++n));
  servers.push(server);
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", () => done()));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, count: () => n };
}

/**
 * A loopback port with nothing listening on it.
 * @returns The URL.
 */
async function closedPort(): Promise<string> {
  const { url } = await serve(() => undefined);
  const server = servers.pop()!;
  await new Promise<void>((done) => server.close(() => done()));
  return url;
}

const json = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void => {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
};

const read = { maxBodyBytes: 1_000_000, idleMs: 2_000 };

describe("send — failure classes", () => {
  it("a refused connection is NotSent", async () => {
    const url = await closedPort();
    await expect(send({ url, method: "POST" }, { replaySafe: false })).rejects.toBeInstanceOf(NotSent);
  });

  it("a connection reset after the request arrived is NoAnswer", async () => {
    const { url } = await serve((req) => req.socket.destroy());
    await expect(send({ url, method: "POST", body: "{}" }, { replaySafe: false })).rejects.toBeInstanceOf(NoAnswer);
  });

  it("any status comes back as a Response, not thrown", async () => {
    const { url } = await serve((_req, res) => json(res, 503, { error: "busy" }));
    const response = await send({ url, method: "GET" }, { replaySafe: false });
    expect(response.status).toBe(503);
  });
});

describe("resending (design 2.2)", () => {
  it("replaySafe false never sends twice, even on a 503", async () => {
    const { url, count } = await serve((_req, res) => json(res, 503, {}));
    const error = await fetchJson({ url, method: "POST", body: "{}" }, { replaySafe: false, ...read }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HttpStatus);
    expect((error as HttpStatus).status).toBe(503);
    expect(count()).toBe(1);
  });

  it("replaySafe false never sends twice after a reset", async () => {
    const { url, count } = await serve((req) => req.socket.destroy());
    await expect(fetchJson({ url, method: "POST", body: "{}" }, { replaySafe: false, ...read })).rejects.toBeInstanceOf(NoAnswer);
    expect(count()).toBe(1);
  });

  it("replaySafe true resends a 503 and returns the later success", async () => {
    const { url, count } = await serve((_req, res, n) => (n < 3 ? json(res, 503, {}) : json(res, 200, { ok: true })));
    await expect(fetchJson({ url, method: "GET" }, { replaySafe: true, ...read })).resolves.toEqual({ status: 200, body: { ok: true } });
    expect(count()).toBe(3);
  });

  it("replaySafe true sends at most three times in all", async () => {
    const { url, count } = await serve((_req, res) => json(res, 502, {}));
    await expect(fetchJson({ url, method: "GET" }, { replaySafe: true, ...read })).rejects.toBeInstanceOf(HttpStatus);
    expect(count()).toBe(3);
  });

  it.each([408, 429])("replaySafe true resends a %i", async (status) => {
    const { url, count } = await serve((_req, res, n) => (n === 1 ? json(res, status, {}) : json(res, 200, {})));
    await fetchJson({ url, method: "GET" }, { replaySafe: true, ...read });
    expect(count()).toBe(2);
  });

  it("replaySafe true does not resend a 400", async () => {
    const { url, count } = await serve((_req, res) => json(res, 400, { error: "bad" }));
    await expect(fetchJson({ url, method: "GET" }, { replaySafe: true, ...read })).rejects.toBeInstanceOf(HttpStatus);
    expect(count()).toBe(1);
  });

  it("honours Retry-After before resending", async () => {
    const { url, count } = await serve((_req, res, n) => (n === 1 ? json(res, 429, {}, { "retry-after": "1" }) : json(res, 200, {})));
    const started = Date.now();
    await fetchJson({ url, method: "GET" }, { replaySafe: true, ...read });
    expect(Date.now() - started).toBeGreaterThanOrEqual(950);
    expect(count()).toBe(2);
  });

  it("gives up at once when Retry-After asks for more than 60 seconds", async () => {
    const { url, count } = await serve((_req, res) => json(res, 429, {}, { "retry-after": "120" }));
    const started = Date.now();
    const error = await fetchJson({ url, method: "GET" }, { replaySafe: true, ...read }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HttpStatus);
    expect((error as HttpStatus).retryAfterMs).toBe(120_000);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(count()).toBe(1);
  });
});

describe("abort and deadline", () => {
  it("a deadline already past sends nothing", async () => {
    const { url, count } = await serve((_req, res) => json(res, 200, {}));
    await expect(send({ url, method: "POST" }, { replaySafe: false, deadlineAt: Date.now() - 1 })).rejects.toBeInstanceOf(Aborted);
    expect(count()).toBe(0);
  });

  it("a deadline reached while waiting cuts the request", async () => {
    const { url } = await serve(() => undefined);
    const started = Date.now();
    await expect(send({ url, method: "GET" }, { replaySafe: false, deadlineAt: Date.now() + 300 })).rejects.toBeInstanceOf(Aborted);
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  it("the caller's signal cuts the request", async () => {
    const { url } = await serve(() => undefined);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 200);
    await expect(send({ url, method: "GET" }, { replaySafe: false, signal: controller.signal })).rejects.toBeInstanceOf(Aborted);
  });

  it("an abort during a Retry-After wait stops without resending", async () => {
    const { url, count } = await serve((_req, res) => json(res, 503, {}, { "retry-after": "5" }));
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 300);
    await expect(fetchJson({ url, method: "GET" }, { replaySafe: true, signal: controller.signal, ...read })).rejects.toBeInstanceOf(Aborted);
    expect(count()).toBe(1);
  });
});

describe("reading the body", () => {
  it("a body over the limit is BodyTooLarge", async () => {
    const { url } = await serve((_req, res) => json(res, 200, { blob: "x".repeat(10_000) }));
    await expect(fetchJson({ url, method: "GET" }, { replaySafe: false, maxBodyBytes: 1_000, idleMs: 2_000 })).rejects.toBeInstanceOf(BodyTooLarge);
  });

  it("a body that stops arriving for longer than idleMs is NoAnswer", async () => {
    const { url } = await serve((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.write("{\"a\":");
    });
    await expect(fetchJson({ url, method: "GET" }, { replaySafe: false, maxBodyBytes: 1_000, idleMs: 300 })).rejects.toBeInstanceOf(NoAnswer);
  });

  it("a non-2xx carries the start of its body", async () => {
    const { url } = await serve((_req, res) => json(res, 422, { error: "duration must be 5 or 10" }));
    const error = await fetchJson({ url, method: "POST" }, { replaySafe: false, ...read }).catch((e: unknown) => e) as HttpStatus;
    expect(error.status).toBe(422);
    expect(error.bodySnippet).toContain("duration must be 5 or 10");
  });
});

describe("aiSdkFetch", () => {
  it("returns a 500 as a Response for AI SDK to parse", async () => {
    const { url } = await serve((_req, res) => json(res, 500, { error: { message: "overloaded" } }));
    const response = await aiSdkFetch()(url, { method: "POST", body: "{}" });
    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: { message: "overloaded" } });
  });

  it("throws NotSent for a refused connection", async () => {
    const url = await closedPort();
    await expect(aiSdkFetch()(url, { method: "POST" })).rejects.toBeInstanceOf(NotSent);
  });

  it("never resends: a 503 reaches the server once", async () => {
    const { url, count } = await serve((_req, res) => json(res, 503, {}));
    await aiSdkFetch()(url, { method: "POST", body: "{}" });
    expect(count()).toBe(1);
  });

  it("streams the body without a byte limit", async () => {
    const big = "y".repeat(3_000_000);
    const { url } = await serve((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(big);
    });
    const response = await aiSdkFetch()(url, { method: "POST" });
    await expect(response.text()).resolves.toHaveLength(3_000_000);
  });
});
