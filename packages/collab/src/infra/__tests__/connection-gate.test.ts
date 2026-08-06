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
import type { ConnectionGate } from "@collab/infra/connection-gate.js";

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

describe("connection gate — driving the real throttle", () => {
  // The tests above hand the gate a stand-in, which proves it delegates but
  // proves nothing about whether anyone is ever actually throttled. These
  // drive the shipped extension, so they fail if the gate stops feeding it a
  // usable identity — the extension reads `x-real-ip` and has no fallback, so
  // an unset header quietly collapses every client into one shared bucket
  // instead of erroring.

  /** Run one connection through the gate and report how it ended. */
  async function connect(identity: string, gate: ConnectionGate): Promise<string> {
    try {
      await gate.onConnect(connectPayload({ "x-real-ip": identity }));
      return "allowed";
    } catch {
      return "denied";
    }
  }

  it("bans a non-loopback identity once it passes the threshold", async () => {
    // The extension bans on the connection AFTER the threshold, so a limit of
    // two allows two and denies from the third on.
    const gate = createConnectionGate({ throttle: 2, banTime: 5 });
    const outcomes: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      outcomes.push(await connect("203.0.113.9", gate));
    }
    await gate.onDestroy();

    expect(outcomes).toEqual(["allowed", "allowed", "denied", "denied"]);
  });

  it("never bans a loopback identity, however many times it connects", async () => {
    // A developer opens the meta doc plus one document per Space, twice over
    // under StrictMode. Counting those would ban them on their own machine.
    const gate = createConnectionGate({ throttle: 2, banTime: 5 });
    const outcomes: string[] = [];
    for (let i = 0; i < 10; i += 1) {
      outcomes.push(await connect("127.0.0.1", gate));
    }
    await gate.onDestroy();

    expect(outcomes.every((outcome) => outcome === "allowed")).toBe(true);
  });

  it("counts each identity separately rather than pooling them", async () => {
    const gate = createConnectionGate({ throttle: 2, banTime: 5 });
    await connect("203.0.113.9", gate);
    await connect("203.0.113.9", gate);
    const other = await connect("198.51.100.7", gate);
    await gate.onDestroy();

    expect(other).toBe("allowed");
  });

  it("pools everyone into one bucket when the identity header is missing", async () => {
    // Not a wish — a characterisation of the extension we depend on, and the
    // reason the gate must guarantee that header. The extension reads
    // `x-real-ip` and has no fallback, so an absent one is not an error: it
    // is one shared empty-string bucket, where a handful of connections bans
    // every user of the service at once. The version bump this PR carries
    // changed how that header is read (`headers["x"]` became
    // `headers.get("x")`), which is exactly the kind of change that turns the
    // key into an empty string without failing anything.
    const gate = createConnectionGate({ throttle: 2, banTime: 5 });
    const outcomes: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      try {
        await gate.onConnect({ request: { headers: new Headers() } });
        outcomes.push("allowed");
      } catch {
        outcomes.push("denied");
      }
    }
    await gate.onDestroy();

    expect(outcomes).toEqual(["allowed", "allowed", "denied"]);
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
    const gate = createConnectionGate(
      { throttle: 15, banTime: 5 },
      { throttle: fakeThrottle() },
    );
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
    const gate = createConnectionGate(
      { throttle: 15, banTime: 5 },
      { throttle: fakeThrottle() },
    );

    await gate.onUpgrade(fakeUpgradeRequest({ "x-real-ip": "203.0.113.9" }, "172.18.0.4"));

    expect(loggerWarnMock).not.toHaveBeenCalled();
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
