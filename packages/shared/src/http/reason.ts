// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Reading back what this transport flattened.
 *
 * `httpRequest` reports a request it gave up on as "failed after N attempts"
 * and keeps what actually happened underneath. Undoing that is why this lives
 * beside it: every caller that puts a transport failure in front of a person
 * or a model needs the bottom of the chain, and each one working it out again
 * is the same walk written twice.
 */

/**
 * What went wrong, said as far down as the error goes.
 *
 * The shared transport reports a request it gave up on as "failed after 3
 * attempts" and keeps what actually happened as the `cause`. Read on its own,
 * the outer sentence says only that something was tried repeatedly, which
 * leaves the model with no way to tell a host that is down from one that never
 * existed.
 *
 * The chain is walked to the bottom rather than one link down, because on a
 * real connection failure the bottom is two links away: the transport wraps a
 * `TypeError("fetch failed")`, which itself wraps the connection error. One
 * link reaches "fetch failed", which says the same nothing for every network
 * failure there is.
 * @param err - Whatever was caught.
 * @returns The message, with the underlying reason appended when there is one.
 */
export function reasonOf(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const seen = new Set<unknown>([err]);
  let deepest: Error = err;
  let cause: unknown = err.cause;
  while (cause instanceof Error && !seen.has(cause)) {
    seen.add(cause);
    deepest = cause;
    cause = cause.cause;
  }
  if (deepest.message === err.message) return err.message;
  return `${err.message} (${deepest.message})`;
}
