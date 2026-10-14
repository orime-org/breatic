// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

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
 * The refusal shape was measured against the library, not assumed. Rejecting
 * with a truthy error leaves the socket open AND produces an unhandled
 * rejection, which collab's own handler turns into process.exit(1). All three
 * assertions below exist to stop that from ever being written.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { IncomingMessage } from "node:http";

const { loggerWarnMock } = vi.hoisted(() => ({ loggerWarnMock: vi.fn() }));

vi.mock("@breatic/core", () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: loggerWarnMock,
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import { createConnectionGate } from "@collab/infra/connection-gate.js";

beforeEach(() => {
  loggerWarnMock.mockClear();
});

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
  return vi.fn(async (_identity: string) => {});
}

/** An onConnect payload carrying the given (already normalised) headers. */
function connectPayload(headers: Record<string, string>) {
  return { request: { headers: new Headers(headers) } };
}

describe("connection gate — onUpgrade", () => {
  it("normalises x-real-ip to the peer address for a loopback peer", async () => {
    const gate = createConnectionGate(fakeThrottle());
    const payload = fakeUpgradeRequest({}, "::1");

    await gate.onUpgrade(payload);

    expect(payload.request.headers["x-real-ip"]).toBe("::1");
    expect(payload.socket.destroyed).toBe(false);
    expect(payload.socket.written).toEqual([]);
  });

  it("overwrites a header a loopback peer tried to supply itself", async () => {
    const gate = createConnectionGate(fakeThrottle());
    const payload = fakeUpgradeRequest({ "x-real-ip": "9.9.9.9" }, "127.0.0.1");

    await gate.onUpgrade(payload);

    expect(payload.request.headers["x-real-ip"]).toBe("127.0.0.1");
  });

  it("leaves the proxy's x-real-ip alone for a non-loopback peer", async () => {
    const gate = createConnectionGate(fakeThrottle());
    const payload = fakeUpgradeRequest(
      { "x-real-ip": "203.0.113.9" },
      "172.18.0.4",
    );

    await gate.onUpgrade(payload);

    expect(payload.request.headers["x-real-ip"]).toBe("203.0.113.9");
    expect(payload.socket.destroyed).toBe(false);
  });

  it("always strips x-forwarded-for so nothing downstream can fall back to it", async () => {
    const gate = createConnectionGate(fakeThrottle());
    const payload = fakeUpgradeRequest(
      { "x-real-ip": "203.0.113.9", "x-forwarded-for": "1.2.3.4, 5.6.7.8" },
      "172.18.0.4",
    );

    await gate.onUpgrade(payload);

    expect(payload.request.headers["x-forwarded-for"]).toBeUndefined();
  });

  it("refuses a non-loopback peer with no x-real-ip: 403, socket closed, no truthy throw", async () => {
    const gate = createConnectionGate(fakeThrottle());
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
    const gate = createConnectionGate(fakeThrottle());
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

describe("connection gate — the verdict travels, not just the identity", () => {
  // The gate decides from the peer address, which is the only fact a client
  // cannot choose. If `onConnect` re-derives that decision from the identity
  // string instead of being told it, then a peer that is not loopback buys a
  // full exemption by claiming to be one — the exact inversion of the rule.
  // Worse without any attacker: put an edge proxy in front of nginx and
  // nginx's own `proxy_set_header X-Real-IP $remote_addr` starts saying
  // 127.0.0.1 for everyone, which would silently disable rate limiting.

  /** Upgrade with the given peer and headers, then connect, and report. */
  async function arrive(
    peerAddress: string,
    headers: Record<string, string>,
  ): Promise<{ throttled: boolean }> {
    const throttle = fakeThrottle();
    const gate = createConnectionGate(throttle);
    const upgrade = fakeUpgradeRequest(headers, peerAddress);
    await gate.onUpgrade(upgrade);
    await gate.onConnect({
      request: {
        headers: new Headers(upgrade.request.headers as Record<string, string>),
      },
    });
    return { throttled: throttle.mock.calls.length > 0 };
  }

  it("counts a real client that claims to be loopback", async () => {
    expect(await arrive("203.0.113.9", { "x-real-ip": "127.0.0.1" })).toEqual({
      throttled: true,
    });
  });

  it("counts a real client that claims to be the IPv6 loopback", async () => {
    expect(await arrive("203.0.113.9", { "x-real-ip": "::1" })).toEqual({
      throttled: true,
    });
  });

  it("still exempts a genuine loopback peer", async () => {
    expect(await arrive("127.0.0.1", {})).toEqual({ throttled: false });
  });

  it("still counts a real client behind the proxy", async () => {
    expect(await arrive("172.18.0.4", { "x-real-ip": "198.51.100.7" })).toEqual({
      throttled: true,
    });
  });
});

describe("connection gate — what a refusal leaves behind", () => {
  // A refused upgrade is the one outcome nothing downstream can report: the
  // socket is gone before any document, hook or request handler exists, so
  // the gate is the only place that will ever know it happened. Without a
  // line here, "nobody can connect" and "everything is fine" look identical
  // from the logs.

  /** Read the structured context of the single warning the gate emitted. */
  function refusalContext(): Record<string, unknown> {
    expect(loggerWarnMock).toHaveBeenCalledTimes(1);
    return loggerWarnMock.mock.calls[0]?.[0] as Record<string, unknown>;
  }

  /** Read the message of the single warning the gate emitted. */
  function refusalMessage(): string {
    return loggerWarnMock.mock.calls[0]?.[1] as string;
  }

  /** Drive one refusal, swallowing the falsy rejection it aborts with. */
  async function refuse(
    headers: Record<string, string>,
    remoteAddress: string | undefined,
  ): Promise<void> {
    const gate = createConnectionGate(fakeThrottle());
    try {
      await gate.onUpgrade(fakeUpgradeRequest(headers, remoteAddress));
    } catch {
      // The refusal path always aborts; the assertions are on the log.
    }
  }

  it("records the peer and the reason when a direct connection has no proxy header", async () => {
    await refuse({}, "203.0.113.9");

    expect(refusalMessage()).toBe("collab_upgrade_refused");
    expect(refusalContext()).toMatchObject({
      reason: "missing-real-ip",
      peerAddress: "203.0.113.9",
    });
  });

  it("records the reason when the peer address is unavailable", async () => {
    await refuse({ "x-real-ip": "203.0.113.9" }, undefined);

    expect(refusalMessage()).toBe("collab_upgrade_refused");
    expect(refusalContext()).toMatchObject({ reason: "no-peer-address" });
  });

  it("never claims an identity the client supplied when it refuses", async () => {
    // The refusal happens precisely because that header cannot be trusted, so
    // logging it as the peer would put an attacker-chosen string where an
    // operator reads the source of the traffic.
    await refuse({ "x-real-ip": "9.9.9.9" }, undefined);

    expect(refusalContext()).not.toMatchObject({ peerAddress: "9.9.9.9" });
  });

  it("stays silent when a connection is allowed through", async () => {
    const gate = createConnectionGate(fakeThrottle());

    await gate.onUpgrade(fakeUpgradeRequest({ "x-real-ip": "203.0.113.9" }, "172.18.0.4"));

    expect(loggerWarnMock).not.toHaveBeenCalled();
  });
});

describe("connection gate — onConnect", () => {
  it("exempts a peer the upgrade judged loopback, without counting it", async () => {
    // Driven through the upgrade because that is the only place the peer
    // address exists. Handing `onConnect` a loopback-looking identity
    // directly would assert the contract this gate deliberately does not
    // have: the identity is what the throttle counts by, never what decides
    // whether to count.
    const throttle = fakeThrottle();
    const gate = createConnectionGate(throttle);
    const upgrade = fakeUpgradeRequest({}, "::1");
    await gate.onUpgrade(upgrade);

    await gate.onConnect(connectPayload(upgrade.request.headers as Record<string, string>));

    expect(throttle).not.toHaveBeenCalled();
  });

  it("hands a real identity to the throttle to count", async () => {
    const throttle = fakeThrottle();
    const gate = createConnectionGate(throttle);

    await gate.onConnect(connectPayload({ "x-real-ip": "203.0.113.9" }));

    expect(throttle).toHaveBeenCalledExactlyOnceWith("203.0.113.9");
  });

  it("never looks at x-forwarded-for", async () => {
    const throttle = fakeThrottle();
    const gate = createConnectionGate(throttle);

    // A request that only carries x-forwarded-for must NOT be treated as
    // loopback-exempt just because that header says so.
    await gate.onConnect(connectPayload({ "x-real-ip": "203.0.113.9", "x-forwarded-for": "::1" }));

    expect(throttle).toHaveBeenCalledExactlyOnceWith("203.0.113.9");
  });
});
