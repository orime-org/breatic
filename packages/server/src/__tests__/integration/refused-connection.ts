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

/** 64 KiB, the size of every block a probe writes. */
export const BLOCK = 65_536;

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
 * Parse one complete HTTP/1.1 response from the start of the bytes.
 * @param bytes - What the client has read so far.
 * @returns The response, or null while it is incomplete.
 */
export function parseResponse(bytes: Buffer): ParsedResponse | null {
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
  if (headers["content-length"] !== undefined) {
    const length = Number.parseInt(headers["content-length"], 10);
    if (rest.length < length) return null;
    return { status, headers, body: rest.subarray(0, length).toString("utf-8") };
  }
  const parts: Buffer[] = [];
  let at = 0;
  for (;;) {
    const sizeEnd = rest.indexOf("\r\n", at);
    if (sizeEnd < 0) return null;
    const size = Number.parseInt(rest.subarray(at, sizeEnd).toString("latin1"), 16);
    if (size === 0) return rest.indexOf("\r\n", sizeEnd + 2) < 0 ? null : { status, headers, body: Buffer.concat(parts).toString("utf-8") };
    if (rest.length < sizeEnd + 2 + size + 2) return null;
    parts.push(rest.subarray(sizeEnd + 2, sizeEnd + 2 + size));
    at = sizeEnd + 2 + size + 2;
  }
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

/** One round of an endless chunked request followed by a GET on the same agent. */
export interface RefusedThenNext {
  refused: { status: number; headers: http.IncomingHttpHeaders; body: string; errorBeforeAnswer?: string };
  next: { status: number; reusedSocket: boolean; error?: string };
}

/**
 * Send a chunked body that never ends until answered, read the answer, end
 * the request, then send a GET through the same agent at once.
 * @param baseUrl - The server.
 * @param agent - A keep-alive agent with one socket.
 * @param postPath - Where the endless body goes.
 * @param getPath - Where the next request goes.
 * @returns Both answers.
 */
export async function refusedThenNext(baseUrl: string, agent: http.Agent, postPath: string, getPath: string): Promise<RefusedThenNext> {
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
      while (!answered && !req.destroyed) {
        if (!req.write(block)) await new Promise<void>((done) => {
          const timer = setTimeout(done, 200);
          req.once("drain", () => {
            clearTimeout(timer);
            done();
          });
        });
      }
    })();
  });
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
export function freshGetStatus(baseUrl: string, path: string): Promise<number> {
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
