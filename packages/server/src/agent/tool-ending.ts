// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Reading how a tool call ended off whatever the SDK reported.
 *
 * Our own tools say it outright: they throw an error carrying both halves of
 * the reason, one for the model and a key for the panel. Not every failed call
 * comes from one of them, though. Input the model shaped wrongly is rejected
 * before `execute` runs, and a tool name that no longer exists never reaches
 * one at all -- both arrive here as an error with nothing of ours on it.
 *
 * Those still have to be recorded as something, because a stored `error` part
 * with no detail is a record that cannot say what happened, and the model
 * reads that record back next turn.
 */
import { toolFailureOf } from "@breatic/shared";
import type { ToolFailure } from "@breatic/shared";
import { FAILURE_LINES } from "@breatic/domain";

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
  return {
    kind: "tool_failed",
    forModel: err instanceof Error ? err.message : String(err),
    readerKey: FAILURE_LINES.generic,
  };
}
