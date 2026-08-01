// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * What happens to a half-arrived asset on the way to disk.
 *
 * Written to settle a claim rather than to confirm one: an adversarial round
 * held that this path was missing the truncation check its sibling in
 * `@breatic/core` performs, and that the asymmetry was a hole. Measured
 * against real chunked and length-declaring servers,
 * it is not — but the real dividing line is not the one either side named.
 *
 * What divides the cases is whether the response DECLARED a length:
 *   - content-length present → a short body throws, encoded or not. The client
 *     catches it; a check of ours would be redundant.
 *   - no content-length (chunked) → the short read is SILENT, encoded or not,
 *     and no check can catch it because there is no declared number to compare
 *     against.
 *
 * Both are pinned below, the second one deliberately: it records a limit we
 * know we have. If a future client starts raising on it, this test turns red
 * and tells us the limit is gone.
 *
 * Driven against a real HTTP server — a truncated transfer is a socket-level
 * event that a mocked fetch cannot produce.
 */

import { createServer, type Server } from "node:http";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

vi.mock("@breatic/core", () => ({
  logger: { warn: (): void => {}, error: (): void => {}, info: (): void => {} },
}));

const { downloadToTempDir } = await import("@worker/handlers/local/runtime/download.js");

let server: Server;
let base: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === "/declared-but-short") {
      // Declares 100 bytes, sends 10, ends cleanly.
      res.writeHead(200, { "content-length": "100", "content-type": "video/mp4" });
      res.write("0123456789");
      res.end();
      return;
    }
    if (req.url === "/chunked-and-short") {
      // No content-length at all, so nothing declares how much was owed.
      res.writeHead(200, { "content-type": "video/mp4" });
      res.write("0123456789");
      res.end();
      return;
    }
    if (req.url === "/empty") {
      res.writeHead(200, { "content-length": "0", "content-type": "video/mp4" });
      res.end();
      return;
    }
    res.writeHead(200, { "content-length": "5", "content-type": "video/mp4" });
    res.end("whole");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("downloadToTempDir — what reaches the disk", () => {
  it("writes a complete body through to disk", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dl-ok-"));
    const path = await downloadToTempDir(`${base}/whole.mp4`, dir);

    expect(await readFile(path, "utf8")).toBe("whole");
  });

  it("fails a transfer that fell short of a declared content-length", async () => {
    // The error text comes from the HTTP client, not from us, so this asserts
    // that it fails rather than how it words it — pinning someone else's
    // message would break on a dependency bump for no gain.
    const dir = await mkdtemp(join(tmpdir(), "dl-short-"));

    await expect(downloadToTempDir(`${base}/declared-but-short`, dir)).rejects.toThrow();
  });

  it("still refuses a body with no bytes at all", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dl-empty-"));

    await expect(downloadToTempDir(`${base}/empty`, dir)).rejects.toThrow(/0 bytes/);
  });

  it("KNOWN LIMIT: a chunked response that stops early is accepted", async () => {
    // Not an endorsement — a record. With no declared length there is nothing
    // to compare the bytes against, so a short chunked body is indistinguishable
    // from a complete small one, here and in the sibling path in core alike.
    // The gap is left open knowingly: our own storage and every vendor we fetch
    // from sends a content-length. Should that stop being true, or should the
    // client start raising on it, this test is where we find out.
    const dir = await mkdtemp(join(tmpdir(), "dl-chunked-"));
    const path = await downloadToTempDir(`${base}/chunked-and-short`, dir);

    expect((await stat(path)).size).toBe(10);
  });
});
