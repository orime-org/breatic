// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * `closeAfterRefusal` and the lingering close it installs (inner#1782,
 * test spec U1–U20). The socket and the request are fakes driven in the
 * order Node drives the real ones: the response finishing calls
 * `destroySoon` (E2), node-server's drain may call it again (E3), then the
 * body ends (E4), the client sends FIN (E5), the deadline passes (E6), the
 * socket closes (E7) or the write side finishes (E8).
 */

import { EventEmitter } from "node:events";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";

const linger = vi.hoisted(() => ({ seconds: 30, broken: false }));
vi.mock("@server/config/limits.js", () => ({
  getRequestBodyLingerSeconds: () => {
    if (linger.broken) throw new Error("config/limits.yaml failed to parse");
    return linger.seconds;
  },
}));

import { closeAfterRefusal } from "@server/middleware/close-after-refusal.js";

interface FakeSocket extends EventEmitter {
  destroyed: boolean;
  writable: boolean;
  writableFinished: boolean;
  end: Mock;
  destroy: Mock;
  destroySoon: () => void;
}

interface FakeIncoming extends EventEmitter {
  socket: FakeSocket | null;
  readableEnded: boolean;
  pause: Mock;
  resume: Mock;
  /** `listenerCount("data")` at each `resume()` call. */
  dataListenersAtResume: number[];
}

interface Harness {
  log: string[];
  socket: FakeSocket;
  original: Mock;
  incoming: FakeIncoming;
}

function fakeSocket(log: string[]): { socket: FakeSocket; original: Mock } {
  const socket = new EventEmitter() as FakeSocket;
  socket.destroyed = false;
  socket.writable = true;
  socket.writableFinished = false;
  socket.end = vi.fn(() => {
    socket.writable = false;
    log.push("end");
  });
  socket.destroy = vi.fn(() => {
    socket.destroyed = true;
    log.push("destroy");
  });
  const original = vi.fn();
  socket.destroySoon = original;
  return { socket, original };
}

function fakeIncoming(socket: FakeSocket | null, log: string[]): FakeIncoming {
  const incoming = new EventEmitter() as FakeIncoming;
  incoming.socket = socket;
  incoming.readableEnded = false;
  incoming.pause = vi.fn();
  incoming.dataListenersAtResume = [];
  incoming.resume = vi.fn(() => {
    log.push("resume");
    incoming.dataListenersAtResume.push(incoming.listenerCount("data"));
  });
  return incoming;
}

function harness(): Harness {
  const log: string[] = [];
  const { socket, original } = fakeSocket(log);
  return { log, socket, original, incoming: fakeIncoming(socket, log) };
}

const app = new Hono();
app.post("/x", (c) => {
  closeAfterRefusal(c);
  return c.json({ code: "x" }, 413);
});

function refuse(env?: Record<string, unknown>): Promise<Response> {
  return Promise.resolve(app.request("/x", { method: "POST" }, env));
}

// Events, in the order Node can produce them.
const e2 = (h: Harness): void => h.socket.destroySoon();
const e4 = (incoming: FakeIncoming): void => {
  incoming.readableEnded = true;
  incoming.emit("end");
};
const e5 = (h: Harness): void => {
  h.socket.emit("end");
};
const e7 = (h: Harness): void => {
  h.socket.destroyed = true;
  h.socket.emit("close");
};
const e8 = (h: Harness): void => {
  h.log.push("finish");
  h.socket.writableFinished = true;
  h.socket.emit("finish");
};

async function enterS1(h: Harness, incoming: FakeIncoming = h.incoming): Promise<Response> {
  const res = await refuse({ incoming });
  expect(res.headers.get("connection")).toBe("close");
  expect(typeof h.socket.destroySoon).toBe("function");
  expect(h.socket.destroySoon).not.toBe(h.original);
  expect(h.socket.end).not.toHaveBeenCalled();
  expect(h.socket.destroy).not.toHaveBeenCalled();
  expect(h.incoming.resume).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
  return res;
}

async function enterS2(h: Harness): Promise<void> {
  await enterS1(h);
  e2(h);
  expect(h.socket.end).toHaveBeenCalledTimes(1);
  expect(h.socket.destroy).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(1);
}

async function enterS3(h: Harness): Promise<void> {
  await enterS2(h);
  e4(h.incoming);
  expect(h.socket.end).toHaveBeenCalledTimes(1);
  expect(h.socket.destroy).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(1);
}

const D = 30_000;
let current: Harness[] = [];

function tracked(): Harness {
  const h = harness();
  current.push(h);
  return h;
}

beforeEach(() => {
  vi.useFakeTimers();
  linger.seconds = 30;
  linger.broken = false;
  current = [];
});

afterEach(() => {
  for (const h of current) {
    expect(h.original).not.toHaveBeenCalled();
    for (const call of h.socket.destroy.mock.calls) expect(call).toEqual([]);
  }
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("closeAfterRefusal", () => {
  it.each([
    ["no env at all", undefined],
    ["an env without incoming", {}],
    ["an incoming without a socket", { incoming: fakeIncoming(null, []) }],
  ])("U1: with %s it only declares the close", async (_name, env) => {
    const res = await refuse(env);

    expect(res.status).toBe(413);
    expect(res.headers.get("connection")).toBe("close");
  });

  it("U2: takes over the socket and starts nothing yet (S0 → S1)", async () => {
    const h = tracked();

    await enterS1(h);
  });

  it("U20: a deadline that cannot be read fails the refusal inside the request and leaves the socket alone", async () => {
    const h = tracked();
    linger.broken = true;

    const res = await refuse({ incoming: h.incoming });

    expect(res.status).toBe(500);
    expect(h.socket.destroySoon).toBe(h.original);
  });

  it("U3: a second refusal on the same socket replaces destroySoon only once (S1 × E1)", async () => {
    const h = tracked();
    await enterS1(h);
    const installed = h.socket.destroySoon;
    const second = fakeIncoming(h.socket, h.log);

    const res = await refuse({ incoming: second });
    e2(h);

    expect(res.headers.get("connection")).toBe("close");
    expect(h.socket.destroySoon).toBe(installed);
    expect(h.socket.end).toHaveBeenCalledTimes(1);
    expect(h.incoming.resume).toHaveBeenCalledTimes(1);
    expect(second.resume).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(1);
  });
});

describe("lingeringClose", () => {
  it("U4: half-closes, drops the web stream's data listener, keeps reading, arms an unref'd deadline (S1 × E2 → S2)", async () => {
    const h = tracked();
    h.incoming.on("data", () => h.incoming.pause());
    await enterS1(h);
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");

    e2(h);

    expect(h.socket.end).toHaveBeenCalledTimes(1);
    expect(h.log[0]).toBe("end");
    expect(h.incoming.resume).toHaveBeenCalledTimes(1);
    expect(h.incoming.dataListenersAtResume).toEqual([0]);
    expect(h.incoming.listenerCount("data")).toBe(0);
    expect(vi.getTimerCount()).toBe(1);
    expect(h.socket.destroy).not.toHaveBeenCalled();
    expect(setTimeoutSpy).toHaveBeenCalledTimes(1);
    const timer = setTimeoutSpy.mock.results[0]!.value as NodeJS.Timeout;
    expect(timer.hasRef()).toBe(false);
  });

  it("U5: a body already read waits for the write side, under a deadline (S1 × E2 → S3, E8 → S4)", async () => {
    const h = tracked();
    h.incoming.readableEnded = true;
    await enterS1(h);

    e2(h);
    expect(h.socket.end).toHaveBeenCalledTimes(1);
    expect(h.socket.destroy).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(1);

    e8(h);
    expect(h.socket.destroy).toHaveBeenCalledTimes(1);
    expect(h.log.indexOf("destroy")).toBeGreaterThan(h.log.indexOf("finish"));

    e7(h);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("U6: that same entry into S3 is still closed by the deadline (S3 × E6)", async () => {
    const h = tracked();
    h.incoming.readableEnded = true;
    await enterS1(h);
    e2(h);

    vi.advanceTimersByTime(D - 1);
    expect(h.socket.destroy).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(h.socket.destroy).toHaveBeenCalledTimes(1);
    expect(h.log).not.toContain("finish");
  });

  it("U7: a body already read and the write side already done closes at once, after end (S1 × E2 → S4)", async () => {
    const h = tracked();
    h.incoming.readableEnded = true;
    h.socket.writableFinished = true;
    await enterS1(h);

    e2(h);

    expect(h.log).toEqual(["end", "destroy"]);
    expect(h.socket.destroy).toHaveBeenCalledTimes(1);
    e7(h);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("U8: node-server's second destroySoon changes nothing (S2 × E3)", async () => {
    const h = tracked();
    await enterS2(h);

    e2(h);

    expect(h.socket.end).toHaveBeenCalledTimes(1);
    expect(h.incoming.resume).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(1);
    expect(h.socket.destroy).not.toHaveBeenCalled();
    vi.advanceTimersByTime(D);
    expect(h.socket.destroy).toHaveBeenCalledTimes(1);
  });

  it("U9: a write side that finished before the body ended closes the moment the body ends (S2 × E8, S2 × E4)", async () => {
    const h = tracked();
    await enterS2(h);

    e8(h);
    expect(h.socket.destroy).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(1);

    e4(h.incoming);
    expect(h.socket.destroy).toHaveBeenCalledTimes(1);

    e7(h);
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(2 * D);
    expect(h.socket.destroy).toHaveBeenCalledTimes(1);
  });

  it("U10: a body that ends before the write side finishes waits for it (S2 × E4 → S3, S3 × E3, S3 × E8)", async () => {
    const h = tracked();
    await enterS3(h);

    e2(h);
    expect(h.socket.end).toHaveBeenCalledTimes(1);
    expect(h.socket.destroy).not.toHaveBeenCalled();

    e8(h);
    expect(h.socket.destroy).toHaveBeenCalledTimes(1);
    expect(h.log.indexOf("destroy")).toBeGreaterThan(h.log.indexOf("finish"));

    e7(h);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("U11: the deadline counts from the start of lingering, also in S3 (S3 × E6)", async () => {
    const h = tracked();
    await enterS2(h);
    vi.advanceTimersByTime(1000);
    e4(h.incoming);
    expect(vi.getTimerCount()).toBe(1);

    vi.advanceTimersByTime(D - 1000 - 1);
    expect(h.socket.destroy).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(h.socket.destroy).toHaveBeenCalledTimes(1);
    expect(h.log).not.toContain("finish");
  });

  it("U12: the deadline closes at once without waiting for the write side (S2 × E6)", async () => {
    const h = tracked();
    await enterS2(h);

    vi.advanceTimersByTime(D - 1);
    expect(h.socket.destroy).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(h.socket.destroy).toHaveBeenCalledTimes(1);

    e7(h);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("U13: a socket closed by anyone clears the deadline (S2 × E7)", async () => {
    const h = tracked();
    await enterS2(h);

    e7(h);
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(2 * D);
    expect(h.socket.destroy).not.toHaveBeenCalled();
  });

  it("U14: a refusal arriving after the close only declares it (S4 × E1)", async () => {
    const h = tracked();
    await enterS2(h);
    const installed = h.socket.destroySoon;
    e8(h);
    e4(h.incoming);
    expect(h.socket.destroy).toHaveBeenCalledTimes(1);
    e7(h);
    const second = fakeIncoming(h.socket, h.log);

    const res = await refuse({ incoming: second });

    expect(res.headers.get("connection")).toBe("close");
    expect(h.socket.destroySoon).toBe(installed);
    expect(h.socket.end).toHaveBeenCalledTimes(1);
    expect(h.socket.destroy).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    expect(second.resume).not.toHaveBeenCalled();
  });

  it("U15: a refusal arriving while lingering only declares the close (S2 × E1)", async () => {
    const h = tracked();
    await enterS2(h);
    const installed = h.socket.destroySoon;
    const second = fakeIncoming(h.socket, h.log);

    const res = await refuse({ incoming: second });

    expect(res.headers.get("connection")).toBe("close");
    expect(h.socket.destroySoon).toBe(installed);
    expect(h.socket.end).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(1);
    expect(second.resume).not.toHaveBeenCalled();
  });

  it("U17: body end, FIN, deadline and a late destroySoon close only once", async () => {
    const h = tracked();
    await enterS2(h);
    e8(h);

    e4(h.incoming);
    expect(h.socket.destroy).toHaveBeenCalledTimes(1);
    e5(h);
    vi.advanceTimersByTime(D + 1);
    e2(h);

    expect(h.socket.destroy).toHaveBeenCalledTimes(1);
    expect(h.socket.end).toHaveBeenCalledTimes(1);
  });

  it("U18: a socket already destroyed when the response finishes is left alone", async () => {
    const h = tracked();
    await enterS1(h);
    h.socket.destroyed = true;

    e2(h);

    expect(h.socket.end).not.toHaveBeenCalled();
    expect(h.socket.destroy).not.toHaveBeenCalled();
    expect(h.incoming.resume).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("U19: each refusal reads the deadline", async () => {
    const a = tracked();
    const b = tracked();
    await refuse({ incoming: a.incoming });
    e2(a);
    linger.seconds = 7;
    await refuse({ incoming: b.incoming });
    e2(b);

    vi.advanceTimersByTime(7000);
    expect(b.socket.destroy).toHaveBeenCalledTimes(1);
    expect(a.socket.destroy).not.toHaveBeenCalled();
    vi.advanceTimersByTime(23_000);
    expect(a.socket.destroy).toHaveBeenCalledTimes(1);
  });
});
