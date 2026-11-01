// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Raw-socket probes for how a body-limit refusal closes its connection
 * (inner#1782). Not a test file: `request-body-limit.integration.test.ts`
 * and `internal-api-gate.integration.test.ts` use it.
 *
 * Every time is `performance.now()`, the same clock on both sides, since the
 * client and the server run in one process. The server's close is read from
 * its own socket: a client that has already seen the FIN keeps writing
 * successfully for a while after the server destroyed the connection.
 */

import http from "node:http";
import net from "node:net";
import { performance } from "node:perf_hooks";
import { expect } from "vitest";

/** 64 KiB, the size of every block a probe writes. */
const BLOCK = 65_536;

/** The server-side sockets of one listening server, by the client's port. */
export interface ServerSockets {
  /**
   * When the server's socket for this client port closed.
   * @param clientPort - The client's local port.
   * @param withinMs - How long to wait before failing.
   * @returns The close time.
   */
  closedAt: (clientPort: number, withinMs: number) => Promise<number>;
  /** Destroy every socket still open and stop watching. */
  stop: () => void;
}

/**
 * Watch the sockets a server accepts from now on.
 * @param server - The listening server.
 * @returns The watcher.
 */
export function watchServerSockets(server: http.Server): ServerSockets {
  const sockets = new Map<number, { socket: net.Socket; closed: Promise<number> }>();
  /**
   * Record one accepted socket and when it closes.
   * @param socket - The server side of a connection.
   */
  const onConnection = (socket: net.Socket): void => {
    const closed = new Promise<number>((resolve) => socket.once("close", () => resolve(performance.now())));
    sockets.set(socket.remotePort ?? -1, { socket, closed });
  };
  server.on("connection", onConnection);
  return {
    closedAt: async (clientPort, withinMs) => {
      const entry = sockets.get(clientPort);
      if (!entry) throw new Error(`no server socket for client port ${clientPort}`);
      let timer: NodeJS.Timeout | undefined;
      const watchdog = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`server socket not closed within ${withinMs} ms`)), withinMs);
      });
      try {
        return await Promise.race([entry.closed, watchdog]);
      } finally {
        clearTimeout(timer);
      }
    },
    stop: () => {
      server.off("connection", onConnection);
      for (const { socket } of sockets.values()) if (!socket.destroyed) socket.destroy();
      sockets.clear();
    },
  };
}

/** A parsed HTTP response. */
export interface ParsedResponse {
  status: number;
  /** Lower-cased header names. */
  headers: Record<string, string>;
  body: string;
}

/**
 * Parse one complete HTTP/1.1 response from the start of the bytes. Both
 * apps answer a refusal with `Content-Length`.
 * @param bytes - What the client has read so far.
 * @returns The response, or null while it is incomplete.
 */
function parseResponse(bytes: Buffer): ParsedResponse | null {
  const headEnd = bytes.indexOf("\r\n\r\n");
  if (headEnd < 0) return null;
  const [statusLine, ...lines] = bytes.subarray(0, headEnd).toString("latin1").split("\r\n");
  const status = Number.parseInt(statusLine!.split(" ")[1] ?? "", 10);
  const headers: Record<string, string> = {};
  for (const line of lines) {
    const colon = line.indexOf(":");
    headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
  }
  const rest = bytes.subarray(headEnd + 4);
  if (headers["content-length"] === undefined) return null;
  const length = Number.parseInt(headers["content-length"], 10);
  if (rest.length < length) return null;
  return { status, headers, body: rest.subarray(0, length).toString("utf-8") };
}

/** What a raw-socket upload saw. */
export interface Upload {
  client: net.Socket;
  /** When the request head was written. */
  t0: number;
  /** When the last write of the body was called. */
  tLast: number;
  /** When a complete response had been read; undefined when none arrived. */
  t413?: number;
  /** When the client saw the server's FIN. */
  tFin?: number;
  /** The first client error and when it happened. */
  error?: { code: string; at: number };
  response: ParsedResponse | null;
}

/** How a probe uploads its body. */
export interface UploadPlan {
  port: number;
  path: string;
  /** Content-Length to declare; chunked transfer when omitted. */
  contentLength?: number;
  /** How many 64 KiB blocks to write. */
  blocks: number;
  /** Pause after each block's write callback, in ms; 0 for none. */
  pauseMs: number;
  /** Send the chunked terminator after the last block. */
  terminate: boolean;
  /** Read nothing until the whole body is written. */
  readAfterUpload: boolean;
}

/**
 * Write one piece and wait for its callback.
 * @param socket - The client socket.
 * @param piece - The bytes.
 * @returns The write error, if any.
 */
function writeAndWait(socket: net.Socket, piece: Buffer | string): Promise<Error | null | undefined> {
  return new Promise((resolve) => {
    if (socket.destroyed) {
      resolve(new Error("socket destroyed"));
      return;
    }
    socket.write(piece, (err) => resolve(err));
  });
}

/**
 * Upload a body over a raw half-open socket, then read the answer. The
 * client never sends FIN, so the server closes only on the body's end or
 * its deadline.
 * @param plan - What to send.
 * @returns What the client saw; the socket stays open for the caller to destroy.
 */
export async function rawUpload(plan: UploadPlan): Promise<Upload> {
  const client = net.connect({ host: "127.0.0.1", port: plan.port, allowHalfOpen: true });
  await new Promise<void>((resolve, reject) => {
    client.once("connect", () => resolve());
    client.once("error", reject);
  });
  const result: Upload = { client, t0: 0, tLast: 0, response: null };
  const received: Buffer[] = [];
  client.on("error", (err: NodeJS.ErrnoException) => {
    result.error ??= { code: err.code ?? err.message, at: performance.now() };
  });
  client.on("end", () => {
    result.tFin ??= performance.now();
  });
  const answered = new Promise<void>((resolve) => {
    client.on("data", (d: Buffer) => {
      received.push(d);
      if (result.response === null) {
        result.response = parseResponse(Buffer.concat(received));
        if (result.response !== null) {
          result.t413 = performance.now();
          resolve();
        }
      }
    });
    client.once("close", () => resolve());
  });
  if (plan.readAfterUpload) client.pause();

  const framing = plan.contentLength === undefined ? "Transfer-Encoding: chunked" : `Content-Length: ${plan.contentLength}`;
  result.t0 = performance.now();
  await writeAndWait(client, `POST ${plan.path} HTTP/1.1\r\nHost: 127.0.0.1:${plan.port}\r\nContent-Type: application/octet-stream\r\n${framing}\r\n\r\n`);
  const block = Buffer.alloc(BLOCK, 0x20);
  const piece = plan.contentLength === undefined ? Buffer.concat([Buffer.from(`${BLOCK.toString(16)}\r\n`), block, Buffer.from("\r\n")]) : block;
  for (let i = 0; i < plan.blocks; i++) {
    result.tLast = performance.now();
    if (await writeAndWait(client, piece)) break;
    if (plan.pauseMs > 0) await new Promise((r) => setTimeout(r, plan.pauseMs));
  }
  if (plan.terminate && !client.destroyed) {
    result.tLast = performance.now();
    await writeAndWait(client, "0\r\n\r\n");
  }
  if (plan.readAfterUpload) client.resume();
  await Promise.race([answered, new Promise((r) => setTimeout(r, 5000))]);
  return result;
}

/**
 * Upload 20 MiB slowly from a client that reads only afterwards, and check
 * it gets the whole 413 and the server closes once the body ends.
 * @param server - The listening server.
 * @param baseUrl - Its base URL.
 * @param path - Where the body goes.
 * @param chunked - Send it chunked; with a declared length otherwise.
 * @returns The 413, for the caller to check its body.
 */
export async function expectWholeAnswerThenCloseAtBodyEnd(
  server: http.Server,
  baseUrl: string,
  path: string,
  chunked: boolean,
): Promise<ParsedResponse> {
  const blocks = 320;
  const watch = watchServerSockets(server);
  let upload: Upload | undefined;
  try {
    upload = await rawUpload({
      port: Number(new URL(baseUrl).port),
      path,
      contentLength: chunked ? undefined : blocks * BLOCK,
      blocks,
      pauseMs: 20,
      terminate: chunked,
      readAfterUpload: true,
    });
    expect(upload.tLast - upload.t0).toBeLessThan(20_000);
    expect(upload.response?.status).toBe(413);
    expect(upload.response?.headers.connection?.toLowerCase()).toBe("close");
    const tClose = await watch.closedAt(upload.client.localPort!, 30_000 + 5000);
    expect(tClose).toBeGreaterThanOrEqual(upload.tLast);
    expect(tClose - upload.tLast).toBeLessThanOrEqual(2000);
    expect(upload.error).toBeUndefined();
    expect(upload.tFin).toBeDefined();
    expect(upload.tFin! - upload.tLast).toBeLessThan(2000);
    return upload.response!;
  } finally {
    upload?.client.destroy();
    watch.stop();
  }
}

/** One round of a refused chunked request followed by a GET on the same agent. */
interface RefusedThenNext {
  refused: { status: number; headers: http.IncomingHttpHeaders; body: string };
  next: { status: number; reusedSocket: boolean; error?: string };
}

/** How the refused body is sent and when the next request follows. */
export interface RefusedThenNextOptions {
  /** Bytes of chunked body to write before ending it; endless (until answered) when omitted. */
  total?: number;
  /** Wait this long after the answer before the GET; 0 by default. */
  delayMs?: number;
}

/**
 * Send a chunked body over the limit, read the answer, end the request, then
 * send a GET through the same agent.
 * @param baseUrl - The server.
 * @param agent - A keep-alive agent with one socket.
 * @param postPath - Where the body goes.
 * @param getPath - Where the next request goes.
 * @param opts - The body's size and the GET's delay.
 * @returns Both answers.
 */
async function refusedThenNext(
  baseUrl: string,
  agent: http.Agent,
  postPath: string,
  getPath: string,
  opts: RefusedThenNextOptions = {},
): Promise<RefusedThenNext> {
  const url = new URL(baseUrl);
  const refused = await new Promise<RefusedThenNext["refused"]>((resolve, reject) => {
    let answered = false;
    const req = http.request({
      host: url.hostname,
      port: url.port,
      path: postPath,
      method: "POST",
      agent,
      headers: { "Content-Type": "application/octet-stream", "Transfer-Encoding": "chunked" },
    });
    req.on("response", (res) => {
      answered = true;
      const parts: Buffer[] = [];
      res.on("data", (d: Buffer) => parts.push(d));
      res.on("end", () => {
        req.end();
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(parts).toString("utf-8") });
      });
    });
    req.on("error", (err) => {
      if (!answered) reject(err);
    });
    const block = Buffer.alloc(BLOCK, 0x20);
    void (async () => {
      for (let sent = 0; !answered && !req.destroyed && (opts.total === undefined || sent < opts.total); sent += BLOCK) {
        const piece = opts.total === undefined ? block : block.subarray(0, Math.min(BLOCK, opts.total - sent));
        if (!req.write(piece)) await new Promise<void>((done) => {
          const timer = setTimeout(done, 200);
          req.once("drain", () => {
            clearTimeout(timer);
            done();
          });
        });
      }
      if (opts.total !== undefined && !req.destroyed) req.end();
    })();
  });
  if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
  const next = await new Promise<RefusedThenNext["next"]>((resolve) => {
    const req = http.request({ host: url.hostname, port: url.port, path: getPath, method: "GET", agent }, (res) => {
      res.resume();
      res.on("end", () => resolve({ status: res.statusCode ?? 0, reusedSocket: req.reusedSocket }));
    });
    req.on("error", (err: NodeJS.ErrnoException) => resolve({ status: 0, reusedSocket: req.reusedSocket, error: err.code ?? err.message }));
    req.end();
  });
  return { refused, next };
}

/**
 * The status a GET gets on a connection of its own.
 * @param baseUrl - The server.
 * @param path - The path.
 * @returns The status code.
 */
function freshGetStatus(baseUrl: string, path: string): Promise<number> {
  const url = new URL(baseUrl);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: url.hostname, port: url.port, path, method: "GET", agent: false }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode ?? 0));
    });
    req.on("error", reject);
    req.end();
  });
}

/**
 * Over several rounds on one keep-alive socket, send a chunked body the
 * server refuses, then a GET through the same agent, and check each refusal
 * says `Connection: close` and each GET goes out on a new connection.
 * @param baseUrl - The server.
 * @param postPath - Where the refused body goes.
 * @param getPath - Where the next request goes.
 * @param rounds - How many rounds.
 * @param opts - The body's size and the GET's delay.
 * @returns The last refusal's body, for the caller to check.
 */
export async function expectNextOnNewConnection(
  baseUrl: string,
  postPath: string,
  getPath: string,
  rounds: number,
  opts: RefusedThenNextOptions = {},
): Promise<string> {
  const fresh = await freshGetStatus(baseUrl, getPath);
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  let body = "";
  try {
    for (let round = 0; round < rounds; round++) {
      const { refused, next } = await refusedThenNext(baseUrl, agent, postPath, getPath, opts);
      expect(refused.status).toBe(413);
      expect(refused.headers.connection).toBe("close");
      expect(next.error).toBeUndefined();
      expect(next.status).toBe(fresh);
      expect(next.reusedSocket).toBe(false);
      body = refused.body;
    }
  } finally {
    agent.destroy();
  }
  return body;
}
