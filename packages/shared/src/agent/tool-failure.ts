// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Why a use of a tool ended with nothing to show, told to two audiences.
 *
 * A tool that failed and a tool the user stopped are different endings, and
 * each has two readers who need different things. The model needs the specific
 * reason -- which address, which status, what it might do instead -- because
 * that is what it acts on. The person watching needs to know the step did not
 * work, and nothing more: the specific reason names endpoints, statuses and
 * vendor hosts, none of which belong on a screen. (An address inside the
 * network is not among them -- the one failure that resolves to one drops it
 * before writing the reason, so it reaches neither audience.)
 *
 * So three fields rather than one message. What ended it is its own field
 * because it is a different question from what to say about it -- the same
 * split the SDK's own stream protocol makes, where `abort` is a part type
 * beside `finish` and `error`, each carrying its own reason.
 */

/**
 * The lines a reader may be shown when a tool comes back empty.
 *
 * Coarse on purpose. A reader needs to know the step did not work; the detail
 * that would tell them more is the detail that names hosts and addresses.
 */
export const FAILURE_LINES = {
  /** The far side answered, and what it answered was an error. */
  upstream: "chat.tool.failure.upstream",
  /** Nothing answered. */
  unreachable: "chat.tool.failure.unreachable",
  /**
   * Something went wrong, and none of the lines above is what happened.
   *
   * Two callers. The turn uses it for calls that failed before any of our
   * code ran -- input the model shaped wrongly, a tool name that no longer
   * exists -- which arrive as errors from the SDK with no detail of ours
   * attached; a record with nothing in it is what that replaced. A tool uses
   * it when its failure was neither the far side answering, nor an address
   * that would not answer, nor an address we refuse: a request turned down
   * before any delivery is all three of those things not happening.
   */
  generic: "chat.tool.failure.generic",
  /**
   * The turn was stopped, and this use of a tool did not finish because of it.
   *
   * Covers a tool that was running when the stop landed and one the turn never
   * got to run at all: both are the same thing to whoever pressed stop, and
   * what separates them is in the reason the model reads.
   *
   * Here rather than beside the failures because every reader key belongs in
   * one table -- the panel reads them all the same way, and a key living on
   * its own is one nothing checks against the locale files.
   */
  stopped: "chat.tool.unfinished",
} as const;

/** The line for the one ending that is not a failure. */
export type StoppedLine = typeof FAILURE_LINES.stopped;

/** Which line a reader is shown when a tool failed. */
export type FailureLine = Exclude<
  (typeof FAILURE_LINES)[keyof typeof FAILURE_LINES],
  StoppedLine
>;

/** The same table, for asking whether a key read off an error is one of ours. */
const KNOWN_LINES = new Set<string>(Object.values(FAILURE_LINES));

/**
 * Whether a value is one of the lines above.
 *
 * The wire carries this key as a bare string on a field the SDK defines and
 * fills in itself when nothing else does. Asking the table is how a reader
 * tells our key from whatever else may arrive there.
 *
 * A true answer says the key is ours, not that it is about a tool. The one
 * callback that fills that field serves three chunk types, and the third is
 * the stream's own error frame -- a turn that never got going carries a key
 * from this table too, because that callback has no way to tell which of the
 * three it is answering for. What kind of failure it was is the chunk type,
 * and reading it is task #134.
 * @param value - Whatever arrived where a key was expected.
 * @returns True when it is a key from the table.
 */
export function isReaderLine(value: unknown): value is FailureLine | StoppedLine {
  return typeof value === "string" && KNOWN_LINES.has(value);
}

/** What ended a use of a tool without a result. */
export type ToolFailureKind =
  /** The tool ran and could not do what it was asked. */
  | "tool_failed"
  /** The user stopped the turn while the tool was still running. */
  | "user_aborted";

/**
 * What both endings say, apart from which line the reader is shown.
 *
 * Split out so the two fields that vary together are the only ones written
 * twice below.
 */
interface FailureDetail {
  /**
   * The reason, in enough detail for the model to do something about it.
   *
   * Written to be specific and actionable: what was refused, why, and what
   * the model may do instead. Never reaches the browser.
   */
  forModel: string;
}

/**
 * Why a use of a tool ended without a result.
 *
 * The two fields go together: the line about being stopped belongs to the
 * ending that was a stop, and the lines about a failure belong to the ending
 * that was one. Written as one type with a `readerKey` of its own, the pair
 * "stopped by the user" and "could not run" type-checks, and the panel then
 * tells a reader their own button press was something going wrong.
 *
 * `readerKey` is a translation key rather than a sentence because the row
 * outlives the language it was written in: a message stored in one reader's
 * language would still be in that language when a different reader opens the
 * conversation.
 */
export type ToolFailure =
  | (FailureDetail & { kind: "tool_failed"; readerKey: FailureLine })
  | (FailureDetail & { kind: "user_aborted"; readerKey: StoppedLine });

/**
 * A call that failed with nothing on record saying why.
 *
 * Written where a part is being stored `error` and the reason is not in hand:
 * a record that says nothing at all is one the next turn cannot read, and the
 * model then has only the fact that something went wrong. Says as much rather
 * than inventing a cause.
 */
export const NOTHING_SAID_WHY: ToolFailure = {
  kind: "tool_failed",
  // With no reason there is nothing to tell a retry that would work from one
  // that would not, so the next step is put in the model's hands rather than
  // left out: a reason ending in nothing falls to the prompt's answer for
  // reasons that name none, which is to not call it again at all.
  forModel:
    "This tool call failed, and nothing recorded why. If this step is needed, try it once " +
    "more; if it fails again, tell the user it could not be done.",
  readerKey: FAILURE_LINES.generic,
};

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
  if (typeof forModel !== "string") return undefined;
  // Checked against the table rather than merely for being a string. What the
  // table settles is that this key is one of the ones written above, which is
  // the set the locale files are kept in step with; a key from anywhere else
  // renders as itself, and the panel would show `chat.tool.failure.whatever`
  // to whoever met it.
  if (typeof readerKey !== "string" || !KNOWN_LINES.has(readerKey)) return undefined;
  // And checked as a pair, which the table alone does not settle: both fields
  // being known says nothing about them belonging together.
  if (kind === "user_aborted") {
    if (readerKey !== FAILURE_LINES.stopped) return undefined;
    return { kind, forModel, readerKey };
  }
  if (kind !== "tool_failed" || readerKey === FAILURE_LINES.stopped) return undefined;
  return { kind, forModel, readerKey: readerKey as FailureLine };
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
