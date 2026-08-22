// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * How a tool says it did not come back with anything.
 *
 * A tool throws rather than returns. The SDK turns a throw into a `tool-error`
 * part, which is what tells the model this call failed; a returned string is a
 * `tool-result`, indistinguishable from a page or a list of hits, and the model
 * has nothing to go on but the words. Anthropic's guidance is the same and says
 * why: an error response is a chance to steer, so it should carry what was
 * refused, why, and what to do instead.
 *
 * Catching is fine. Answering is not.
 */
import { carrying, FAILURE_LINES } from "@breatic/shared";
import type { FailureLine, ToolFailure } from "@breatic/shared";


/**
 * Build the error a tool throws when it failed.
 * @param forModel - The reason, specific and actionable, for the model alone.
 * @param readerKey - Which of the coarse lines a reader is shown.
 * @returns The error to throw.
 */
export function toolFailed(forModel: string, readerKey: FailureLine): Error {
  return carrying(new Error(forModel), {
    kind: "tool_failed",
    forModel,
    readerKey,
  } satisfies ToolFailure);
}

/**
 * What the user stopping the turn reads like from inside a tool.
 *
 * Not a failure: nothing went wrong, the answer stopped being wanted. It is
 * still thrown, because a tool that returns on a stop hands back a result for
 * a call that has no result -- but it is thrown as a different kind, and the
 * two are shown and replayed differently from there on.
 */
export const STOPPED_BY_USER: ToolFailure = {
  kind: "user_aborted",
  // The next step here is to leave it alone. Nothing failed, and the person
  // who ended it is the one who would ask for it again -- a model that takes
  // the missing result as work to redo spends the next turn on something they
  // stopped on purpose.
  forModel:
    "The user stopped this turn while the tool was still running, so it never returned. " +
    "Do not call it again unless the user asks for this again.",
  readerKey: FAILURE_LINES.stopped,
};

/**
 * Build the error a tool throws when the user stopped the turn.
 * @returns The error to throw.
 */
export function stoppedByUser(): Error {
  return carrying(new Error(STOPPED_BY_USER.forModel), STOPPED_BY_USER);
}

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

/**
 * Whether what was thrown is the turn being stopped rather than a failure.
 *
 * Asked of both the error and the signal because either alone misses a case:
 * a `fetch` cut off by its signal rejects with the signal's reason, which may
 * be any error at all, and a tool that noticed the stop between two steps has
 * a raised signal and no error worth reading.
 * @param err - Whatever was caught.
 * @param signal - The turn's signal, when the tool was given one.
 * @returns True when this is the user stopping, not the tool failing.
 */
export function isStop(err: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted === true) return true;
  return err instanceof Error && err.name === "AbortError";
}
