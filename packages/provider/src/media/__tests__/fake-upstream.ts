// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/** One request a fake upstream received. */
export interface Seen {
  method: string;
  path: string;
  body: unknown;
  authorization: string | undefined;
}

/** How a fake upstream answers one request: a status and JSON body, a reset after the request arrived, or no answer. */
export type Reply = { status: number; body?: unknown } | "reset" | "hang";

/** Answers a request by its method and path; the default answers 404. */
export type Route = (req: { method: string; path: string; body: unknown }) => Reply | undefined;

/** A loopback HTTP server standing in for an upstream, recording what it received. */
export interface FakeUpstream {
  url: string;
  seen: Seen[];
  /** Replace how it answers. */
  answer: (route: Route) => void;
  close: () => Promise<void>;
}

/**
 * Read a request body as JSON, or as the raw text when it is not JSON.
 * @param req - The request.
 * @returns The body; undefined when empty.
 */
async function bodyOf(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  if (text === "") return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

/**
 * Write one reply.
 * @param req - The request, destroyed for a reset.
 * @param res - The response.
 * @param reply - What to answer.
 */
function write(req: IncomingMessage, res: ServerResponse, reply: Reply): void {
  if (reply === "reset") {
    req.socket.destroy();
    return;
  }
  if (reply === "hang") return;
  res.writeHead(reply.status, { "content-type": "application/json" });
  res.end(reply.body === undefined ? "" : JSON.stringify(reply.body));
}

/**
 * Start a fake upstream on a loopback port.
 * @param route - How it answers at first.
 * @returns The fake.
 */
export async function fakeUpstream(route: Route = () => undefined): Promise<FakeUpstream> {
  const seen: Seen[] = [];
  let current = route;
  const server: Server = createServer((req, res) => {
    void bodyOf(req).then((body) => {
      const method = req.method ?? "GET";
      const path = (req.url ?? "/").split("?")[0] ?? "/";
      seen.push({ method, path, body, authorization: req.headers.authorization });
      write(req, res, current({ method, path, body }) ?? { status: 404, body: { message: "no route" } });
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", () => done()));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    seen,
    answer: (next) => {
      current = next;
    },
    close: () => new Promise<void>((done) => server.close(() => done())),
  };
}

/** WaveSpeed's answer to a submit it accepted. */
export const accepted = (id: string): Reply => ({ status: 200, body: { code: 200, data: { id, status: "created", outputs: [] } } });

/** WaveSpeed's answer to a submit that finished at once. */
export const finishedAtOnce = (id: string, outputs: unknown[]): Reply => ({
  status: 200,
  body: { code: 200, data: { id, status: "completed", outputs } },
});

/** WaveSpeed's answer to a result question. */
export const result = (id: string, status: "processing" | "completed" | "failed", outputs: unknown[] = [], error = ""): Reply => ({
  status: 200,
  body: { code: 200, data: { id, status, outputs, error } },
});

/** WaveSpeed's billing answer: each line a deduct or refund of that many dollars. */
export const billing = (lines: { type: "deduct" | "refund"; price: number }[]): Reply => ({
  status: 200,
  body: { code: 200, data: { items: lines.map((l) => ({ billing_type: l.type, order: { price: l.price } })) } },
});

/**
 * The ids a WaveSpeed billing search asked about.
 * @param seen - What the fake received.
 * @returns Every prediction id in a billing search, in order.
 */
export function billedIds(seen: readonly Seen[]): string[] {
  return seen
    .filter((s) => s.method === "POST" && s.path === "/billings/search")
    .flatMap((s) => ((s.body as { prediction_uuids?: string[] }).prediction_uuids ?? []));
}

/**
 * The paid submits a fake received: POSTs other than billing searches.
 * @param seen - What the fake received.
 * @returns Them, in order.
 */
export function submits(seen: readonly Seen[]): Seen[] {
  return seen.filter((s) => s.method === "POST" && s.path !== "/billings/search");
}
