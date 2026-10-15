// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Tests for the connection gate (inner#1140).
 *
 *   onUpgrade        the only place with the connection's peer address. Decides,
 *                    then refuses, exempts, or counts the new WebSocket against
 *                    its address and refuses it with 429 when the address is over.
 *   onConnect        runs per document. Counts nothing; refuses a document on a
 *                    socket whose address is banned, before any session or role
 *                    lookup runs.
 *   recordFailedAuth counts a failed authentication against the address once per
 *                    WebSocket, however many documents on it fail.
 *
 * The refusal shape was measured against the library, not assumed. Rejecting
 * with a truthy error leaves the socket open AND produces an unhandled
 * rejection, which collab's own handler turns into process.exit(1).
 */

import { EventEmitter } from "node:events";
import type * as CoreModule from "@breatic/core";
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { IncomingMessage } from "node:http";

const { loggerWarnMock } = vi.hoisted(() => ({ loggerWarnMock: vi.fn() }));

vi.mock("@breatic/core", async (importOriginal) => ({
  decideClientIdentity: (await importOriginal<typeof CoreModule>()).decideClientIdentity,
  createLogger: () => ({
    info: vi.fn(),
    warn: loggerWarnMock,
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import { createConnectionGate, recordingFailedAuth } from "@collab/infra/connection-gate.js";

beforeEach(() => {
  loggerWarnMock.mockClear();
});

/** A socket that records what the gate did to it, with real listener bookkeeping. */
function fakeSocket() {
  const socket = Object.assign(new EventEmitter(), {
    written: [] as string[],
    destroyed: false,
    write(chunk: string) {
      socket.written.push(chunk);
      return true;
    },
    destroy() {
      socket.destroyed = true;
    },
  });
  return socket;
}

/** A node request carrying the given headers and peer address. */
function fakeUpgradeRequest(
  headers: Record<string, string | string[]>,
  remoteAddress: string | undefined,
) {
  return {
    request: { headers } as unknown as IncomingMessage,
    socket: Object.assign(fakeSocket(), { remoteAddress }),
    head: Buffer.alloc(0),
  };
}

/**
 * A throttle stand-in so the gate's delegation is observable.
 * @param over - Whether counting reports the address as over the limit.
 * @param banned - Whether the address is currently banned.
 */
function fakeThrottle(over = false, banned = false) {
  return {
    count: vi.fn(async (_identity: string) => !over),
    isBanned: vi.fn(async (_identity: string) => banned),
  };
}

/** An onConnect payload carrying the given (already normalised) headers. */
function connectPayload(headers: Record<string, string>) {
  return { request: { headers: new Headers(headers) } };
}

/**
 * Run an upgrade and report how it ended.
 * @returns The value it rejected with, or "resolved".
 */
async function settle(promise: Promise<void>): Promise<unknown> {
  try {
    await promise;
    return "resolved";
  } catch (err) {
    return err;
  }
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
  // cannot choose. A later hook re-deriving that decision from the identity
  // string would let a peer that is not loopback buy a full exemption by
  // claiming to be one.

  /** Upgrade with the given peer and headers, and report whether it was counted. */
  async function arrive(
    peerAddress: string,
    headers: Record<string, string>,
  ): Promise<{ counted: boolean }> {
    const throttle = fakeThrottle();
    const gate = createConnectionGate(throttle);
    await gate.onUpgrade(fakeUpgradeRequest(headers, peerAddress));
    return { counted: throttle.count.mock.calls.length > 0 };
  }

  it("counts a real client that claims to be loopback", async () => {
    expect(await arrive("203.0.113.9", { "x-real-ip": "127.0.0.1" })).toEqual({ counted: true });
  });

  it("counts a real client that claims to be the IPv6 loopback", async () => {
    expect(await arrive("203.0.113.9", { "x-real-ip": "::1" })).toEqual({ counted: true });
  });

  it("still exempts a genuine loopback peer", async () => {
    expect(await arrive("127.0.0.1", {})).toEqual({ counted: false });
  });

  it("still counts a real client behind the proxy", async () => {
    expect(await arrive("172.18.0.4", { "x-real-ip": "198.51.100.7" })).toEqual({ counted: true });
  });
});

describe("connection gate — counting WebSockets in onUpgrade", () => {
  it("counts one WebSocket once, under the address the proxy wrote", async () => {
    const throttle = fakeThrottle();
    const gate = createConnectionGate(throttle);

    await gate.onUpgrade(fakeUpgradeRequest({ "x-real-ip": "203.0.113.9" }, "172.18.0.4"));

    expect(throttle.count).toHaveBeenCalledExactlyOnceWith("203.0.113.9");
  });

  it("refuses an address over the limit: 429, socket released, falsy rejection, logged", async () => {
    const gate = createConnectionGate(fakeThrottle(true));
    const payload = fakeUpgradeRequest({ "x-real-ip": "203.0.113.9" }, "172.18.0.4");

    const thrown = await settle(gate.onUpgrade(payload));

    expect(payload.socket.written.join("")).toContain("429");
    expect(payload.socket.destroyed).toBe(true);
    expect(thrown).toBeFalsy();
    expect(thrown).not.toBe("resolved");
    expect(loggerWarnMock).toHaveBeenCalledWith(
      expect.objectContaining({ identity: "203.0.113.9" }),
      "collab_upgrade_throttled",
    );
  });

  it("holds an error listener on the raw socket while counting and removes it after", async () => {
    let listenersWhileCounting = -1;
    const payload = fakeUpgradeRequest({ "x-real-ip": "203.0.113.9" }, "172.18.0.4");
    const gate = createConnectionGate({
      isBanned: vi.fn(async () => false),
      count: vi.fn(async () => {
        listenersWhileCounting = payload.socket.listenerCount("error");
        return true;
      }),
    });

    await gate.onUpgrade(payload);

    expect(listenersWhileCounting).toBe(1);
    expect(payload.socket.listenerCount("error")).toBe(0);
  });

  it("survives the client resetting the connection while counting", async () => {
    const payload = fakeUpgradeRequest({ "x-real-ip": "203.0.113.9" }, "172.18.0.4");
    const gate = createConnectionGate({
      isBanned: vi.fn(async () => false),
      count: vi.fn(async () => {
        payload.socket.emit("error", Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }));
        return true;
      }),
    });

    await settle(gate.onUpgrade(payload));

    expect(payload.socket.destroyed).toBe(true);
  });

  it("does not count a loopback peer", async () => {
    const throttle = fakeThrottle();
    const gate = createConnectionGate(throttle);

    await gate.onUpgrade(fakeUpgradeRequest({}, "::1"));

    expect(throttle.count).not.toHaveBeenCalled();
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
  it("lets a document through when its address is not banned, without counting", async () => {
    const throttle = fakeThrottle();
    const gate = createConnectionGate(throttle);

    expect(await settle(gate.onConnect(connectPayload({ "x-real-ip": "203.0.113.9" })))).toBe("resolved");
    expect(throttle.isBanned).toHaveBeenCalledExactlyOnceWith("203.0.113.9");
    expect(throttle.count).not.toHaveBeenCalled();
  });

  it("refuses a document on a banned address with a falsy rejection", async () => {
    const gate = createConnectionGate(fakeThrottle(false, true));

    const thrown = await settle(gate.onConnect(connectPayload({ "x-real-ip": "203.0.113.9" })));

    expect(thrown).toBeFalsy();
    expect(thrown).not.toBe("resolved");
  });

  it("does not look up a ban for a peer the upgrade judged loopback", async () => {
    const throttle = fakeThrottle(false, true);
    const gate = createConnectionGate(throttle);
    const upgrade = fakeUpgradeRequest({}, "::1");
    await gate.onUpgrade(upgrade);

    expect(
      await settle(gate.onConnect(connectPayload(upgrade.request.headers as Record<string, string>))),
    ).toBe("resolved");
    expect(throttle.isBanned).not.toHaveBeenCalled();
  });
});

describe("connection gate — failed authentication", () => {
  it("counts a failed authentication once per WebSocket, however many documents fail", async () => {
    const throttle = fakeThrottle();
    const gate = createConnectionGate(throttle);
    const request = { headers: new Headers({ "x-real-ip": "203.0.113.9" }) };

    for (let i = 0; i < 201; i += 1) await gate.recordFailedAuth({ request });

    expect(throttle.count).toHaveBeenCalledExactlyOnceWith("203.0.113.9");
  });

  it("keeps counting a WebSocket that goes on failing past a full project", async () => {
    // One socket carries at most a full project (MAX_SPACES_PER_PROJECT + 1
    // documents), so failures beyond that are repeated attempts, and each one
    // counts toward the ban.
    const throttle = fakeThrottle();
    const gate = createConnectionGate(throttle);
    const request = { headers: new Headers({ "x-real-ip": "203.0.113.9" }) };

    for (let i = 0; i < 210; i += 1) await gate.recordFailedAuth({ request });

    expect(throttle.count).toHaveBeenCalledTimes(1 + 9);
  });

  it("counts failures on two WebSockets separately", async () => {
    const throttle = fakeThrottle();
    const gate = createConnectionGate(throttle);

    await gate.recordFailedAuth({ request: { headers: new Headers({ "x-real-ip": "203.0.113.9" }) } });
    await gate.recordFailedAuth({ request: { headers: new Headers({ "x-real-ip": "203.0.113.9" }) } });

    expect(throttle.count).toHaveBeenCalledTimes(2);
  });

  it("does not count a failure on a peer the upgrade judged loopback", async () => {
    const throttle = fakeThrottle();
    const gate = createConnectionGate(throttle);
    const upgrade = fakeUpgradeRequest({}, "::1");
    await gate.onUpgrade(upgrade);

    await gate.recordFailedAuth(connectPayload(upgrade.request.headers as Record<string, string>));

    expect(throttle.count).not.toHaveBeenCalled();
  });
});

describe("recordingFailedAuth", () => {
  it("records a rejected authentication with the gate and rethrows the same rejection", async () => {
    const gate = { recordFailedAuth: vi.fn(async () => undefined) };
    const rejection = new Error("session_not_found");
    const onAuthenticate = recordingFailedAuth(async () => {
      throw rejection;
    }, gate);
    const payload = { request: { headers: new Headers({ "x-real-ip": "203.0.113.9" }) } };

    expect(await settle(onAuthenticate(payload))).toBe(rejection);
    expect(gate.recordFailedAuth).toHaveBeenCalledExactlyOnceWith(payload);
  });

  it("passes an accepted authentication through untouched", async () => {
    const gate = { recordFailedAuth: vi.fn(async () => undefined) };
    const onAuthenticate = recordingFailedAuth(async () => ({ user: { id: "u-1" } }), gate);

    await expect(onAuthenticate({ request: { headers: new Headers() } })).resolves.toEqual({ user: { id: "u-1" } });
    expect(gate.recordFailedAuth).not.toHaveBeenCalled();
  });
});
