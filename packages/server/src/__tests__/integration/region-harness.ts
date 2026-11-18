// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A stand-in for another region's internal listener (inner#1955), for suites
 * that run this process as one region and need the other side to answer over
 * real HTTP: `/internal/global/<fn>` and `/internal/region/<fn>` are both
 * served, each call is recorded with whether it carried a signature, and the
 * server can be told to never answer.
 */

import http from "node:http";
import type { AddressInfo } from "node:net";

/** One call the stand-in received. */
export interface ReceivedCall {
  /** `global` or `region`, from the path. */
  side: string;
  fn: string;
  args: unknown[];
  signed: boolean;
}

/** A refusal a stand-in function throws, answered with its status the way `serve()` answers an `AppError`. */
export class StandInRefusal extends Error {
  /**
   * @param status - The HTTP status to answer with.
   * @param code - The refusal code.
   */
  constructor(readonly status: number, readonly code: string) {
    super(code);
  }
}

/** How a function answers: a fixed result or one computed from the arguments. */
export type Answer = unknown | ((...args: unknown[]) => unknown);

/** A running stand-in. */
export interface RegionStandIn {
  /** Its base URL, for `GLOBAL_API_URL` or `REGION_API_URLS`. */
  url: string;
  /** Every call received since the last reset. */
  received: ReceivedCall[];
  /** Results by function name; a missing name answers `null`. */
  answers: Record<string, Answer>;
  /** Whether requests are answered or left hanging. */
  mode: "answer" | "hang";
  /** Clear calls and answers and go back to answering. */
  reset(): void;
  /** Stop listening and drop open connections. */
  close(): Promise<void>;
}

/**
 * Start a stand-in on a free local port.
 * @returns The running stand-in.
 */
export async function startRegionStandIn(): Promise<RegionStandIn> {
  const standIn: RegionStandIn = {
    url: "",
    received: [],
    answers: {},
    mode: "answer",
    reset(): void {
      this.received.length = 0;
      this.answers = {};
      this.mode = "answer";
    },
    close: async (): Promise<void> => {},
  };
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
    req.on("end", () => {
      const match = /^\/internal\/(global|region)\/([A-Za-z0-9_]+)$/.exec(req.url ?? "");
      const parsed = body === "" ? { args: [] } : (JSON.parse(body) as { args: unknown[] });
      standIn.received.push({
        side: match?.[1] ?? "unknown",
        fn: match?.[2] ?? "unknown",
        args: parsed.args,
        signed: typeof req.headers["x-internal-signature"] === "string",
      });
      if (standIn.mode === "hang") return;
      const answer = match === null ? null : standIn.answers[match[2]!];
      void Promise.resolve()
        .then(() => (typeof answer === "function" ? (answer as (...args: unknown[]) => unknown)(...parsed.args) : answer ?? null))
        .then((result) => {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ result }));
        })
        .catch((err: unknown) => {
          const refusal = err instanceof StandInRefusal ? err : null;
          res.writeHead(refusal?.status ?? 500, { "content-type": "application/json" });
          res.end(JSON.stringify({ code: refusal?.code ?? "stand_in_failed", message: String(err) }));
        });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  standIn.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  standIn.close = async (): Promise<void> => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  return standIn;
}
