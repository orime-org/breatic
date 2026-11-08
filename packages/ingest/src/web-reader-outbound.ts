// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Where every request the page reader's browser makes goes out (inner#1664):
 * addresses that name a machine directly are refused, and everything else is
 * sent again by this Worker, whose `fetch` reaches only the public internet in
 * production. Redirects come back to the browser, so each hop is judged here
 * again.
 */

/** How a request is sent on. */
export type SendOn = (request: Request, init: RequestInit) => Promise<Response>;

/**
 * Whether a host names a machine directly: an IP literal, or localhost.
 *
 * The URL parser has already turned every IPv4 spelling (`2130706433`,
 * `0x7f.1`) into dotted decimal and wrapped every IPv6 literal in brackets.
 * @param hostname - The URL's hostname.
 * @returns True when the request must not leave.
 */
function namesAMachine(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  return (
    /^\d{1,3}(\.\d{1,3}){3}$/.test(host) ||
    host.startsWith("[") ||
    host === "localhost" ||
    host.endsWith(".localhost")
  );
}

/**
 * Answer one request the browser made.
 * @param request - What the browser asked for.
 * @param send - How it is sent on; the Worker's own `fetch` by default.
 * @returns The answer, or a refusal.
 * @throws {never} Never; a failed send rejects with its own error.
 */
export async function webReaderOutbound(request: Request, send?: SendOn): Promise<Response> {
  if (namesAMachine(new URL(request.url).hostname)) return new Response("Not allowed", { status: 403 });
  const sendOn: SendOn = send ?? ((req, init) => fetch(req, init));
  return sendOn(request, { redirect: "manual" });
}
