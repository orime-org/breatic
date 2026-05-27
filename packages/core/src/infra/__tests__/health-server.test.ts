/**
 * Invariant tests for the `startHealthServer` utility.
 *
 * Pins the load-balancer contract that the CLAUDE.md
 * "服务器端工业级标准" mandate relies on:
 *
 * - all-checks-ok → 200 + `{status:'ok', checks:{...ok:true}}`
 * - any-check-fail → 503 + `{status:'fail', checks:{...}}` (the
 *   LB must see 5xx, not 200, otherwise it never kills the
 *   instance and we lose the auto-self-heal that the long-running
 *   collab drift investigation specifically needs)
 * - per-check timeout (`CHECK_TIMEOUT_MS = 2000`) catches stuck
 *   probes so a hung dependency doesn't pile up handler queues
 * - unknown path → 404 (keeps the surface area tiny;
 *   no /metrics on this server by design)
 */

import { describe, it, expect, vi } from "vitest";

vi.mock("../../logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { startHealthServer } from "../health-server.js";
import type { AddressInfo } from "node:net";

async function fetchJson(port: number, path: string) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`);
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { status: res.status, body };
}

function pickPort(): number {
  // 0 → kernel assigns; we listen then ask AddressInfo for the
  // real port. Avoids cross-test port collisions in CI.
  return 0;
}

describe("startHealthServer", () => {
  it("returns 200 + status=ok when every check resolves truthy", async () => {
    const { server, stop } = startHealthServer({
      port: pickPort(),
      serviceName: "test",
      checks: [
        { name: "pg", check: async () => true },
        { name: "redis", check: async () => true },
      ],
    });
    await new Promise((r) => server.once("listening", r));
    const port = (server.address() as AddressInfo).port;
    const { status, body } = await fetchJson(port, "/healthz");
    expect(status).toBe(200);
    expect(body).toMatchObject({
      status: "ok",
      service: "test",
      checks: {
        pg: { ok: true },
        redis: { ok: true },
      },
    });
    await stop();
  });

  it("returns 503 + status=fail when any check resolves falsy", async () => {
    const { server, stop } = startHealthServer({
      port: pickPort(),
      serviceName: "test",
      checks: [
        { name: "pg", check: async () => true },
        { name: "redis", check: async () => false },
      ],
    });
    await new Promise((r) => server.once("listening", r));
    const port = (server.address() as AddressInfo).port;
    const { status, body } = await fetchJson(port, "/healthz");
    expect(status).toBe(503);
    expect(body).toMatchObject({
      status: "fail",
      checks: { redis: { ok: false } },
    });
    await stop();
  });

  it("returns 503 + per-check timeout when a check hangs past the timeout window", async () => {
    const { server, stop } = startHealthServer({
      port: pickPort(),
      serviceName: "test",
      checks: [
        {
          name: "hanging",
          check: () => new Promise(() => undefined),
        },
      ],
    });
    await new Promise((r) => server.once("listening", r));
    const port = (server.address() as AddressInfo).port;
    const { status, body } = await fetchJson(port, "/healthz");
    expect(status).toBe(503);
    expect(body).toMatchObject({
      status: "fail",
      checks: {
        hanging: {
          ok: false,
          error: expect.stringMatching(/timeout/),
        },
      },
    });
    await stop();
  }, 5000);

  it("returns 503 + error tag when a check throws", async () => {
    const { server, stop } = startHealthServer({
      port: pickPort(),
      serviceName: "test",
      checks: [
        {
          name: "throws",
          check: async () => {
            throw new Error("Connection is closed.");
          },
        },
      ],
    });
    await new Promise((r) => server.once("listening", r));
    const port = (server.address() as AddressInfo).port;
    const { status, body } = await fetchJson(port, "/healthz");
    expect(status).toBe(503);
    expect(body).toMatchObject({
      status: "fail",
      checks: {
        throws: {
          ok: false,
          error: "Connection is closed.",
        },
      },
    });
    await stop();
  });

  it("returns 404 for unknown paths (keeps surface area minimal)", async () => {
    const { server, stop } = startHealthServer({
      port: pickPort(),
      serviceName: "test",
      checks: [{ name: "pg", check: async () => true }],
    });
    await new Promise((r) => server.once("listening", r));
    const port = (server.address() as AddressInfo).port;
    const res = await fetch(`http://127.0.0.1:${port}/metrics`);
    expect(res.status).toBe(404);
    await stop();
  });
});
