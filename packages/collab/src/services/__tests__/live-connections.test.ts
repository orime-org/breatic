// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The per-socket table, and the one listener it hangs off each socket.
 *
 * Everything downstream of a pong — every seat's score, every presence record —
 * rides on this listener being attached exactly once per socket and firing.
 * Nothing else in the repo asserts that, so a change that attached it per
 * document, or stopped attaching it at all, would leave the whole suite green
 * while seats expired under live connections.
 */

import { afterEach, describe, it, expect, vi } from "vitest";
import { OutgoingMessage } from "@hocuspocus/server";

vi.mock("@breatic/core", () => ({
  env: { ENV: "test" },
  createLogger: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }),
}));

import {
  createLiveConnections,
  type HeldConnection,
} from "@collab/services/live-connections.js";
import { createLivenessHandler } from "@collab/services/socket-liveness.js";

/** A recording stand-in for the framework's Connection. */
function fakeConnection(document: object = {}): HeldConnection & {
  listeners: Map<string, ((...args: unknown[]) => void)[]>;
} {
  const listeners = new Map<string, ((...args: unknown[]) => void)[]>();
  return {
    listeners,
    readOnly: false,
    context: { user: { id: "u-1" } },
    document: document as HeldConnection["document"],
    webSocket: {
      send: vi.fn(),
      on(event: string, listener: (...args: unknown[]) => void): unknown {
        listeners.set(event, [...(listeners.get(event) ?? []), listener]);
        return undefined;
      },
      once(event: string, listener: (...args: unknown[]) => void): unknown {
        listeners.set(event, [...(listeners.get(event) ?? []), listener]);
        return undefined;
      },
      off(event: string, listener: (...args: unknown[]) => void): unknown {
        listeners.set(
          event,
          (listeners.get(event) ?? []).filter((l) => l !== listener),
        );
        return undefined;
      },
    },
  };
}

/**
 * Fire every listener registered for one event on a fake connection.
 * @param connection - The connection to fire on.
 * @param event - Which event.
 */
function fire(
  connection: ReturnType<typeof fakeConnection>,
  event: string,
): void {
  for (const listener of connection.listeners.get(event) ?? []) listener();
}

describe("live connections — one listener per socket", () => {
  it("attaches the pong listener once however many documents the socket carries", () => {
    const onAlive = vi.fn();
    const table = createLiveConnections({ onAlive, pingIntervalMs: 30_000 });
    const first = fakeConnection();
    const second = fakeConnection();

    table.remember("s-1", "doc-a", first);
    table.remember("s-1", "doc-b", second);

    // The second document rides the socket the first one opened, so only the
    // first connection object ever gets a listener. Twenty documents on one
    // socket must not refresh the same seats twenty times per ping.
    expect(first.listeners.get("pong")?.length).toBe(1);
    expect(second.listeners.get("pong")).toBeUndefined();
  });

  it("hands the pong callback everything that socket carries", () => {
    const onAlive = vi.fn();
    const table = createLiveConnections({ onAlive, pingIntervalMs: 30_000 });
    const meta = fakeConnection({ kind: "meta" });
    const canvas = fakeConnection({ kind: "canvas" });
    table.remember("s-1", "doc-meta", meta);
    table.remember("s-1", "doc-canvas", canvas);

    fire(meta, "pong");

    // Seats are refreshed by socket id, but presence has to find this
    // socket's meta connection — so the callback gets the map, not just the id.
    expect(onAlive).toHaveBeenCalledTimes(1);
    const [socketId, connections] = onAlive.mock.calls[0] as [
      string,
      ReadonlyMap<string, HeldConnection>,
    ];
    expect(socketId).toBe("s-1");
    expect([...connections.keys()]).toEqual(["doc-meta", "doc-canvas"]);
    expect(connections.get("doc-meta")).toBe(meta);
  });

  it("stops answering for a socket once it closes", () => {
    const onAlive = vi.fn();
    const table = createLiveConnections({ onAlive, pingIntervalMs: 30_000 });
    const connection = fakeConnection();
    table.remember("s-1", "doc-a", connection);

    fire(connection, "close");

    expect(table.find("doc-a", "s-1")).toBeUndefined();
    fire(connection, "pong");
    expect(onAlive).not.toHaveBeenCalled();
  });

  it("drops one document without losing the rest of the socket", () => {
    const table = createLiveConnections({ onAlive: vi.fn(), pingIntervalMs: 30_000 });
    const meta = fakeConnection();
    const canvas = fakeConnection();
    table.remember("s-1", "doc-meta", meta);
    table.remember("s-1", "doc-canvas", canvas);

    table.forget("s-1", "doc-canvas");

    expect(table.find("doc-canvas", "s-1")).toBeUndefined();
    expect(table.find("doc-meta", "s-1")).toBe(meta);
  });

  it("keeps a demote for another instance's socket out of this one", () => {
    const table = createLiveConnections({ onAlive: vi.fn(), pingIntervalMs: 30_000 });
    table.remember("s-1", "doc-a", fakeConnection());

    expect(table.find("doc-a", "s-2")).toBeUndefined();
    expect(table.find("doc-b", "s-1")).toBeUndefined();
  });
});

describe("live connections — a socket outlives the documents on it (inner#1034)", () => {
  it("keeps one pong listener when the socket's last document leaves and another arrives, and a lost seat still demotes the newcomer", async () => {
    // One real socket carries both connections, one after the other.
    const first = fakeConnection();
    const second = { ...fakeConnection(), webSocket: first.webSocket };
    // The registry runs one script per seat at a time: of two refreshes fired
    // by the same pong, only the first gets the answer.
    const refreshSeats = vi
      .fn()
      .mockResolvedValueOnce([{ documentName: "doc-b", outcome: "lost", liveCount: 2, cap: 2 }])
      .mockResolvedValue([]);
    const table = createLiveConnections({
      onAlive: createLivenessHandler({
        refreshSeats,
        requestDemote: vi.fn(async () => undefined),
        presencePolicy: { now: () => 1_000, staleAfterMs: 60_000 },
      }),
      pingIntervalMs: 30_000,
    });

    table.remember("s-1", "doc-a", first);
    table.forget("s-1", "doc-a");
    table.remember("s-1", "doc-b", second);

    expect(first.listeners.get("pong")?.length).toBe(1);

    fire(first, "pong");
    for (let i = 0; i < 5; i++) await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(refreshSeats).toHaveBeenCalledTimes(1);
    expect(second.readOnly).toBe(true);
    expect(second.webSocket.send).toHaveBeenCalledWith(
      new OutgoingMessage("doc-b").writeAuthenticated(true).toUint8Array(),
    );
  });
});

describe("live connections — an early pong is deferred, not dropped (inner#1034)", () => {
  const PING = 30_000;

  afterEach(() => {
    vi.useRealTimers();
  });

  it("refreshes at half a period after an early pong, so no gap between refreshes exceeds two periods", () => {
    vi.useFakeTimers({ now: 0 });
    const handled: number[] = [];
    const table = createLiveConnections({ onAlive: () => handled.push(Date.now()), pingIntervalMs: PING });
    const connection = fakeConnection();
    table.remember("s-1", "doc-a", connection);

    // Pings go out at 0, 30, 60 and 90 s; their pongs arrive 20, 0, 25 and 0 s late.
    for (const at of [20_000, 30_000, 85_000, 90_000]) {
      vi.advanceTimersByTime(at - Date.now());
      fire(connection, "pong");
    }
    vi.advanceTimersByTime(PING);

    expect(handled).toEqual([20_000, 35_000, 85_000, 100_000]);
    const gaps = handled.slice(1).map((t, i) => t - handled[i]!);
    expect(Math.max(...gaps)).toBeLessThanOrEqual(2 * PING);
  });

  it("handles one pong of a flood that arrives within half a period, and the next one after it", () => {
    vi.useFakeTimers({ now: 0 });
    let clock = 1_000_000;
    const onAlive = vi.fn();
    const table = createLiveConnections({ onAlive, pingIntervalMs: PING, now: () => clock });
    const connection = fakeConnection();
    table.remember("s-1", "doc-a", connection);

    // RFC 6455 lets a client send unsolicited pongs; each handled one runs a
    // script per seat on the shared Redis.
    for (let i = 0; i < 50; i++) {
      fire(connection, "pong");
      clock += 100;
    }
    expect(onAlive).toHaveBeenCalledTimes(1);

    // The clock reaches half a period before the deferred timer runs, so this
    // pong is on time and takes the deferred one's place.
    clock = 1_000_000 + PING / 2;
    fire(connection, "pong");
    expect(onAlive).toHaveBeenCalledTimes(2);

    vi.advanceTimersByTime(PING);
    expect(onAlive).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("handles a flood within half a period once at once and once deferred", () => {
    vi.useFakeTimers({ now: 1_000_000 });
    const onAlive = vi.fn();
    const table = createLiveConnections({ onAlive, pingIntervalMs: PING });
    const connection = fakeConnection();
    table.remember("s-1", "doc-a", connection);

    for (let i = 0; i < 50; i++) {
      fire(connection, "pong");
      vi.advanceTimersByTime(100);
    }
    expect(onAlive).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(PING / 2);
    expect(onAlive).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(PING * 2);
    expect(onAlive).toHaveBeenCalledTimes(2);
  });

  it("keeps handling on-time pongs after the wall clock steps back", () => {
    vi.useFakeTimers({ now: 1_000_000 });
    const onAlive = vi.fn();
    const table = createLiveConnections({ onAlive, pingIntervalMs: PING });
    const connection = fakeConnection();
    table.remember("s-1", "doc-a", connection);

    fire(connection, "pong");
    // NTP steps the system clock back by five periods; the time between pongs
    // has not changed.
    vi.setSystemTime(Date.now() - 5 * PING);
    for (let i = 0; i < 3; i++) {
      vi.advanceTimersByTime(PING);
      fire(connection, "pong");
    }

    expect(onAlive).toHaveBeenCalledTimes(4);
  });

  it("cancels a deferred pong when the socket closes", () => {
    vi.useFakeTimers({ now: 1_000_000 });
    const onAlive = vi.fn();
    const table = createLiveConnections({ onAlive, pingIntervalMs: PING });
    const connection = fakeConnection();
    table.remember("s-1", "doc-a", connection);

    fire(connection, "pong");
    vi.advanceTimersByTime(1_000);
    fire(connection, "pong");
    fire(connection, "close");
    vi.advanceTimersByTime(PING);

    expect(onAlive).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("live connections — a message or a ping counts as a pong, as the transport counts it", () => {
  const PING = 30_000;

  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps refreshing a socket that sends messages and never pongs, at most twice per period", () => {
    vi.useFakeTimers({ now: 0 });
    const handled: number[] = [];
    const table = createLiveConnections({ onAlive: () => handled.push(Date.now()), pingIntervalMs: PING });
    const connection = fakeConnection();
    table.remember("s-1", "doc-a", connection);

    // crossws keeps this socket open, so its seat must not expire under it.
    for (let at = 0; at < 3 * PING; at += 1_000) {
      vi.advanceTimersByTime(at - Date.now());
      fire(connection, "message");
    }
    vi.advanceTimersByTime(PING);

    expect(handled).toEqual([0, 15_000, 30_000, 45_000, 60_000, 75_000, 90_000]);
  });

  it("refreshes on a ping from the client", () => {
    const onAlive = vi.fn();
    const table = createLiveConnections({ onAlive, pingIntervalMs: PING });
    const connection = fakeConnection();
    table.remember("s-1", "doc-a", connection);

    fire(connection, "ping");

    expect(onAlive).toHaveBeenCalledTimes(1);
  });

  it("detaches from pongs, pings and messages when the socket closes", () => {
    const table = createLiveConnections({ onAlive: vi.fn(), pingIntervalMs: PING });
    const connection = fakeConnection();
    table.remember("s-1", "doc-a", connection);

    fire(connection, "close");

    for (const event of ["pong", "ping", "message"]) {
      expect(connection.listeners.get(event)).toEqual([]);
    }
  });
});
