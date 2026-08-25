// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Reading how a tool call ended off whatever the SDK reported.
 *
 * Our own tools say it outright: they throw an error carrying both halves of
 * the reason, one for the model and a key for the panel. Not every failed call
 * comes from one of them, though. Input the model shaped wrongly is rejected
 * before `execute` runs, and a tool name that no longer exists never reaches
 * one at all. Both arrive here with nothing of ours on them, and both arrive
 * as a rendered string rather than an error object: `parseToolCall` catches
 * either one into the same `{ invalid: true, error }` shape, and the one site
 * that puts it on the stream renders it with `getErrorMessage`.
 *
 * Those still have to be recorded as something, because a stored `error` part
 * with no detail is a record that cannot say what happened, and the model
 * reads that record back next turn.
 */
import { FAILURE_LINES, toolFailureOf } from "@breatic/shared";
import type { ToolFailure } from "@breatic/shared";

/**
 * What is left of a call the turn ended before running.
 *
 * Two windows put a call here, and neither of them ran it. Measured against
 * `ai@7.0.68`: a call the SDK finishes assembling goes into a queue drained
 * only by `model-call-end`, and that chunk is made from the provider's
 * `finish`. A turn cut off before `finish` arrives takes the other exit --
 * the read loop enqueues `abort` and closes -- so the queue is never drained.
 * The transform has no `flush` to drain it either. So a call is left with
 * nothing recorded about it whether its arguments were still arriving or had
 * just finished; what the two share is that no tool ran.
 *
 * Alone among these reasons, this one is worth acting on again: nothing was
 * attempted, so nothing about it failed. Left without a next step it falls to
 * the prompt's own answer for reasons that name none -- that calling the same
 * tool the same way will fail the same way -- which is the opposite of what
 * happened here.
 *
 * The model does read this. A call caught mid-arguments is marked half-sent
 * and left out of the history on that ground (`model-messages.ts`), but one
 * whose arguments had arrived carries no such mark and goes back in full.
 */
const NOTHING_OF_IT_RAN =
  "This tool was never run: the turn ended while its arguments were still " +
  "being sent. Nothing was attempted, so call it again if you still need it.";

/**
 * How a call the turn ended around is recorded.
 *
 * The two halves answer different questions and are settled separately. What
 * the model is told is the same either way, because the fact is the same: this
 * never ran. What a reader is shown is not -- someone who pressed stop is told
 * their turn stopped, and a failure nobody asked for is told as a failure.
 * @param stopped - Whether the turn ended because it was stopped.
 * @returns The ending to record against the call.
 */
export function endingWithNothingRun(stopped: boolean): ToolFailure {
  // Each arm written whole. Picking the two fields separately produces a pair
  // the type will not take, which is the point of that type: it exists so
  // that "stopped by the user" cannot be paired with a line about something
  // going wrong.
  return stopped
    ? { kind: "user_aborted", forModel: NOTHING_OF_IT_RAN, readerKey: FAILURE_LINES.stopped }
    : { kind: "tool_failed", forModel: NOTHING_OF_IT_RAN, readerKey: FAILURE_LINES.generic };
}

/**
 * How a failed tool call ended, in the form the record keeps.
 * @param err - Whatever the SDK reported the call failing with.
 * @returns The detail the tool carried, or one derived from the error.
 */
export function endingOf(err: unknown): ToolFailure {
  const carried = toolFailureOf(err);
  if (carried !== undefined) return carried;

  // The message goes to the model and nowhere else. It is the SDK's own
  // wording for a call it would not make -- "invalid input", the schema it
  // failed against -- which is exactly what the model needs to fix the call,
  // and exactly what a reader has no use for.
  //
  // The next step is ours to add: the SDK states the complaint and stops
  // there, and a call refused over its arguments is one the model wrote and
  // can rewrite. It is added for the record rather than for the turn in
  // hand -- what the model reads while this turn runs is the SDK's own error,
  // which this does not replace. Where the sentence below is read is the next
  // turn, off the stored row.
  const said = err instanceof Error ? err.message : String(err);
  return {
    kind: "tool_failed",
    forModel: `${said} Correct the call and try once more.`,
    readerKey: FAILURE_LINES.generic,
  };
}
