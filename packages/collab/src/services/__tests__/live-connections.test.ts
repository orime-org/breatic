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

import { describe, it, expect, vi } from "vitest";

import {
  createLiveConnections,
  type HeldConnection,
} from "@collab/services/live-connections.js";

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
    const onPong = vi.fn();
    const table = createLiveConnections({ onPong });
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

  it("reports the same moment for every document on one socket", () => {
    let clock = 5_000;
    const table = createLiveConnections({ onPong: vi.fn(), now: () => clock });

    const firstAt = table.remember("s-1", "doc-a", fakeConnection());
    clock += 900;
    const secondAt = table.remember("s-1", "doc-b", fakeConnection());

    // This number tells one of a person's connections from another when a
    // handshake picks which seat to take. It belongs to the socket: every
    // document on it arrived on the same connection.
    expect(secondAt).toBe(firstAt);
    expect(firstAt).toBe(5_000);
  });

  it("hands the pong callback everything that socket carries", () => {
    const onPong = vi.fn();
    const table = createLiveConnections({ onPong });
    const meta = fakeConnection({ kind: "meta" });
    const canvas = fakeConnection({ kind: "canvas" });
    table.remember("s-1", "doc-meta", meta);
    table.remember("s-1", "doc-canvas", canvas);

    fire(meta, "pong");

    // Seats are refreshed by socket id, but presence has to find this
    // socket's meta connection — so the callback gets the map, not just the id.
    expect(onPong).toHaveBeenCalledTimes(1);
    const [socketId, connections] = onPong.mock.calls[0] as [
      string,
      ReadonlyMap<string, HeldConnection>,
    ];
    expect(socketId).toBe("s-1");
    expect([...connections.keys()]).toEqual(["doc-meta", "doc-canvas"]);
    expect(connections.get("doc-meta")).toBe(meta);
  });

  it("stops answering for a socket once it closes", () => {
    const onPong = vi.fn();
    const table = createLiveConnections({ onPong });
    const connection = fakeConnection();
    table.remember("s-1", "doc-a", connection);

    fire(connection, "close");

    expect(table.find("doc-a", "s-1")).toBeUndefined();
    fire(connection, "pong");
    expect(onPong).not.toHaveBeenCalled();
  });

  it("drops one document without losing the rest of the socket", () => {
    const table = createLiveConnections({ onPong: vi.fn() });
    const meta = fakeConnection();
    const canvas = fakeConnection();
    table.remember("s-1", "doc-meta", meta);
    table.remember("s-1", "doc-canvas", canvas);

    table.forget("s-1", "doc-canvas");

    expect(table.find("doc-canvas", "s-1")).toBeUndefined();
    expect(table.find("doc-meta", "s-1")).toBe(meta);
  });

  it("says so when a socket emits nothing to listen to", () => {
    // The framework's own WebSocketLike declares no emitter methods; the node
    // adapter happens to hand over one that emits. If that ever stops being
    // true, every seat and every presence record on this instance expires on
    // its timer with no other symptom, so the one place that can still tell
    // the difference says so.
    const onSilentSocket = vi.fn();
    const table = createLiveConnections({
      onPong: vi.fn(),
      onSilentSocket,
    });
    const mute = fakeConnection();
    mute.webSocket = { send: vi.fn() } as unknown as HeldConnection["webSocket"];

    table.remember("s-1", "doc-a", mute);

    expect(onSilentSocket).toHaveBeenCalledWith("s-1");
    expect(table.find("doc-a", "s-1")).toBe(mute);
  });

  it("keeps a demote for another instance's socket out of this one", () => {
    const table = createLiveConnections({ onPong: vi.fn() });
    table.remember("s-1", "doc-a", fakeConnection());

    expect(table.find("doc-a", "s-2")).toBeUndefined();
    expect(table.find("doc-b", "s-1")).toBeUndefined();
  });
});
