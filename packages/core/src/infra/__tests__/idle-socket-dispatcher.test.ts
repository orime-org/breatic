// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * A socket that stops moving is cut (inner#1367).
 *
 * Real sockets: a server that stops reading lets the kernel buffers fill,
 * after which nothing more moves — the shape of a stalled upload.
 */

import { createServer, type Server, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";

import { describe, it, expect, afterEach } from "vitest";

import { idleSocketDispatcher } from "@core/infra/idle-socket-dispatcher.js";

const IDLE_MS = 400;
const BIG = 64 * 1024 * 1024;

let running: Server | null = null;

afterEach(async () => {
  if (running !== null) {
    const server = running;
    running = null;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

/**
 * Start a server that reads each body the way it is told to.
 * @param reading - `stall` reads one chunk and stops; `slow` reads it all and
 *   then answers in small steps; `drain` reads it all and answers at once.
 * @returns Its url.
 */
async function server(reading: "stall" | "slow" | "drain"): Promise<string> {
  const srv = createServer((req: IncomingMessage, res) => {
    if (reading === "stall") {
      req.once("data", () => req.pause());
      return;
    }
    req.resume();
    req.on("end", () => {
      if (reading === "drain") {
        res.end("ok");
        return;
      }
      // An answer trickled out in steps, each well inside the idle window.
      res.writeHead(200);
      let sent = 0;
      const step = setInterval(() => {
        res.write("o");
        sent += 1;
        if (sent === 10) {
          clearInterval(step);
          res.end("k");
        }
      }, IDLE_MS / 4);
    });
  });
  running = srv;
  await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", () => resolve()));
  return `http://127.0.0.1:${(srv.address() as AddressInfo).port}/`;
}

describe("idleSocketDispatcher", () => {
  it("cuts a send that stops moving within the idle window", async () => {
    const url = await server("stall");
    const dispatcher = idleSocketDispatcher(IDLE_MS);
    const started = Date.now();
    await expect(
      fetch(url, { method: "PUT", body: new Uint8Array(BIG), dispatcher } as RequestInit),
    ).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(10_000);
    await dispatcher.close();
  });

  it("lets a delivery whose bytes keep moving finish", async () => {
    const url = await server("slow");
    const dispatcher = idleSocketDispatcher(IDLE_MS);
    const res = await fetch(url, {
      method: "PUT",
      body: new Uint8Array(2 * 1024 * 1024),
      dispatcher,
    } as RequestInit);
    expect(await res.text()).toBe(`${"o".repeat(10)}k`);
    await dispatcher.close();
  });

  it("names the stall as the reason the request failed", async () => {
    const url = await server("stall");
    const dispatcher = idleSocketDispatcher(IDLE_MS);
    const failure = await fetch(url, {
      method: "PUT",
      body: new Uint8Array(BIG),
      dispatcher,
    } as RequestInit).catch((err: unknown) => err);
    expect(String((failure as { cause?: unknown }).cause)).toMatch(/no bytes moved for 400ms/);
    await dispatcher.close();
  });
});
