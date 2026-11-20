// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Test servers listen on 127.0.0.1 (#1478). A port bound on every address can
 * also be held on 127.0.0.1 by another local process, which then takes the
 * test's connections; the setup file refuses such a listen in every Node test
 * config that starts servers.
 */

import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";

const started: Server[] = [];

/**
 * Listen and wait for it, keeping the server for cleanup.
 * @param listen - Starts the listen on the given server.
 * @returns Once the server is listening.
 */
async function listening(listen: (server: Server) => void): Promise<void> {
  const server = createServer();
  started.push(server);
  await new Promise<void>((done) => {
    server.once("listening", () => done());
    listen(server);
  });
}

afterEach(async () => {
  for (const server of started.splice(0)) {
    if (server.listening) await new Promise<void>((done) => server.close(() => done()));
  }
});

describe("the loopback listen guard", () => {
  it.each([
    ["a port alone", (server: Server) => server.listen(0)],
    ["a port and a callback", (server: Server) => server.listen(0, () => undefined)],
    ["options without a host", (server: Server) => server.listen({ port: 0 })],
    ["no arguments", (server: Server) => server.listen()],
  ])("refuses %s", (_name, listen) => {
    const server = createServer();
    expect(() => listen(server)).toThrow(/127\.0\.0\.1/);
    expect(server.listening).toBe(false);
  });

  it("lets a port on 127.0.0.1 listen, given as an argument or an option", async () => {
    await listening((server) => server.listen(0, "127.0.0.1"));
    await listening((server) => server.listen({ port: 0, host: "127.0.0.1" }));
    expect(started.every((server) => server.listening)).toBe(true);
  });

  it("lets a unix socket path listen", async () => {
    await listening((server) => server.listen(join(tmpdir(), `loopback-${randomUUID()}.sock`)));
    expect(started[0]?.listening).toBe(true);
  });

  it("is loaded by every Node test config that starts servers", () => {
    const root = resolve(import.meta.dirname, "../../../..");
    for (const config of [
      "packages/collab/vitest.config.ts",
      "packages/collab/vitest.integration.config.ts",
      "packages/server/vitest.config.ts",
      "packages/server/vitest.integration.config.ts",
      "packages/integration-tests/vitest.integration.config.ts",
    ]) {
      expect(readFileSync(join(root, config), "utf8"), config).toContain('"@breatic/integration-tests/loopback-listen"');
    }
  });
});
