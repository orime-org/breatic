// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Closing connections whose session ended (inner#1548).
 *
 * A connection is authenticated once, at its handshake. When its session ends
 * (sign out, sign out of other devices, a password reset) the server publishes
 * the ended session ids; every instance closes the matching connections, and
 * the client's re-authentication then fails. Announcements that arrive while
 * the subscription is down are lost, so each confirmed subscription, a timer
 * and every newly registered connection read the sessions again.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import type { Hocuspocus } from "@hocuspocus/server";
import type { Redis } from "@breatic/core";
import { COLLAB_REAUTH_REASONS, type SessionsRevokedEvent } from "@breatic/shared";

const { CHANNEL, logged } = vi.hoisted(() => ({
  CHANNEL: "test-deploy:sessions:revoked",
  logged: { error: [] as string[] },
}));

vi.mock("@breatic/core", async (importOriginal) => {
  const orig = await importOriginal<Record<string, unknown>>();
  return {
    ...orig,
    sessionsRevokedChannelName: () => CHANNEL,
    createLogger: () => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: (_ctx: unknown, msg: string) => { logged.error.push(msg); },
      debug: vi.fn(),
    }),
  };
});

import {
  closeIfSessionEnded,
  startSessionRevocation,
} from "@collab/services/session-revocation.js";
import type { AuthContext } from "@collab/hooks/auth.js";

type FakeSubscriber = EventEmitter & {
  subscribe: ReturnType<typeof vi.fn>;
  unsubscribe: ReturnType<typeof vi.fn>;
  quit: ReturnType<typeof vi.fn>;
};

interface FakeConnection {
  context: AuthContext;
  close: ReturnType<typeof vi.fn>;
}

/**
 * A subscriber whose SUBSCRIBE answers as told.
 * @param fails - Make the first SUBSCRIBE reject.
 * @returns The source to duplicate and the subscriber it hands out.
 */
function buildRedis(fails = false): { source: Redis; subscriber: FakeSubscriber } {
  const subscriber = Object.assign(new EventEmitter(), {
    subscribe: vi.fn(async () => {
      if (fails) throw new Error("subscribe refused");
      return 1;
    }),
    unsubscribe: vi.fn(async () => 0),
    quit: vi.fn(async () => "OK"),
  });
  const source = { duplicate: () => subscriber } as unknown as Redis;
  return { source, subscriber };
}

/**
 * A connection opened with a session.
 * @param userId - Whose connection.
 * @param token - The session token it was opened with.
 * @returns The connection.
 */
function connection(userId: string, token: string): FakeConnection {
  return {
    context: { user: { id: userId, role: "editor" }, handedOverFrom: null, session: { token, id: `id-${token}` } },
    close: vi.fn(),
  };
}

/**
 * A Hocuspocus holding these connections, spread over two documents.
 * @param connections - The connections.
 * @returns The server.
 */
function buildHocuspocus(connections: FakeConnection[]): Hocuspocus {
  const half = Math.ceil(connections.length / 2);
  const docs = new Map([
    ["project:p:canvas:a", { connections: new Map(connections.slice(0, half).map((c) => [c, {}])) }],
    ["project:p:canvas:b", { connections: new Map(connections.slice(half).map((c) => [c, {}])) }],
  ]);
  return { documents: docs } as unknown as Hocuspocus;
}

const ENDED = { code: 4401, reason: COLLAB_REAUTH_REASONS.sessionEnded };

/**
 * Let queued promise callbacks run.
 * @returns After the microtask queue drains.
 */
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
}

beforeEach(() => {
  logged.error = [];
});

afterEach(() => {
  vi.useRealTimers();
});

describe("startSessionRevocation", () => {
  it("resolves only once the subscription is confirmed, and fails when it is refused", async () => {
    const ok = buildRedis();
    const revocation = await startSessionRevocation(buildHocuspocus([]), {
      source: ok.source,
      readSession: async () => null,
      recheckIntervalMs: 60_000,
    });
    expect(ok.subscriber.subscribe).toHaveBeenCalledWith(CHANNEL);
    await revocation.stop();

    const refused = buildRedis(true);
    await expect(
      startSessionRevocation(buildHocuspocus([]), {
        source: refused.source,
        readSession: async () => null,
        recheckIntervalMs: 60_000,
      }),
    ).rejects.toThrow("subscribe refused");
  });

  it("closes the connections opened with the announced sessions and nothing else", async () => {
    const { source, subscriber } = buildRedis();
    const ended = connection("u1", "t-ended");
    const sameUserOtherSession = connection("u1", "t-kept");
    const someoneElse = connection("u2", "t-other");
    const sessions: Record<string, string> = { "t-ended": "u1", "t-kept": "u1", "t-other": "u2" };
    const revocation = await startSessionRevocation(buildHocuspocus([ended, sameUserOtherSession, someoneElse]), {
      source,
      readSession: async (token) => sessions[token] ?? null,
      recheckIntervalMs: 60_000,
    });

    const event: SessionsRevokedEvent = { type: "sessions:revoked", userId: "u1", sessionIds: ["id-t-ended"], ts: 1 };
    subscriber.emit("message", CHANNEL, JSON.stringify(event));

    expect(ended.close).toHaveBeenCalledWith(ENDED);
    expect(sameUserOtherSession.close).not.toHaveBeenCalled();
    expect(someoneElse.close).not.toHaveBeenCalled();
    await revocation.stop();
  });

  it("ignores a message it cannot read, and logs it", async () => {
    const { source, subscriber } = buildRedis();
    const open = connection("u1", "t1");
    const revocation = await startSessionRevocation(buildHocuspocus([open]), {
      source,
      readSession: async () => "u1",
      recheckIntervalMs: 60_000,
    });
    subscriber.emit("message", CHANNEL, "not json");
    expect(open.close).not.toHaveBeenCalled();
    expect(logged.error).toContain("session_revocation_message_invalid");
    await revocation.stop();
  });

  it("re-reads every connection's session once subscribed, closing the ended ones", async () => {
    const { source } = buildRedis();
    const gone = connection("u1", "t-gone");
    const reassigned = connection("u1", "t-reassigned");
    const alive = connection("u2", "t-alive");
    const sessions: Record<string, string> = { "t-reassigned": "u9", "t-alive": "u2" };
    const revocation = await startSessionRevocation(buildHocuspocus([gone, reassigned, alive]), {
      source,
      readSession: async (token) => sessions[token] ?? null,
      recheckIntervalMs: 60_000,
    });
    await flush();

    expect(gone.close).toHaveBeenCalledWith(ENDED);
    expect(reassigned.close).toHaveBeenCalledWith(ENDED);
    expect(alive.close).not.toHaveBeenCalled();
    await revocation.stop();
  });

  it("subscribes again and re-reads after the subscriber reconnects", async () => {
    const { source, subscriber } = buildRedis();
    const open = connection("u1", "t1");
    const sessions: Record<string, string> = { t1: "u1" };
    const revocation = await startSessionRevocation(buildHocuspocus([open]), {
      source,
      readSession: async (token) => sessions[token] ?? null,
      recheckIntervalMs: 60_000,
    });
    await flush();
    expect(open.close).not.toHaveBeenCalled();

    delete sessions.t1;
    subscriber.emit("ready");
    await flush();

    expect(subscriber.subscribe).toHaveBeenCalledTimes(2);
    expect(open.close).toHaveBeenCalledWith(ENDED);
    await revocation.stop();
  });

  it("re-reads on its interval, which catches sessions that simply expired", async () => {
    vi.useFakeTimers();
    const { source } = buildRedis();
    const open = connection("u1", "t1");
    const sessions: Record<string, string> = { t1: "u1" };
    const revocation = await startSessionRevocation(buildHocuspocus([open]), {
      source,
      readSession: async (token) => sessions[token] ?? null,
      recheckIntervalMs: 1_000,
    });
    await flush();
    delete sessions.t1;

    await vi.advanceTimersByTimeAsync(1_000);

    expect(open.close).toHaveBeenCalledWith(ENDED);
    await revocation.stop();
  });

  it("closes nothing when the sessions cannot be read, and logs it", async () => {
    const { source } = buildRedis();
    const open = connection("u1", "t1");
    const revocation = await startSessionRevocation(buildHocuspocus([open]), {
      source,
      readSession: async () => { throw new Error("redis down"); },
      recheckIntervalMs: 60_000,
    });
    await flush();

    expect(open.close).not.toHaveBeenCalled();
    expect(logged.error).toContain("session_recheck_failed");
    await revocation.stop();
  });

  it("stops its timer and its subscription", async () => {
    vi.useFakeTimers();
    const { source, subscriber } = buildRedis();
    const open = connection("u1", "t1");
    const readSession = vi.fn(async () => "u1");
    const revocation = await startSessionRevocation(buildHocuspocus([open]), {
      source,
      readSession,
      recheckIntervalMs: 1_000,
    });
    await flush();
    await revocation.stop();
    readSession.mockClear();

    await vi.advanceTimersByTimeAsync(5_000);

    expect(readSession).not.toHaveBeenCalled();
    expect(subscriber.unsubscribe).toHaveBeenCalledWith(CHANNEL);
    expect(subscriber.quit).toHaveBeenCalled();
  });
});

describe("closeIfSessionEnded", () => {
  it("closes a just-registered connection whose session is already gone", async () => {
    const open = connection("u1", "t1");
    await closeIfSessionEnded(open, async () => null);
    expect(open.close).toHaveBeenCalledWith(ENDED);
  });

  it("leaves a connection whose session still belongs to its user", async () => {
    const open = connection("u1", "t1");
    await closeIfSessionEnded(open, async () => "u1");
    expect(open.close).not.toHaveBeenCalled();
  });
});
