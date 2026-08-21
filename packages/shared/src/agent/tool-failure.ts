// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Why a use of a tool ended with nothing to show, told to two audiences.
 *
 * A tool that failed and a tool the user stopped are different endings, and
 * each has two readers who need different things. The model needs the specific
 * reason -- which address, which status, what it might do instead -- because
 * that is what it acts on. The person watching needs to know the step did not
 * work, and nothing more: the specific reason names endpoints, internal
 * addresses and vendor hosts, none of which belong on a screen.
 *
 * So three fields rather than one message. What ended it is its own field
 * because it is a different question from what to say about it -- the same
 * split the SDK's own stream protocol makes, where `abort` is a part type
 * beside `finish` and `error`, each carrying its own reason.
 */

/** What ended a use of a tool without a result. */
export type ToolFailureKind =
  /** The tool ran and could not do what it was asked. */
  | "tool_failed"
  /** The user stopped the turn while the tool was still running. */
  | "user_aborted";

/** Why a use of a tool ended without a result. */
export interface ToolFailure {
  /** What ended it. */
  kind: ToolFailureKind;
  /**
   * The reason, in enough detail for the model to do something about it.
   *
   * Written to be specific and actionable: what was refused, why, and what
   * the model may do instead. Never reaches the browser.
   */
  forModel: string;
  /**
   * Which line the panel shows, as a translation key.
   *
   * A key rather than a sentence because the row outlives the language it was
   * written in: a message stored in one reader's language would still be in
   * that language when a different reader opens the conversation.
   */
  readerKey: string;
}

/**
 * The property an error carries its failure detail on.
 *
 * A plain property rather than a class checked with `instanceof`: the tools
 * that throw live in `@breatic/domain` and the code that reads it lives in
 * the server, and the two resolve their imports separately -- a class
 * identity that differs between them would fail the check while every field
 * on the object was right there.
 */
const CARRIED_ON = "toolFailure";

/**
 * Read the failure detail an error carries, if it carries one.
 * @param err - Whatever was thrown.
 * @returns The detail, or undefined for an error that carries none.
 */
export function toolFailureOf(err: unknown): ToolFailure | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const carried = (err as Record<string, unknown>)[CARRIED_ON];
  if (typeof carried !== "object" || carried === null) return undefined;
  const { kind, forModel, readerKey } = carried as Record<string, unknown>;
  if (kind !== "tool_failed" && kind !== "user_aborted") return undefined;
  if (typeof forModel !== "string" || typeof readerKey !== "string") return undefined;
  return { kind, forModel, readerKey };
}

/**
 * Attach failure detail to an error, so it survives the throw.
 * @param err - The error being thrown.
 * @param failure - What to tell each audience.
 * @returns The same error, now carrying the detail.
 */
export function carrying<E extends Error>(err: E, failure: ToolFailure): E {
  Object.defineProperty(err, CARRIED_ON, {
    value: failure,
    enumerable: false,
    writable: false,
  });
  return err;
}
