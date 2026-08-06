// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Red tests for the connection gate (design §6.3, §6.4).
 *
 * Two hooks, and the second one only works because of what the first one does:
 *
 *   onUpgrade   the only place with the connection's peer address. Decides,
 *               then either normalises the request headers so the decision
 *               travels, or refuses.
 *   onConnect   sees only a standard Request. Reads the normalised identity
 *               and either exempts it or hands it to the throttle to count.
 *
 * The refusal shape is measured, not assumed — see
 * inner/engineering/demo/2026-08-05-onupgrade-reject-semantics.mjs. Rejecting
 * with a truthy error leaves the socket open AND produces an unhandled
 * rejection, which collab's own handler turns into process.exit(1). All three
 * assertions below exist to stop that from ever being written.
 */

import { describe, it, expect, vi } from "vitest";
import type { IncomingMessage } from "node:http";
import { createConnectionGate } from "@collab/infra/connection-gate.js";

/** A socket that records what the gate did to it. */
function fakeSocket() {
  return {
    written: [] as string[],
    destroyed: false,
    write(chunk: string) {
      this.written.push(chunk);
      return true;
    },
    destroy() {
      this.destroyed = true;
    },
  };
}

/** A node request carrying the given headers and peer address. */
function fakeUpgradeRequest(
  headers: Record<string, string | string[]>,
  remoteAddress: string | undefined,
) {
  return {
    request: { headers } as unknown as IncomingMessage,
    socket: { remoteAddress, ...fakeSocket() },
    head: Buffer.alloc(0),
  };
}

/** A throttle stand-in so the gate's delegation is observable. */
function fakeThrottle() {
  const seen: unknown[] = [];
  return {
    seen,
    onConnect: vi.fn(async (data: unknown) => {
      seen.push(data);
    }),
    onDestroy: vi.fn(async () => {}),
  };
}

/** An onConnect payload carrying the given (already normalised) headers. */
function connectPayload(headers: Record<string, string>) {
  return { request: { headers: new Headers(headers) } };
}

describe("connection gate — onUpgrade", () => {
  it("normalises x-real-ip to the peer address for a loopback peer", async () => {
    const gate = createConnectionGate(
      { throttle: 15, banTime: 5 },
      { throttle: fakeThrottle() },
    );
    const payload = fakeUpgradeRequest({}, "::1");

    await gate.onUpgrade(payload);

    expect(payload.request.headers["x-real-ip"]).toBe("::1");
    expect(payload.socket.destroyed).toBe(false);
    expect(payload.socket.written).toEqual([]);
  });

  it("overwrites a header a loopback peer tried to supply itself", async () => {
    const gate = createConnectionGate(
      { throttle: 15, banTime: 5 },
      { throttle: fakeThrottle() },
    );
    const payload = fakeUpgradeRequest({ "x-real-ip": "9.9.9.9" }, "127.0.0.1");

    await gate.onUpgrade(payload);

    expect(payload.request.headers["x-real-ip"]).toBe("127.0.0.1");
  });

  it("leaves the proxy's x-real-ip alone for a non-loopback peer", async () => {
    const gate = createConnectionGate(
      { throttle: 15, banTime: 5 },
      { throttle: fakeThrottle() },
    );
    const payload = fakeUpgradeRequest(
      { "x-real-ip": "203.0.113.9" },
      "172.18.0.4",
    );

    await gate.onUpgrade(payload);

    expect(payload.request.headers["x-real-ip"]).toBe("203.0.113.9");
    expect(payload.socket.destroyed).toBe(false);
  });

  it("always strips x-forwarded-for so nothing downstream can fall back to it", async () => {
    const gate = createConnectionGate(
      { throttle: 15, banTime: 5 },
      { throttle: fakeThrottle() },
    );
    const payload = fakeUpgradeRequest(
      { "x-real-ip": "203.0.113.9", "x-forwarded-for": "1.2.3.4, 5.6.7.8" },
      "172.18.0.4",
    );

    await gate.onUpgrade(payload);

    expect(payload.request.headers["x-forwarded-for"]).toBeUndefined();
  });

  it("refuses a non-loopback peer with no x-real-ip: 403, socket closed, no truthy throw", async () => {
    const gate = createConnectionGate(
      { throttle: 15, banTime: 5 },
      { throttle: fakeThrottle() },
    );
    const payload = fakeUpgradeRequest({}, "203.0.113.9");

    let thrown: unknown = "not-thrown";
    try {
      await gate.onUpgrade(payload);
    } catch (err) {
      thrown = err;
    }

    // 1. the client is told why, rather than being left to time out
    expect(payload.socket.written.join("")).toContain("403");
    // 2. the socket is actually released
    expect(payload.socket.destroyed).toBe(true);
    // 3. the rejection value is falsy, so hocuspocus's `if (error) throw error`
    //    swallows it and skips the upgrade instead of killing the process
    expect(thrown).toBeFalsy();
    expect(thrown).not.toBe("not-thrown");
  });

  it("refuses when the peer address is unavailable", async () => {
    const gate = createConnectionGate(
      { throttle: 15, banTime: 5 },
      { throttle: fakeThrottle() },
    );
    const payload = fakeUpgradeRequest({ "x-real-ip": "203.0.113.9" }, undefined);

    let thrown: unknown = "not-thrown";
    try {
      await gate.onUpgrade(payload);
    } catch (err) {
      thrown = err;
    }

    expect(payload.socket.destroyed).toBe(true);
    expect(thrown).toBeFalsy();
    expect(thrown).not.toBe("not-thrown");
  });
});

describe("connection gate — onConnect", () => {
  it("exempts a loopback identity without counting it", async () => {
    const throttle = fakeThrottle();
    const gate = createConnectionGate({ throttle: 15, banTime: 5 }, { throttle });

    await gate.onConnect(connectPayload({ "x-real-ip": "::1" }));

    expect(throttle.onConnect).not.toHaveBeenCalled();
  });

  it("hands a real identity to the throttle to count", async () => {
    const throttle = fakeThrottle();
    const gate = createConnectionGate({ throttle: 15, banTime: 5 }, { throttle });

    await gate.onConnect(connectPayload({ "x-real-ip": "203.0.113.9" }));

    expect(throttle.onConnect).toHaveBeenCalledTimes(1);
  });

  it("never looks at x-forwarded-for", async () => {
    const throttle = fakeThrottle();
    const gate = createConnectionGate({ throttle: 15, banTime: 5 }, { throttle });

    // A request that only carries x-forwarded-for must NOT be treated as
    // loopback-exempt just because that header says so.
    await gate.onConnect(connectPayload({ "x-real-ip": "203.0.113.9", "x-forwarded-for": "::1" }));

    expect(throttle.onConnect).toHaveBeenCalledTimes(1);
  });

  it("forwards shutdown to the throttle", async () => {
    const throttle = fakeThrottle();
    const gate = createConnectionGate({ throttle: 15, banTime: 5 }, { throttle });

    await gate.onDestroy();

    expect(throttle.onDestroy).toHaveBeenCalledTimes(1);
  });
});
