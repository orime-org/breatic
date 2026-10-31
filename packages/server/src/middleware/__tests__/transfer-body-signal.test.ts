// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * A client that leaves while a transfer reference waits on its read lock is
 * heard through the request `acceptTransferBody` rebuilds, so the stream
 * behind it stops and finishes (inner#1006 round 3 F1).
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import type { ServerType } from "@hono/node-server";
import type { AddressInfo } from "node:net";

const service = vi.hoisted(() => ({ readTransferReference: vi.fn() }));
vi.mock("@server/modules", () => ({ transferReferenceService: service }));

import { acceptTransferBody } from "@server/middleware/transfer-body.js";
import { streamUntilClientLeaves } from "@server/utils/sse-stream.js";

let server: ServerType | undefined;

afterEach(async () => {
  await new Promise<void>((resolve) => {
    if (server === undefined) resolve();
    else server.close(() => resolve());
  });
  server = undefined;
});

describe("acceptTransferBody on a real node server", () => {
  it("passes on a client leaving during the read-lock wait", async () => {
    // The read-lock wait: another read of this user holds the lock.
    service.readTransferReference.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 300));
      return { kind: "ok", text: JSON.stringify({ message: "hi" }) };
    });
    const run = { signal: undefined as AbortSignal | undefined, ended: false };
    const app = new Hono<{ Variables: { user: { id: string } } }>();
    app.use(async (c, next) => {
      c.set("user", { id: "user-1" });
      await next();
    });
    app.post("/", acceptTransferBody("chat_message"), (c) =>
      streamUntilClientLeaves(c, async (s, stopped) => {
        run.signal = stopped;
        // A stopped run still has its last words to write before it ends.
        for (let i = 0; i < 5; i++) await s.write(`data: ${i}\n\n`);
        run.ended = true;
      }),
    );
    server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" });
    await new Promise((resolve) => server?.once("listening", resolve));
    const { port } = server.address() as AddressInfo;

    const leaving = new AbortController();
    setTimeout(() => leaving.abort(), 100);
    await expect(
      fetch(`http://127.0.0.1:${port}/`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ transfer: "transfer/user-1/key" }),
        signal: leaving.signal,
      }),
    ).rejects.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 500));

    expect(service.readTransferReference).toHaveBeenCalledTimes(1);
    expect(run.signal?.aborted).toBe(true);
    expect(run.ended).toBe(true);
  });
});
