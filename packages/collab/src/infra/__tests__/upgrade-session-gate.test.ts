// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { IncomingMessage } from "node:http";
import type { Socket } from "node:net";
import { Duplex } from "node:stream";
import fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as CoreModule from "@breatic/core";
import type { Redis } from "@breatic/core";

const { sessionLookup, logs } = vi.hoisted(() => ({
  sessionLookup: vi.fn<(...args: unknown[]) => Promise<string | null>>(),
  logs: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("@breatic/core", async (importOriginal) => ({
  ...(await importOriginal<typeof CoreModule>()),
  createLogger: () => logs,
  sessionCookieName: () => "breatic_session_gate-test",
  getSession: sessionLookup,
}));

import { sessionId } from "@breatic/core";
import { createUpgradeSessionGate } from "@collab/infra/upgrade-session-gate.js";

const COOKIE = "breatic_session_gate-test";
const TOKEN = "private-session/+?token";
const COOKIE_HEADER = `${COOKIE}=${encodeURIComponent(TOKEN)}; other=private-cookie-value`;
const REDIS = { get: vi.fn() } as unknown as Redis;
const sockets: GateSocket[] = [];

type Outcome = { kind: "pending" } | { kind: "admitted" } | { kind: "rejected"; value: unknown };

/** A controllable Promise representing one dependency operation. */
interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

/**
 * Construct one operation whose completion is driven by the test.
 * @returns The operation and its completion functions.
 */
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

/** A real Node Duplex whose physical destruction can be held independently. */
class GateSocket extends Duplex {
  remoteAddress: string | undefined = "127.0.0.1";
  readonly chunks: string[] = [];
  holdDestruction = false;
  private finishDestruction: (() => void) | undefined;

  /** Construct an open stream with independent readable and writable ends. */
  constructor() {
    super({ allowHalfOpen: true });
  }

  /** Keep the readable side open until the test supplies FIN or destruction. */
  override _read(): void {}

  /** Record bytes written by the gate and acknowledge their acceptance. */
  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.chunks.push(chunk.toString());
    callback();
  }

  /** Complete destruction at the point selected by the test. */
  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    if (this.holdDestruction) this.finishDestruction = () => callback(error);
    else callback(error);
  }

  /** Release the held completion of stream destruction. */
  releaseDestruction(): void {
    this.holdDestruction = false;
    this.finishDestruction?.();
    this.finishDestruction = undefined;
  }
}

/**
 * Track one stream so every test also releases its open success path.
 * @returns The stream.
 */
function socket(): GateSocket {
  const stream = new GateSocket();
  sockets.push(stream);
  return stream;
}

/**
 * Create the real HTTP request type while leaving stream ownership with the fixture.
 * @param stream - The stream supplied to the upgrade hook.
 * @param cookie - Its raw Cookie header.
 * @returns The native upgrade payload.
 */
function payload(stream: GateSocket, cookie: string | undefined = COOKIE_HEADER): {
  request: IncomingMessage;
  socket: GateSocket;
  head: Buffer;
} {
  const request = new IncomingMessage(stream as unknown as Socket);
  if (cookie !== undefined) request.headers.cookie = cookie;
  return { request, socket: stream, head: Buffer.alloc(0) };
}

/**
 * Observe rejection from the start so delayed dependency failures stay handled.
 * @param operation - The hook being observed.
 * @returns A completion Promise and the current outcome.
 */
function observe(operation: Promise<unknown>): { done: Promise<void>; read: () => Outcome } {
  let outcome: Outcome = { kind: "pending" };
  const done = operation.then(
    () => { outcome = { kind: "admitted" }; },
    (value: unknown) => { outcome = { kind: "rejected", value }; },
  );
  return { done, read: () => outcome };
}

/** Allow Node nextTick, microtasks and stream close callbacks to complete. */
async function turn(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

/**
 * Assert the native hook contract and release of this gate's stream listeners.
 * @param watched - The observed hook.
 * @param stream - Its native stream.
 */
async function expectRefused(watched: ReturnType<typeof observe>, stream: GateSocket): Promise<void> {
  await watched.done;
  const outcome = watched.read();
  expect(outcome.kind).toBe("rejected");
  if (outcome.kind === "rejected") expect(Boolean(outcome.value)).toBe(false);
  expect(stream.destroyed).toBe(true);
  for (const event of ["end", "finish", "close"]) expect(stream.listenerCount(event)).toBe(0);
}

/**
 * Collect raw logger arguments, including Error's own non-enumerable fields.
 * @returns The strings that a structured logger could serialize.
 */
function loggedText(): string {
  return JSON.stringify(Object.values(logs).flatMap((logger) => logger.mock.calls), (_key, value: unknown) => {
    if (value instanceof Error) {
      return Object.fromEntries(Object.getOwnPropertyNames(value).map((key) => [key, Reflect.get(value, key)]));
    }
    return value;
  });
}

/**
 * Obtain one event's structured data without depending on call ordering.
 * @param level - Its log level.
 * @param event - Its event name.
 * @returns Its structured payload.
 */
function eventData(level: keyof typeof logs, event: string): Record<string, unknown> {
  const matching = logs[level].mock.calls.filter((call) => call[1] === event);
  expect(matching).toHaveLength(1);
  return matching[0]?.[0] as Record<string, unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
  sessionLookup.mockResolvedValue("user-a");
});

afterEach(async () => {
  for (const stream of sockets.splice(0)) {
    stream.on("error", () => undefined);
    stream.releaseDestruction();
    stream.destroy();
  }
  await turn();
  vi.restoreAllMocks();
});

describe("upgrade session gate — admission", () => {
  it.each([
    [undefined, "missing"],
    ["other=value", "other cookie"],
    [`${COOKIE}=`, "empty"],
    ["breatic_session_other=valid", "other deployment"],
  ])("refuses a %s cookie before looking up a session (%s)", async (cookie, _description) => {
    const stream = socket();
    const recordFailedUpgrade = vi.fn(async () => undefined);
    const gate = createUpgradeSessionGate({ redis: REDIS, recordFailedUpgrade });
    const upgrade = payload(stream, cookie);
    if (cookie === undefined) delete upgrade.request.headers.cookie;
    const watched = observe(gate.onUpgrade(upgrade));

    await expectRefused(watched, stream);

    expect(stream.chunks.join("")).toMatch(/^HTTP\/1\.1 401 Unauthorized\r\n/);
    expect(stream.chunks.join("")).toMatch(/Connection: close\r\n/i);
    expect(stream.chunks.join("").split("\r\n\r\n")[1]).toBe("");
    expect(sessionLookup).not.toHaveBeenCalled();
    expect(recordFailedUpgrade).toHaveBeenCalledExactlyOnceWith(upgrade.request);
    expect(eventData("warn", "collab_upgrade_session_rejected")).toMatchObject({ status: 401 });
  });

  it("refuses malformed encoding and records a safe parsing error", async () => {
    const stream = socket();
    const recordFailedUpgrade = vi.fn(async () => undefined);
    const gate = createUpgradeSessionGate({ redis: REDIS, recordFailedUpgrade });

    await expectRefused(observe(gate.onUpgrade(payload(stream, `${COOKIE}=%E0%A4%A`))), stream);

    expect(sessionLookup).not.toHaveBeenCalled();
    expect(recordFailedUpgrade).toHaveBeenCalledTimes(1);
    expect(eventData("error", "collab_upgrade_cookie_error")).toMatchObject({ err: expect.any(Error), ctx: expect.any(Object) });
    expect(loggedText()).toContain("cookie_malformed");
  });

  it("rejects an absent session after exactly one decoded-token lookup", async () => {
    sessionLookup.mockResolvedValue(null);
    const stream = socket();
    const gate = createUpgradeSessionGate({ redis: REDIS });

    await expectRefused(observe(gate.onUpgrade(payload(stream))), stream);

    expect(sessionLookup).toHaveBeenCalledExactlyOnceWith(REDIS, TOKEN);
    expect(stream.chunks.join("")).toContain("401 Unauthorized");
    const entry = eventData("warn", "collab_upgrade_session_rejected");
    expect(JSON.stringify(entry)).toContain("session_not_found");
    expect(JSON.stringify(entry)).toContain(sessionId(TOKEN));
  });

  it("hands a live valid session to transport and removes its own listeners", async () => {
    const stream = socket();
    const recordFailedUpgrade = vi.fn(async () => undefined);
    const gate = createUpgradeSessionGate({ redis: REDIS, recordFailedUpgrade });

    await gate.onUpgrade(payload(stream));

    expect(sessionLookup).toHaveBeenCalledExactlyOnceWith(REDIS, TOKEN);
    expect(stream.chunks).toEqual([]);
    expect(stream.destroyed).toBe(false);
    for (const event of ["end", "finish", "error", "close"]) expect(stream.listenerCount(event)).toBe(0);
    gate.stop();
    expect(stream.destroyed).toBe(false);
    expect(recordFailedUpgrade).not.toHaveBeenCalled();
  });

  it.each(["Command timed out", "Connection is closed."])("returns 503 for %s", async (message) => {
    sessionLookup.mockRejectedValue(new Error(message));
    const stream = socket();
    const recordFailedUpgrade = vi.fn(async () => undefined);
    const gate = createUpgradeSessionGate({ redis: REDIS, recordFailedUpgrade });

    await expectRefused(observe(gate.onUpgrade(payload(stream))), stream);

    expect(stream.chunks.join("")).toMatch(/^HTTP\/1\.1 503 Service Unavailable\r\n/);
    expect(recordFailedUpgrade).toHaveBeenCalledTimes(1);
    expect(eventData("error", "collab_upgrade_session_error")).toMatchObject({ err: expect.any(Error), ctx: expect.any(Object) });
    expect(loggedText()).toContain(message);
  });

  it("finishes refusal without an optional accounting callback", async () => {
    const stream = socket();
    const gate = createUpgradeSessionGate({ redis: REDIS });
    await expectRefused(observe(gate.onUpgrade(payload(stream, "other=missing"))), stream);
    expect(stream.chunks.join("")).toContain("401 Unauthorized");
  });
});

describe("upgrade session gate — independent completion chains", () => {
  it.each(["socket-first", "accounting-first"])("waits for both chains with %s", async (order) => {
    const stream = socket();
    stream.holdDestruction = true;
    const accounting = deferred<void>();
    const recordFailedUpgrade = vi.fn(() => accounting.promise);
    const gate = createUpgradeSessionGate({ redis: REDIS, recordFailedUpgrade });
    const watched = observe(gate.onUpgrade(payload(stream, "other=missing")));
    await turn();
    expect(stream.destroyed).toBe(true);
    expect(watched.read()).toEqual({ kind: "pending" });

    if (order === "socket-first") stream.releaseDestruction();
    else accounting.resolve(undefined);
    await turn();
    expect(watched.read()).toEqual({ kind: "pending" });

    if (order === "socket-first") accounting.resolve(undefined);
    else stream.releaseDestruction();
    await expectRefused(watched, stream);
    expect(recordFailedUpgrade).toHaveBeenCalledTimes(1);
  });

  it("consumes a failed accounting call and preserves its refusal", async () => {
    const stream = socket();
    sessionLookup.mockResolvedValue(null);
    const failure = Object.assign(new Error(`count failed ${COOKIE_HEADER}`), { command: { args: [TOKEN] } });
    const recordFailedUpgrade = vi.fn(async () => { throw failure; });
    const gate = createUpgradeSessionGate({ redis: REDIS, recordFailedUpgrade });

    await expectRefused(observe(gate.onUpgrade(payload(stream))), stream);

    expect(recordFailedUpgrade).toHaveBeenCalledTimes(1);
    expect(eventData("error", "collab_upgrade_failure_count_error")).toMatchObject({ err: expect.any(Error), ctx: expect.any(Object) });
    expect(loggedText()).not.toContain(TOKEN);
    expect(loggedText()).not.toContain(encodeURIComponent(TOKEN));
    expect(loggedText()).not.toContain(COOKIE_HEADER);
  });

  it("releases a request with no Cookie header when failure accounting rejects", async () => {
    const stream = socket();
    const failure = Object.assign(new Error("accounting unavailable"), {
      command: { args: ["dependency-session-key"] },
    });
    const recordFailedUpgrade = vi.fn(async () => { throw failure; });
    const gate = createUpgradeSessionGate({ redis: REDIS, recordFailedUpgrade });
    const upgrade = payload(stream);
    delete upgrade.request.headers.cookie;

    await expectRefused(observe(gate.onUpgrade(upgrade)), stream);

    expect(sessionLookup).not.toHaveBeenCalled();
    expect(recordFailedUpgrade).toHaveBeenCalledExactlyOnceWith(upgrade.request);
    expect(stream.chunks.join("")).toMatch(/^HTTP\/1\.1 401 Unauthorized\r\n/);
    const entry = eventData("error", "collab_upgrade_failure_count_error");
    expect(entry).toMatchObject({ err: expect.any(Error), ctx: expect.any(Object) });
    expect((entry.err as Error).message).toBe("accounting unavailable");
    expect(Reflect.get(entry.err as Error, "command")).toBeUndefined();
    expect(loggedText()).not.toContain("dependency-session-key");
  });

  it("keeps one rejected decision while stop and peer closure arrive during accounting", async () => {
    sessionLookup.mockResolvedValue(null);
    const stream = socket();
    const accounting = deferred<void>();
    const recordFailedUpgrade = vi.fn(() => accounting.promise);
    const gate = createUpgradeSessionGate({ redis: REDIS, recordFailedUpgrade });
    const watched = observe(gate.onUpgrade(payload(stream)));
    await turn();
    expect(recordFailedUpgrade).toHaveBeenCalledTimes(1);
    gate.stop();
    gate.stop();
    stream.push(null);
    stream.resume();
    accounting.resolve(undefined);
    await expectRefused(watched, stream);
    expect(recordFailedUpgrade).toHaveBeenCalledTimes(1);
    expect(stream.chunks.join("")).toContain("401 Unauthorized");
    expect(stream.chunks.join("")).not.toContain("503 Service Unavailable");
  });

  it("destroys the socket after a refusal write throws and redacts that error", async () => {
    const stream = socket();
    sessionLookup.mockResolvedValue(null);
    vi.spyOn(stream, "write").mockImplementation(() => {
      throw Object.assign(new Error(`write failed ${COOKIE_HEADER} ${TOKEN}`), { command: { args: [TOKEN] } });
    });
    const recordFailedUpgrade = vi.fn(async () => undefined);
    const gate = createUpgradeSessionGate({ redis: REDIS, recordFailedUpgrade });

    await expectRefused(observe(gate.onUpgrade(payload(stream))), stream);

    expect(recordFailedUpgrade).toHaveBeenCalledTimes(1);
    expect(eventData("error", "collab_upgrade_socket_error")).toMatchObject({ err: expect.any(Error), ctx: expect.any(Object) });
    expect(loggedText()).not.toContain(TOKEN);
    expect(loggedText()).not.toContain(encodeURIComponent(TOKEN));
    expect(loggedText()).not.toContain(COOKIE_HEADER);
    expect(loggedText()).not.toContain('"command"');
  });
});

describe("upgrade session gate — stream ownership", () => {
  it("refuses when native destruction follows query resolution in the same Promise microtask", async () => {
    const stream = socket();
    const query = deferred<string | null>();
    sessionLookup.mockReturnValue(query.promise);
    const recordFailedUpgrade = vi.fn(async () => undefined);
    const gate = createUpgradeSessionGate({ redis: REDIS, recordFailedUpgrade });
    const watched = observe(gate.onUpgrade(payload(stream)));

    await Promise.resolve().then(() => {
      query.resolve("user-a");
      stream.destroy();
    });
    await expectRefused(watched, stream);

    expect(sessionLookup).toHaveBeenCalledExactlyOnceWith(REDIS, TOKEN);
    expect(recordFailedUpgrade).not.toHaveBeenCalled();
    expect(stream.chunks).toEqual([]);
    expect(eventData("info", "collab_upgrade_peer_closed").ctx).toMatchObject({ decision: "peer_gone" });
    gate.stop();
    expect(stream.chunks).toEqual([]);
  });

  it.each(["observe-first", "destroy-first", "close-first"])("releases a terminated stream in %s order", async (order) => {
    const stream = socket();
    const query = deferred<string | null>();
    sessionLookup.mockReturnValue(query.promise);
    const gate = createUpgradeSessionGate({ redis: REDIS });
    if (order !== "observe-first") stream.destroy();
    if (order === "close-first") await turn();
    const watched = observe(gate.onUpgrade(payload(stream)));
    if (order === "observe-first") stream.destroy();

    await turn();
    expect(watched.read().kind).toBe("rejected");
    query.resolve("user-a");
    await expectRefused(watched, stream);
    await turn();
    expect(stream.chunks.join("")).not.toContain("101");
  });

  it.each(["valid", "absent", "error"])("keeps FIN terminal when a %s query completes late", async (completion) => {
    const stream = socket();
    const query = deferred<string | null>();
    sessionLookup.mockReturnValue(query.promise);
    const recordFailedUpgrade = vi.fn(async () => undefined);
    const gate = createUpgradeSessionGate({ redis: REDIS, recordFailedUpgrade });
    const watched = observe(gate.onUpgrade(payload(stream)));
    stream.push(null);
    stream.resume();
    await turn();
    expect(watched.read().kind).toBe("rejected");
    gate.stop();
    if (completion === "error") query.reject(new Error("late lookup failed"));
    else query.resolve(completion === "valid" ? "user-a" : null);
    await expectRefused(watched, stream);
    await turn();
    expect(recordFailedUpgrade).not.toHaveBeenCalled();
    expect(stream.chunks).toEqual([]);
    expect(eventData("info", "collab_upgrade_peer_closed")).toMatchObject({ ctx: expect.any(Object) });
    if (completion === "error") expect(loggedText()).toContain("late lookup failed");
  });

  it("consumes a native stream error and a late query rejection", async () => {
    const stream = socket();
    const query = deferred<string | null>();
    sessionLookup.mockReturnValue(query.promise);
    const recordFailedUpgrade = vi.fn(async () => undefined);
    const gate = createUpgradeSessionGate({ redis: REDIS, recordFailedUpgrade });
    const watched = observe(gate.onUpgrade(payload(stream)));
    stream.destroy(new Error(`reset ${TOKEN} ${COOKIE_HEADER}`));
    await turn();
    query.reject(new Error("late Redis fault"));
    await expectRefused(watched, stream);
    await turn();
    expect(recordFailedUpgrade).not.toHaveBeenCalled();
    expect(loggedText()).toContain("late Redis fault");
    expect(loggedText()).not.toContain(TOKEN);
    expect(loggedText()).not.toContain(COOKIE_HEADER);
  });

  it("refuses an already readable-ended stream before a valid result can hand it off", async () => {
    const stream = socket();
    stream.push(null);
    stream.resume();
    await turn();
    expect(stream.readableEnded).toBe(true);
    const gate = createUpgradeSessionGate({ redis: REDIS });
    await expectRefused(observe(gate.onUpgrade(payload(stream))), stream);
    expect(stream.chunks).toEqual([]);
  });

  it("leaves a handed-off stream under transport ownership", async () => {
    const stream = socket();
    const gate = createUpgradeSessionGate({ redis: REDIS });
    await gate.onUpgrade(payload(stream));
    stream.push(null);
    stream.resume();
    await turn();
    gate.stop();
    expect(stream.destroyed).toBe(false);
    expect(logs.info.mock.calls.filter((call) => call[1] === "collab_upgrade_peer_closed")).toEqual([]);
  });
});

describe("upgrade session gate — stopping", () => {
  it.each(["valid", "absent", "error"])("stops synchronously before a %s query finishes", async (completion) => {
    const stream = socket();
    const query = deferred<string | null>();
    sessionLookup.mockReturnValue(query.promise);
    const recordFailedUpgrade = vi.fn(async () => undefined);
    const gate = createUpgradeSessionGate({ redis: REDIS, recordFailedUpgrade });
    const watched = observe(gate.onUpgrade(payload(stream)));

    expect(gate.stop()).toBeUndefined();
    expect(stream.destroyed).toBe(true);
    gate.stop();
    await turn();
    expect(watched.read().kind).toBe("rejected");
    if (completion === "error") query.reject(new Error("late stopped query"));
    else query.resolve(completion === "valid" ? "user-a" : null);
    await expectRefused(watched, stream);
    await turn();
    expect(recordFailedUpgrade).not.toHaveBeenCalled();
    expect(stream.chunks.join("")).toContain("503 Service Unavailable");
    expect(eventData("info", "collab_upgrade_stopped")).toMatchObject({ ctx: expect.any(Object) });
  });

  it("refuses a new request after stop without querying Redis", async () => {
    const gate = createUpgradeSessionGate({ redis: REDIS });
    gate.stop();
    const stream = socket();
    await expectRefused(observe(gate.onUpgrade(payload(stream))), stream);
    expect(sessionLookup).not.toHaveBeenCalled();
    expect(stream.chunks.join("")).toContain("503 Service Unavailable");
  });

  it("lets synchronous stop win before a resolved query continuation runs", async () => {
    const query = deferred<string | null>();
    sessionLookup.mockReturnValue(query.promise);
    const stream = socket();
    const recordFailedUpgrade = vi.fn(async () => undefined);
    const gate = createUpgradeSessionGate({ redis: REDIS, recordFailedUpgrade });
    const watched = observe(gate.onUpgrade(payload(stream)));
    query.resolve("user-a");
    gate.stop();
    await expectRefused(watched, stream);
    expect(recordFailedUpgrade).not.toHaveBeenCalled();
    expect(stream.chunks.join("")).toContain("503 Service Unavailable");
  });

  it("onDestroy ends the same pending ownership as stop", async () => {
    const query = deferred<string | null>();
    sessionLookup.mockReturnValue(query.promise);
    const stream = socket();
    const gate = createUpgradeSessionGate({ redis: REDIS });
    const watched = observe(gate.onUpgrade(payload(stream)));
    await gate.onDestroy();
    gate.stop();
    await expectRefused(watched, stream);
    query.resolve("user-a");
    await turn();
    expect(stream.chunks.join("")).toContain("503 Service Unavailable");
  });

  it("releases several pending streams and keeps an admitted stream live", async () => {
    const gate = createUpgradeSessionGate({ redis: REDIS });
    const admitted = socket();
    await gate.onUpgrade(payload(admitted));
    const queries = [deferred<string | null>(), deferred<string | null>()];
    sessionLookup.mockReturnValueOnce(queries[0]!.promise).mockReturnValueOnce(queries[1]!.promise);
    const pending = [socket(), socket()];
    const watched = pending.map((stream) => observe(gate.onUpgrade(payload(stream))));
    gate.stop();
    for (let index = 0; index < pending.length; index += 1) await expectRefused(watched[index]!, pending[index]!);
    expect(admitted.destroyed).toBe(false);
    queries.forEach((query) => query.resolve("user-a"));
    await turn();
    gate.stop();
    expect(admitted.destroyed).toBe(false);
  });
});

describe("upgrade session gate — logs and event invariants", () => {
  it("reads the first identity from a programmatic IncomingMessage header array", async () => {
    const stream = socket();
    stream.remoteAddress = "172.18.0.4";
    const gate = createUpgradeSessionGate({ redis: REDIS });
    const upgrade = payload(stream, "other=missing");
    upgrade.request.headers["x-real-ip"] = ["203.0.113.9", "203.0.113.10"];

    await expectRefused(observe(gate.onUpgrade(upgrade)), stream);

    expect(sessionLookup).not.toHaveBeenCalled();
    expect(eventData("warn", "collab_upgrade_session_rejected").ctx).toMatchObject({
      peerAddress: "172.18.0.4",
      identity: "203.0.113.9",
    });
  });

  it("correlates a rejection and accounting failure with a unique request id", async () => {
    sessionLookup.mockResolvedValue(null);
    const recordFailedUpgrade = vi.fn(async () => { throw new Error(`counter ${TOKEN} ${COOKIE_HEADER}`); });
    const gate = createUpgradeSessionGate({ redis: REDIS, recordFailedUpgrade });
    const first = socket();
    await expectRefused(observe(gate.onUpgrade(payload(first))), first);
    const refusal = eventData("warn", "collab_upgrade_session_rejected");
    const failure = eventData("error", "collab_upgrade_failure_count_error");
    const firstContext = refusal.ctx as Record<string, unknown>;
    const failureContext = failure.ctx as Record<string, unknown>;
    expect(typeof firstContext.attemptId).toBe("string");
    expect(String(firstContext.attemptId).length).toBeGreaterThan(0);
    expect(failureContext.attemptId).toBe(firstContext.attemptId);
    expect(firstContext).toMatchObject({ peerAddress: "127.0.0.1" });
    expect(typeof firstContext.phase).toBe("string");
    expect(firstContext.identity).toBe("127.0.0.1");
    const text = loggedText();
    for (const secret of [TOKEN, encodeURIComponent(TOKEN), COOKIE_HEADER, encodeURIComponent(COOKIE_HEADER)]) {
      expect(text).not.toContain(secret);
    }
    logs.warn.mockClear();
    logs.error.mockClear();
    const second = socket();
    await expectRefused(observe(gate.onUpgrade(payload(second))), second);
    const secondContext = eventData("warn", "collab_upgrade_session_rejected").ctx as Record<string, unknown>;
    expect(secondContext.attemptId).not.toBe(firstContext.attemptId);
  });

  it("keeps identity failure diagnostic when throttling is absent", async () => {
    const stream = socket();
    stream.remoteAddress = undefined;
    const gate = createUpgradeSessionGate({ redis: REDIS });
    await gate.onUpgrade(payload(stream));
    expect(stream.destroyed).toBe(false);
    expect(sessionLookup).toHaveBeenCalledExactlyOnceWith(REDIS, TOKEN);
  });

  it("uses the deployment cookie for generated credentials and keeps them out of logs", async () => {
    await fc.assert(fc.asyncProperty(fc.array(fc.integer({ min: 33, max: 126 }), { maxLength: 32 }), async (characters) => {
      const token = `private-generated-${String.fromCharCode(...characters)}-session`;
      sessionLookup.mockResolvedValueOnce(null);
      const stream = socket();
      const gate = createUpgradeSessionGate({ redis: REDIS });
      const header = `${COOKIE}=${encodeURIComponent(token)}`;
      await expectRefused(observe(gate.onUpgrade(payload(stream, header))), stream);
      expect(sessionLookup).toHaveBeenLastCalledWith(REDIS, token);
      expect(loggedText()).not.toContain(token);
      expect(loggedText()).not.toContain(encodeURIComponent(token));
      gate.stop();
    }), { seed: 1570, numRuns: 64 });
  });

  it("preserves the first terminal event for generated reachable sequences", async () => {
    await fc.assert(fc.asyncProperty(
      fc.shuffledSubarray(["valid", "absent", "error", "fin", "stop"] as const, { minLength: 1, maxLength: 5 }),
      async (events) => {
        const stream = socket();
        const query = deferred<string | null>();
        sessionLookup.mockReturnValueOnce(query.promise);
        const recordFailedUpgrade = vi.fn(async () => undefined);
        const gate = createUpgradeSessionGate({ redis: REDIS, recordFailedUpgrade });
        const watched = observe(gate.onUpgrade(payload(stream)));
        let querySettled = false;
        let expected: "admitted" | "rejected" | undefined;
        let expectedFailures = 0;
        for (const event of events) {
          if (["valid", "absent", "error"].includes(event)) {
            if (querySettled) continue;
            querySettled = true;
            if (expected === undefined) {
              expected = event === "valid" ? "admitted" : "rejected";
              expectedFailures = event === "valid" ? 0 : 1;
            }
            if (event === "error") query.reject(new Error("generated lookup failure"));
            else query.resolve(event === "valid" ? "user-a" : null);
          } else if (event === "fin") {
            expected ??= "rejected";
            stream.push(null);
            stream.resume();
          } else {
            expected ??= "rejected";
            gate.stop();
          }
          await turn();
        }
        if (!querySettled) query.resolve("user-a");
        await watched.done;
        expect(watched.read().kind).toBe(expected ?? "admitted");
        expect(recordFailedUpgrade).toHaveBeenCalledTimes(expectedFailures);
        const destroyed = stream.destroyed;
        gate.stop();
        await turn();
        expect(stream.destroyed).toBe(destroyed);
        for (const event of ["end", "finish", "close"]) expect(stream.listenerCount(event)).toBe(0);
      },
    ), { seed: 1570, numRuns: 64 });
  });
});
