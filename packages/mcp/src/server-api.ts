// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The server, as one call's user (breatic#1488 §5.5): every request carries
 * the downstream token the call was exchanged for and ends by the call's
 * deadline. Answers arrive as `{ data }`; errors as `{ error: { message } }`,
 * with `code` and `reason` on most routes.
 */

import { httpRequest } from "@breatic/shared";

/** A request the server answered with an error, or that ran out of time. */
export class ServerApiError extends Error {
  /**
   * Record what the server said.
   * @param status - The HTTP status; 503 when the call's time ran out first.
   * @param message - The server's message, in the user's language.
   * @param reason - The machine-readable reason, when the server gave one.
   * @param retryAfterSeconds - The wait a 429 asks for.
   */
  constructor(
    readonly status: number,
    message: string,
    readonly reason?: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "ServerApiError";
  }
}

/** A query value: one, several (the key repeats) or none. */
export type QueryValue = string | readonly string[] | undefined;

/** Options of one POST. */
export interface PostOptions {
  /** The `Idempotency-Key`; the run routes refuse a request without one. */
  idempotencyKey?: string;
  headers?: Record<string, string>;
}

/** The server, as one call's user. */
export interface ServerApi {
  get: <T>(path: string, query?: Record<string, QueryValue>) => Promise<T>;
  post: <T>(path: string, body: unknown, options?: PostOptions) => Promise<T>;
}

/** What a client is built from. */
export interface ServerApiOptions {
  /** `MCP_API_BASE_URL`, ending in `/api/v1`. */
  baseUrl: string;
  /** The downstream token. */
  token: string;
  /** When the call ends, epoch ms; no request outlives it. */
  deadlineAt: number;
}

/**
 * The error a failed response carries.
 * @param res - The response.
 * @returns The error.
 */
async function errorOf(res: Response): Promise<ServerApiError> {
  const body = (await res.json().catch(() => null)) as { error?: { message?: unknown; reason?: unknown } } | null;
  const message = typeof body?.error?.message === "string" ? body.error.message : `The server answered ${String(res.status)}`;
  const reason = typeof body?.error?.reason === "string" ? body.error.reason : undefined;
  const wait = res.headers.get("retry-after");
  const retryAfterSeconds = wait === null || !Number.isFinite(Number(wait)) ? undefined : Number(wait);
  return new ServerApiError(res.status, message, reason, retryAfterSeconds);
}

/**
 * Build a client for one call.
 * @param options - Where, as whom, until when.
 * @returns The client.
 */
export function createServerApi(options: ServerApiOptions): ServerApi {
  const base = options.baseUrl.replace(/\/$/, "");

  /**
   * Send one request and unwrap its answer.
   * @param url - The full URL.
   * @param init - Method, headers and body.
   * @param replaySafe - Whether sending it twice does nothing more.
   * @returns The answer's `data`.
   * @throws {ServerApiError} When the server refused it or the call's time ran out.
   */
  const send = async <T>(url: string, init: RequestInit, replaySafe: boolean): Promise<T> => {
    const left = options.deadlineAt - Date.now();
    if (left <= 0) throw new ServerApiError(503, "The call ran out of time before the server answered; try again.");
    const res = await httpRequest(
      url,
      { ...init, headers: { authorization: `Bearer ${options.token}`, accept: "application/json", ...init.headers } },
      { replaySafe, timeoutMs: left, signal: AbortSignal.timeout(left) },
    ).catch((err: unknown) => {
      if (options.deadlineAt <= Date.now()) throw new ServerApiError(503, "The call ran out of time before the server answered; try again.");
      throw err;
    });
    if (!res.ok) throw await errorOf(res);
    const body = (await res.json()) as { data: T };
    return body.data;
  };

  return {
    get: (path, query = {}) => {
      const url = new URL(`${base}${path}`);
      for (const [key, value] of Object.entries(query)) {
        if (value === undefined) continue;
        for (const one of typeof value === "string" ? [value] : value) url.searchParams.append(key, one);
      }
      return send(url.toString(), { method: "GET" }, true);
    },
    post: (path, body, { idempotencyKey, headers } = {}) =>
      send(
        `${base}${path}`,
        {
          method: "POST",
          headers: { "content-type": "application/json", ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}), ...headers },
          body: JSON.stringify(body),
        },
        // The same key answers a resend with the first request's outcome.
        idempotencyKey !== undefined,
      ),
  };
}
