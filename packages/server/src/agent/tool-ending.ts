// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Reading how a tool call ended off whatever the SDK reported.
 *
 * Our own tools say it outright: they throw an error carrying both halves of
 * the reason, one for the model and a key for the panel. Not every failed call
 * comes from one of them, though. Input the model shaped wrongly is rejected
 * before `execute` runs, and a tool name that no longer exists never reaches
 * one at all. Both arrive here with nothing of ours on them, and the second
 * of the two arrives as a rendered string rather than an error object.
 *
 * Those still have to be recorded as something, because a stored `error` part
 * with no detail is a record that cannot say what happened, and the model
 * reads that record back next turn.
 */
import { FAILURE_LINES, toolFailureOf } from "@breatic/shared";
import type { ToolFailure } from "@breatic/shared";

/**
 * A call the turn ended around, without the turn being stopped by anyone.
 *
 * What is left when a step ends between the model asking for a tool and the
 * tool running: the provider dropped the connection, or the turn's own code
 * failed. Nothing ran, so nothing has anything to say about why -- but the
 * next turn still reads this record, and it must not read as the user having
 * pressed stop.
 */
export const TURN_ENDED_AROUND_IT: ToolFailure = {
  kind: "tool_failed",
  // Alone among these reasons, this one is worth acting on again: nothing was
  // attempted, so nothing about it failed. Left without a next step it falls
  // to the prompt's own answer for reasons that name none -- that calling the
  // same tool the same way will fail the same way -- which is the opposite of
  // what happened here.
  forModel:
    "This tool was never run: the turn ended before it could start. " +
    "Nothing was attempted, so call it again if you still need it.",
  readerKey: FAILURE_LINES.generic,
};

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
  // and exactly what a reader has no use for. The next step is ours to add:
  // the SDK states the complaint and stops there, and a call refused over its
  // arguments is one the model wrote and can rewrite.
  const said = err instanceof Error ? err.message : String(err);
  return {
    kind: "tool_failed",
    forModel: `${said} Correct the call and try once more.`,
    readerKey: FAILURE_LINES.generic,
  };
}
