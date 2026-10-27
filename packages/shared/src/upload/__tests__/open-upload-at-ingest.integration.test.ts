// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * T23 (inner#1595 test spec §3, the fourth part of the proof for acceptance
 * item 5): opening an upload is never replayed by the real transport.
 *
 * The Worker opens a fresh multipart upload on every `POST /uploads` it
 * processes, so one ticket opens at most one upload only if no layer sends the
 * open twice. The unit tests read what `openUploadAtIngest` declares; this
 * counts what actually reaches a loopback server through the real
 * `httpRequest`, for the three answers a replay-safe call would be resent on:
 * a 5xx, a dropped connection, and a 5xx naming a Worker failure.
 *
 * 408 and 429 are resent by protocol whatever the caller declares (they state
 * the request was not processed, so nothing was opened); P03 in
 * `http/__tests__/decide-retry.test.ts` holds that rule.
 */

import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { describe, it, expect, afterEach } from "vitest";

import { openUploadAtIngest, UploadHttpError } from "@shared/upload/ingest-client.js";
import { INGEST_FAILURE_HEADER } from "@shared/upload/ingest-failure.js";

const SECRET = "shared-secret";

/** How the stub answers every `POST /uploads`. */
type Behaviour =
  | { kind: "status"; status: number; headers?: Record<string, string> }
  | { kind: "destroy" };

let running: Server | null = null;

afterEach(async () => {
  if (running !== null) {
    const server = running;
    running = null;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

/** What the stub saw. */
interface Stub {
  url: string;
  /** Every `POST /uploads` received, as its request headers. */
  opens: () => Array<Record<string, string | string[] | undefined>>;
}

/**
 * Start a loopback server that answers every request the same way.
 * @param behaviour - What to answer with.
 * @returns Its base URL (no trailing slash) and what it received.
 */
async function stubWorker(behaviour: Behaviour): Promise<Stub> {
  const opens: Array<Record<string, string | string[] | undefined>> = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.method === "POST" && req.url === "/uploads") opens.push({ ...req.headers });
    if (behaviour.kind === "destroy") {
      // The request headers have arrived; drop the connection with no answer.
      req.socket.destroy();
      return;
    }
    req.resume();
    req.on("end", () => {
      res.writeHead(behaviour.status, { "content-type": "application/json", ...behaviour.headers });
      res.end("{}");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  running = server;
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, opens: () => opens };
}

/**
 * Open an upload at the stub.
 * @param uploadUrl - The stub's base URL.
 * @returns The open's promise.
 */
function openAt(uploadUrl: string): Promise<unknown> {
  return openUploadAtIngest(
    { ticket: "signed-ticket", uploadUrl, partSize: 8 * 1024 * 1024, totalParts: 1 },
    SECRET,
    { timeoutMs: 5000 },
  );
}

describe("T23 the real transport does not replay opening an upload", () => {
  it("(a) a 503 is delivered once and refused as UploadHttpError", async () => {
    const stub = await stubWorker({ kind: "status", status: 503 });

    await expect(openAt(stub.url)).rejects.toBeInstanceOf(UploadHttpError);

    expect(stub.opens()).toHaveLength(1);
    expect(stub.opens()[0]?.["x-ingest-secret"]).toBe(SECRET);
  });

  it("(b) a connection dropped after the request headers is delivered once and fails in the transport", async () => {
    const stub = await stubWorker({ kind: "destroy" });

    const failure = await openAt(stub.url).then(
      () => null,
      (err: unknown) => err,
    );

    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(UploadHttpError);
    expect(stub.opens()).toHaveLength(1);
    expect(stub.opens()[0]?.["x-ingest-secret"]).toBe(SECRET);
  });

  it("(c) a 500 naming assemble_failed is delivered once and carries the code", async () => {
    const stub = await stubWorker({
      kind: "status",
      status: 500,
      headers: { [INGEST_FAILURE_HEADER]: "assemble_failed" },
    });

    const refused = openAt(stub.url);
    await expect(refused).rejects.toBeInstanceOf(UploadHttpError);
    await expect(refused).rejects.toMatchObject({ status: 500, code: "assemble_failed" });

    expect(stub.opens()).toHaveLength(1);
    expect(stub.opens()[0]?.["x-ingest-secret"]).toBe(SECRET);
  });
});
