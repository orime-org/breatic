// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * A caller that no longer wants the answer can say so.
 *
 * This layer used to have no way to be told. The reasoning was that a caller
 * could simply drop the promise and let the object be collected, and that the
 * three-delivery ceiling bounded how long an abandoned call could carry on.
 * Both remain true, and neither is enough for a person watching a screen: a
 * turn stopped while `web_fetch` is in flight would sit through the rest of
 * this call's deliveries and backoffs before it ended.
 *
 * Cancellation is not a shorter deadline and does not replace one. A deadline
 * is a statement about how long this delivery may take and is renewed for each
 * one; cancellation is a statement that the result is no longer wanted at all,
 * and it holds for the whole call. They are composed per delivery, which is
 * what keeps a single-shot signal from aborting every later delivery before it
 * leaves the ground.
 *
 * Stopping cleanly takes three separate things, and the tests below are one
 * per thing, because any one of them alone leaves the call running.
 */

import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { getEventListeners } from "node:events";
import { httpRequest } from "@shared/http/request.js";

let running: Server | null = null;

afterEach(async () => {
  if (running) {
    await new Promise<void>((resolve) => running?.close(() => resolve()));
    running = null;
  }
});

/** Count of requests the server has accepted so far. */
interface Stub {
  url: string;
  hits: () => number;
}

/**
 * Start a server that never answers, so only the caller can end the call.
 * @param onHit - Called with the hit count as each request arrives.
 * @returns Its URL and what it observed.
 */
async function silentServer(onHit?: (hit: number) => void): Promise<Stub> {
  let hit = 0;
  const server = createServer((req, _res) => {
    hit += 1;
    onHit?.(hit);
    req.resume();
    // Deliberately no reply: the only things that can end this delivery are
    // the deadline and the caller.
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  running = server;
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}/`, hits: (): number => hit };
}

/** Start a server that drops every connection, so every delivery fails. */
async function droppingServer(onHit?: (hit: number) => void): Promise<Stub> {
  let hit = 0;
  const server = createServer((req, res) => {
    hit += 1;
    onHit?.(hit);
    req.resume();
    res.socket?.destroy();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  running = server;
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}/`, hits: (): number => hit };
}

describe("a call the caller gave up on", () => {
  it("ends the delivery that is in flight", async () => {
    // Without this the signal reaches nothing at all: the deadline owns the
    // only abort controller a delivery has.
    const stub = await silentServer();
    const gaveUp = new AbortController();
    setTimeout(() => gaveUp.abort(new Error("user stopped")), 60);

    const started = Date.now();
    await expect(
      httpRequest(stub.url, {}, { replaySafe: true, timeoutMs: 30_000, signal: gaveUp.signal }),
    ).rejects.toThrow();
    // Ended by the caller, not by the 30s deadline.
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("does not deliver again", async () => {
    // The delivery that was cut short produced no response, so the retry
    // decision sees no status at all and takes the branch it takes for a
    // dropped connection — it retries. Ending the in-flight delivery without
    // this is a call that stops and immediately starts again.
    const stub = await droppingServer((hit) => {
      if (hit === 1) gaveUp.abort(new Error("user stopped"));
    });
    const gaveUp = new AbortController();

    await expect(
      httpRequest(stub.url, {}, { replaySafe: true, timeoutMs: 30_000, signal: gaveUp.signal }),
    ).rejects.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(stub.hits()).toBe(1);
  });

  it("does not sit out the backoff first", async () => {
    // Giving up during the wait between deliveries. Without an interruptible
    // wait the call still ends, just not until the backoff it was already in
    // has run its course — which is the delay the user sees after pressing
    // stop, for no work at all.
    const stub = await droppingServer();
    const gaveUp = new AbortController();
    // Well after the first delivery fails, so the call is in the backoff.
    setTimeout(() => gaveUp.abort(new Error("user stopped")), 120);

    const started = Date.now();
    await expect(
      httpRequest(stub.url, {}, { replaySafe: true, timeoutMs: 30_000, signal: gaveUp.signal }),
    ).rejects.toThrow();
    const elapsed = Date.now() - started;
    // The first backoff is drawn from a window up to a second, so a wait that
    // ran to completion would land well past this.
    expect(elapsed).toBeLessThan(600);
    expect(stub.hits()).toBe(1);
  });

  it("leaves nothing attached to the signal afterwards", async () => {
    // The interruptible wait is the one piece here that subscribes to the
    // caller's signal, and a signal outlives the call it was passed to -- one
    // per turn, many calls. A subscription left behind on every call is a leak
    // that grows with the turn.
    //
    // This measures only that piece. `AbortSignal.any` registers nothing
    // observable on its sources -- measured, the count is zero before and
    // after regardless -- so composition is not what this is watching.
    const stub = await droppingServer();
    const gaveUp = new AbortController();
    const attached = (): number => getEventListeners(gaveUp.signal, "abort").length;

    expect(attached()).toBe(0);
    await expect(
      httpRequest(stub.url, {}, { replaySafe: true, timeoutMs: 500, signal: gaveUp.signal }),
    ).rejects.toThrow();
    expect(attached()).toBe(0);
  });

  it("is not needed for a call that was never given one", async () => {
    // The parameter is optional, and its absence must not change anything:
    // most callers have no way to be stopped and pass nothing.
    const stub = await droppingServer();
    await expect(
      httpRequest(stub.url, {}, { replaySafe: false, timeoutMs: 500 }),
    ).rejects.toThrow();
    expect(stub.hits()).toBe(1);
  });
});
