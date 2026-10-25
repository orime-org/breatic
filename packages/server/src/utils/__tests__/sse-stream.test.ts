// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { afterEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import type { ServerType } from "@hono/node-server";
import type { AddressInfo } from "node:net";
import { streamUntilClientLeaves } from "@server/utils/sse-stream.js";

let server: ServerType | undefined;

afterEach(async () => {
  await new Promise<void>((resolve) => {
    if (server === undefined) resolve();
    else server.close(() => resolve());
  });
  server = undefined;
});

describe("streamUntilClientLeaves on a real node server", () => {
  it("stops and finishes the run of a client that left before the stream began", async () => {
    const run = { signal: undefined as AbortSignal | undefined, ended: false };
    const app = new Hono();
    app.post("/", async (c) => {
      // The read-lock wait: the client leaves while the handler is busy.
      await new Promise((resolve) => setTimeout(resolve, 300));
      return streamUntilClientLeaves(c, async (s, stopped) => {
        run.signal = stopped;
        // A stopped run still has its last words to write before it ends.
        for (let i = 0; i < 5; i++) await s.write(`data: ${i}\n\n`);
        run.ended = true;
      });
    });
    server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" });
    await new Promise((resolve) => server?.once("listening", resolve));
    const { port } = server.address() as AddressInfo;

    const leaving = new AbortController();
    setTimeout(() => leaving.abort(), 100);
    await expect(
      fetch(`http://127.0.0.1:${port}/`, { method: "POST", body: "{}", signal: leaving.signal }),
    ).rejects.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 500));

    expect(run.signal?.aborted).toBe(true);
    expect(run.ended).toBe(true);
  });
});
