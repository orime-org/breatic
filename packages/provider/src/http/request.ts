// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/** One outgoing request. */
export interface OutgoingRequest {
  url: string;
  method: "GET" | "POST" | "PUT" | "DELETE";
  headers?: Record<string, string>;
  body?: string | Uint8Array;
}

/** What the caller decides about one request (design 2.2). */
export interface SendOptions {
  /** True only when sending again has no second side effect (queries, billing reads). Submits are false. */
  replaySafe: boolean;
  signal?: AbortSignal;
  /** Epoch ms after which nothing is sent and anything in flight is cut. */
  deadlineAt?: number;
}

/** Limits for reading a JSON body. */
export interface ReadOptions extends SendOptions {
  maxBodyBytes: number;
  /** Fail when no bytes arrive for this long. */
  idleMs: number;
}

/**
 * Send a request and hand back the response, whatever its status.
 * @param request - The request.
 * @param options - Replay, abort and deadline.
 * @returns The response.
 * @throws {NotSent} When the request never left.
 * @throws {NoAnswer} When it was sent and no response came.
 * @throws {Aborted} When the signal fired or the deadline passed.
 */
export async function send(request: OutgoingRequest, options: SendOptions): Promise<Response> {
  void request; void options;
  throw new Error("send is not implemented");
}

/**
 * Send a request and read a JSON body within limits; any non-2xx is a failure.
 * @param request - The request.
 * @param options - Replay, abort, deadline and body limits.
 * @returns The status and the parsed body.
 * @throws {NotSent} When the request never left.
 * @throws {NoAnswer} When no complete answer came.
 * @throws {HttpStatus} When the status is not 2xx (after any allowed resends).
 * @throws {BodyTooLarge} When the body exceeds the limit.
 * @throws {Aborted} When the signal fired or the deadline passed.
 */
export async function fetchJson(request: OutgoingRequest, options: ReadOptions): Promise<{ status: number; body: unknown }> {
  void request; void options;
  throw new Error("fetchJson is not implemented");
}

/**
 * The `fetch` handed to AI SDK providers: every response is returned as is, and only
 * NotSent, NoAnswer and Aborted are thrown, so they survive on the `cause` chain of
 * AI SDK's own error (design 2.2, S2).
 * @param signal - An extra signal to honour besides the SDK's own.
 * @returns A fetch-compatible function.
 */
export function aiSdkFetch(signal?: AbortSignal): typeof fetch {
  void signal;
  return (() => { throw new Error("aiSdkFetch is not implemented"); }) as unknown as typeof fetch;
}
