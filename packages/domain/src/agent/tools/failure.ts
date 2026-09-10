// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

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
  // Neither half names who ended it, because the server is not told: one
  // signal covers the stop button, a closed tab, a dropped network and a
  // sleeping laptop. The next step is the same for all four -- leave it alone
  // and wait to be asked. A model that takes the missing result as work to
  // redo spends the next turn on something that was called off; one told to
  // wait for the user specifically waits through the three where the user
  // cancelled nothing.
  forModel:
    "The turn ended while this tool was still running, so it never returned. " +
    "Do not call it again on your own; if this comes up again, carry on from here.",
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
