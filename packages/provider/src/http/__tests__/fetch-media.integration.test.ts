// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Aborted } from "../errors.js";
import { fetchMedia, MediaRefused } from "../fetch-media.js";

// The loopback test servers stand in for public hosts; the two addresses the
// cases name as forbidden are judged private.
vi.mock("../private-address.js", () => ({
  reachable: (url: string) => Promise.resolve(!/\/\/(169\.254\.169\.254|10\.0\.0\.5)[:/]/.test(url)),
}));

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((done) => s.close(() => done()))));
});

/**
 * Start a loopback server.
 * @param handler - Called with the request, the response and the 1-based request count.
 * @returns The base URL and a counter of requests received.
 */
async function serve(handler: (req: IncomingMessage, res: ServerResponse, n: number) => void): Promise<{ url: string; count: () => number }> {
  let n = 0;
  const server = createServer((req, res) => handler(req, res, ++n));
  servers.push(server);
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", () => done()));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, count: () => n };
}

const png = (res: ServerResponse, bytes: Uint8Array): void => {
  res.writeHead(200, { "content-type": "image/png" });
  res.end(Buffer.from(bytes));
};

const limits = (): { maxBytes: number; deadlineAt: number } => ({ maxBytes: 1_000, deadlineAt: Date.now() + 10_000 });

describe("fetchMedia (design 3.1, Z5)", () => {
  it("answers the bytes and the declared type", async () => {
    const { url } = await serve((_req, res) => png(res, new Uint8Array([1, 2, 3])));
    const media = await fetchMedia({ url: `${url}/a.png`, ...limits() });
    expect([...media.bytes]).toEqual([1, 2, 3]);
    expect(media.contentType).toBe("image/png");
  });

  it("refuses a first address that is not public without sending anything", async () => {
    await expect(fetchMedia({ url: "http://169.254.169.254/x.png", ...limits() })).rejects.toMatchObject({ kind: "unreachable" });
  });

  it("judges the address a redirect names before going there", async () => {
    const { url, count } = await serve((_req, res) => {
      res.writeHead(302, { location: "http://169.254.169.254/x.png" });
      res.end();
    });
    const error = await fetchMedia({ url: `${url}/a.png`, ...limits() }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MediaRefused);
    expect((error as MediaRefused).kind).toBe("unreachable");
    expect(count()).toBe(1);
  });

  it("follows a redirect to an address that is public", async () => {
    const { url } = await serve((req, res) => {
      if (req.url === "/a.png") {
        res.writeHead(302, { location: "/b.png" });
        res.end();
      } else png(res, new Uint8Array([9]));
    });
    await expect(fetchMedia({ url: `${url}/a.png`, ...limits() })).resolves.toMatchObject({ contentType: "image/png" });
  });

  it("gives up after ten redirects", async () => {
    const { url } = await serve((req, res) => {
      res.writeHead(302, { location: `/${Number(req.url?.slice(1) ?? 0) + 1}` });
      res.end();
    });
    await expect(fetchMedia({ url: `${url}/0`, ...limits() })).rejects.toMatchObject({ kind: "unreachable" });
  });

  it("refuses a body over the byte limit", async () => {
    const { url } = await serve((_req, res) => png(res, new Uint8Array(5_000)));
    await expect(fetchMedia({ url: `${url}/a.png`, ...limits() })).rejects.toMatchObject({ kind: "too_large" });
  });

  it("refuses an address that answers non-2xx, keeping the status", async () => {
    const { url } = await serve((_req, res) => {
      res.writeHead(404);
      res.end();
    });
    await expect(fetchMedia({ url: `${url}/a.png`, ...limits() })).rejects.toMatchObject({ kind: "unavailable", status: 404 });
  });

  it("is cut at the deadline", async () => {
    const { url } = await serve(() => undefined);
    const started = Date.now();
    await expect(fetchMedia({ url: `${url}/a.png`, maxBytes: 1_000, deadlineAt: Date.now() + 300 })).rejects.toBeInstanceOf(Aborted);
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  it("refuses an address that answers an empty body, before any model is paid to read it (DD 33)", async () => {
    const { url } = await serve((_req, res) => png(res, new Uint8Array()));
    await expect(fetchMedia({ url: `${url}/a.png`, ...limits() })).rejects.toMatchObject({ kind: "empty" });
  });
});
