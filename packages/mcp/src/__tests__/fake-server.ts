// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

/** One request the fake server saw. */
export interface SeenRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
}

/** What the fake server answers. */
export interface FakeAnswer {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

/** A running fake server. */
export interface FakeServer {
  /** Its base URL, `http://127.0.0.1:<port>/api/v1`. */
  baseUrl: string;
  seen: SeenRequest[];
  close: () => Promise<void>;
}

/**
 * Start an HTTP server that answers each request with `answer(request)`.
 * @param answer - What to answer; paths are relative to `/api/v1`.
 * @returns The server.
 */
export async function startFakeServer(answer: (req: SeenRequest) => FakeAnswer): Promise<FakeServer> {
  const seen: SeenRequest[] = [];
  const server: Server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk: Buffer) => (raw += chunk.toString()));
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "http://fake");
      const request: SeenRequest = {
        method: req.method ?? "GET",
        path: url.pathname.replace(/^\/api\/v1/, ""),
        query: url.searchParams,
        headers: req.headers,
        body: raw === "" ? undefined : (JSON.parse(raw) as unknown),
      };
      seen.push(request);
      const out = answer(request);
      res.writeHead(out.status, { "content-type": "application/json", ...out.headers });
      res.end(out.body === undefined ? "" : JSON.stringify(out.body));
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  return {
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`,
    seen,
    close: () => new Promise<void>((done) => server.close(() => done())),
  };
}
