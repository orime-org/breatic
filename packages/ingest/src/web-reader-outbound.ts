// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Where every request the page reader's browser makes goes out (inner#1664):
 * addresses that name a machine directly are refused, and everything else is
 * sent again by this Worker, which reaches only the public internet.
 */

/** How a request is sent on. */
export type SendOn = (request: Request, init: RequestInit) => Promise<Response>;

/**
 * Answer one request the browser made.
 * @param request - What the browser asked for.
 * @param send - How it is sent on; the Worker's own `fetch` by default.
 * @returns The answer, or a refusal.
 * @throws {Error} Always, until implemented.
 */
export async function webReaderOutbound(request: Request, send?: SendOn): Promise<Response> {
  void [request, send];
  throw new Error("not implemented: webReaderOutbound");
}
