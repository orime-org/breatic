// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What the MCP service checks at startup and on `/healthz` (breatic#1488 §13):
 * the server it exchanges tokens with, and Redis DB 4 it sends commands on.
 */

import { HEALTH_CHECK_TIMEOUT_MS } from "@breatic/core";
import { httpRequest } from "@breatic/shared";

/**
 * Probe whether the server answers its authorization metadata: the first
 * thing an agent asks for, and token exchange runs on the same routes.
 * @param server - The server's origin as this service reaches it.
 * @returns A check that is true when the metadata answers with a success.
 */
export function serverAnswers(server: string): () => Promise<boolean> {
  const url = new URL("/.well-known/oauth-authorization-server", server).toString();
  return async () => {
    const res = await httpRequest(url, { method: "GET" }, { replaySafe: true, timeoutMs: HEALTH_CHECK_TIMEOUT_MS, signal: AbortSignal.timeout(HEALTH_CHECK_TIMEOUT_MS) });
    await res.body?.cancel();
    return res.ok;
  };
}

/**
 * Probe whether a Redis connection answers.
 * @param client - The connection.
 * @param client.ping - Its PING.
 * @returns A check that is true on PONG.
 */
export function redisAnswers(client: { ping: () => Promise<string> }): () => Promise<boolean> {
  return async () => (await client.ping()) === "PONG";
}

/**
 * Ask a dependency again until it answers healthy or the deadline passes: in
 * development every service starts at once, so the server may not listen yet
 * when this service starts.
 * @param check - The probe.
 * @param options - When to give up and how long to wait between asks.
 * @param options.deadlineAt - Epoch ms after which no new ask starts.
 * @param options.intervalMs - The wait between asks.
 * @returns True once healthy; at the deadline, false when the last ask answered unhealthy, or what the last ask threw.
 */
export async function waitUntilReady(
  check: () => Promise<boolean>,
  options: { deadlineAt: number; intervalMs: number },
): Promise<boolean | Error> {
  let last: boolean | Error = false;
  for (;;) {
    try {
      if (await check()) return true;
      last = false;
    } catch (err) {
      last = err instanceof Error ? err : new Error(String(err));
    }
    if (Date.now() + options.intervalMs > options.deadlineAt) return last;
    await new Promise((resolve) => setTimeout(resolve, options.intervalMs));
  }
}
