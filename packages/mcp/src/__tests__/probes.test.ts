// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { redisAnswers, serverAnswers, waitUntilReady } from "@mcp/probes.js";

let server: Server | undefined;
afterEach(() => new Promise<void>((done) => (server ? server.close(() => done()) : done())));

/**
 * An issuer whose metadata path answers with one status.
 * @param status - The status the metadata path answers with.
 * @returns The issuer's origin.
 */
async function issuerAnswering(status: number): Promise<string> {
  server = createServer((req, res) => {
    res.statusCode = req.url === "/.well-known/oauth-authorization-server" ? status : 404;
    res.end("{}");
  });
  await new Promise<void>((done) => server!.listen(0, "127.0.0.1", done));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe("serverAnswers", () => {
  it("is true when the issuer serves its authorization metadata", async () => {
    expect(await serverAnswers(await issuerAnswering(200))()).toBe(true);
  });

  it("is false when the metadata path fails", async () => {
    expect(await serverAnswers(await issuerAnswering(404))()).toBe(false);
  });

  it("throws when nothing listens at the issuer", async () => {
    const origin = await issuerAnswering(200);
    await new Promise<void>((done) => server!.close(() => done()));
    server = undefined;
    await expect(serverAnswers(origin)()).rejects.toThrow();
  });
});

describe("redisAnswers", () => {
  it("is true only on PONG", async () => {
    expect(await redisAnswers({ ping: async () => "PONG" })()).toBe(true);
    expect(await redisAnswers({ ping: async () => "LOADING" })()).toBe(false);
  });
});

describe("waitUntilReady", () => {
  it("asks again until the dependency answers", async () => {
    let calls = 0;
    const ready = await waitUntilReady(async () => {
      calls += 1;
      if (calls < 3) throw new Error("connection refused");
      return true;
    }, { deadlineAt: Date.now() + 5_000, intervalMs: 1 });
    expect([ready, calls]).toEqual([true, 3]);
  });

  it("gives up once the deadline passes, with the last failure", async () => {
    const failure = new Error("connection refused");
    const outcome = await waitUntilReady(async () => {
      throw failure;
    }, { deadlineAt: Date.now() + 30, intervalMs: 5 });
    expect(outcome).toBe(failure);
  });

  it("reports an answer that stays unhealthy as false", async () => {
    expect(await waitUntilReady(async () => false, { deadlineAt: Date.now() + 20, intervalMs: 5 })).toBe(false);
  });
});
