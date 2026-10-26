// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Why a use of a tool ended with nothing to show, told to two audiences.
 *
 * A tool that failed and a tool the user stopped are different endings, and
 * each has two readers who need different things. The model needs the specific
 * reason -- which address, which status, what it might do instead -- because
 * that is what it acts on. The person watching needs to know which step did
 * not work and why, in words that name no endpoint, status or vendor host,
 * none of which belong on a screen: one cause from a fixed table. (An address
 * inside the network is not among them -- the one failure that resolves to
 * one drops it before writing the reason, so it reaches neither audience.)
 *
 * So three fields rather than one message. What ended it is its own field
 * because it is a different question from what to say about it -- the same
 * split the SDK's own stream protocol makes, where `abort` is a part type
 * beside `finish` and `error`, each carrying its own reason.
 */

/**
 * The lines a reader may be shown when a tool comes back empty (inner#1620).
 *
 * Each is one cause, said as itself, and the reader can tell from it whether
 * there is something for them to do. None names a vendor, a host or a status:
 * those are the model's to read. Which one a failure gets is decided in the
 * same place as the sentence the model reads, so the two never disagree.
 */
export const FAILURE_LINES = {
  /** The far side failed: 429, 5xx, 408, or its answer stopped arriving. */
  busy: "chat.tool.failure.busy",
  /** Nothing answered: the request never reached a service. */
  noConnection: "chat.tool.failure.noConnection",
  /** The service answered and would not take this request. */
  refused: "chat.tool.failure.refused",
  /** Our side of the service is not set up to serve this: keys, account, address. */
  unavailable: "chat.tool.failure.unavailable",
  /** The service answered with something that is not a result. */
  badAnswer: "chat.tool.failure.badAnswer",
  /** The address the call was given could not be reached. */
  linkUnreachable: "chat.tool.failure.linkUnreachable",
  /** The file is over the size the step takes. */
  fileTooLarge: "chat.tool.failure.fileTooLarge",
  /** The file is of a kind the step does not take. */
  unsupportedType: "chat.tool.failure.unsupportedType",
  /** The file has nothing in it. */
  emptyFile: "chat.tool.failure.emptyFile",
  /** The file arrived too slowly to finish. */
  tooSlow: "chat.tool.failure.tooSlow",
  /** The studio has no storage left. */
  storageFull: "chat.tool.failure.storageFull",
  /** The reader cannot add material to this project. */
  noPermission: "chat.tool.failure.noPermission",
  /** The reader is no longer a member of this project. */
  notMember: "chat.tool.failure.notMember",
  /** Too many of these in a short time. */
  tooFrequent: "chat.tool.failure.tooFrequent",
  /** The service would not handle this content. */
  declined: "chat.tool.failure.declined",
  /** Something failed on our own server, or a tool failed without saying why. */
  ourFault: "chat.tool.failure.ourFault",
  /**
   * The turn was stopped, and this use of a tool did not finish because of it.
   *
   * Here rather than beside the failures because every reader key belongs in
   * one table -- the panel reads them all the same way, and a key living on
   * its own is one nothing checks against the locale files.
   */
  stopped: "chat.tool.unfinished",
} as const;

/**
 * The three keys rows stored before inner#1620 carry.
 *
 * Read, never written: each covered several causes, so a row carrying one
 * names the step and no reason.
 */
export const LEGACY_FAILURE_LINES = {
  upstream: "chat.tool.failure.upstream",
  unreachable: "chat.tool.failure.unreachable",
  generic: "chat.tool.failure.generic",
} as const;

/** A key rows stored before inner#1620 carry. */
export type LegacyFailureLine = (typeof LEGACY_FAILURE_LINES)[keyof typeof LEGACY_FAILURE_LINES];

/** The line for the one ending that is not a failure. */
export type StoppedLine = typeof FAILURE_LINES.stopped;

/** Which line a reader is shown when a tool failed. */
export type FailureLine = Exclude<
  (typeof FAILURE_LINES)[keyof typeof FAILURE_LINES],
  StoppedLine
>;

/** Every key a stored row may carry, for asking whether one read back is ours. */
const KNOWN_LINES = new Set<string>([...Object.values(FAILURE_LINES), ...Object.values(LEGACY_FAILURE_LINES)]);

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
export function isReaderLine(value: unknown): value is FailureLine | LegacyFailureLine | StoppedLine {
  return typeof value === "string" && KNOWN_LINES.has(value);
}

/** What ended a use of a tool without a result. */
export type ToolFailureKind =
  /** The tool ran and could not do what it was asked. */
  | "tool_failed"
  /** The user stopped the turn while the tool was still running. */
  | "user_aborted"
  /**
   * The call was turned away to steer the model: a second question in one
   * turn, a second media call while one is running, or a call the SDK refused
   * (input that does not fit the schema, or a tool name that does not exist).
   * Nothing failed; the model reads why and carries on, and the reader is
   * shown nothing.
   */
  | "turned_away"
  /**
   * The call never ran: the turn failed or was cut off before it did, whether
   * its arguments were still arriving or had just finished. The turn's own ending line says what happened, so
   * the reader is shown nothing for the call.
   */
  | "never_ran";

/**
 * What every ending says, apart from which line the reader is shown.
 *
 * Split out so the fields that vary with the kind are the only ones written
 * in each arm below.
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
 * The kind and the reader's line go together: the line about being stopped
 * belongs to the ending that was a stop, the lines about a failure belong to
 * the ending that was one, and a call turned away carries no line at all.
 * Written as one type with a `readerKey` of its own, the pair
 * "stopped by the user" and "could not run" type-checks, and the panel then
 * tells a reader their own button press was something going wrong.
 *
 * `readerKey` is a translation key rather than a sentence because the row
 * outlives the language it was written in: a message stored in one reader's
 * language would still be in that language when a different reader opens the
 * conversation.
 */
export type ToolFailure =
  | (FailureDetail & { kind: "tool_failed"; readerKey: FailureLine | LegacyFailureLine })
  | (FailureDetail & { kind: "user_aborted"; readerKey: StoppedLine })
  | (FailureDetail & { kind: "turned_away" })
  | (FailureDetail & { kind: "never_ran" });

/**
 * What a turned-away call puts on the wire where a reader line would go.
 *
 * Not a reader line: it has no text in any locale, because there is nothing
 * for the reader to read. The panel takes it as "draw nothing for this call".
 */
export const TURNED_AWAY = "turned_away";

/** What a call that never ran puts on the wire: draw nothing, as above. */
export const NEVER_RAN = "never_ran";

/**
 * The value an ending puts in the wire's single error field.
 * @param failure - How the call ended.
 * @returns The reader line to draw, or a marker that says draw nothing.
 */
export function wireLineOf(
  failure: ToolFailure,
): FailureLine | LegacyFailureLine | StoppedLine | typeof TURNED_AWAY | typeof NEVER_RAN {
  if (failure.kind === "turned_away") return TURNED_AWAY;
  if (failure.kind === "never_ran") return NEVER_RAN;
  return failure.readerKey;
}

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
  readerKey: FAILURE_LINES.ourFault,
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
  // The one ending with no line for the reader. Carrying one anyway is a pair
  // that does not belong together, the same as the two checks below.
  if (kind === "turned_away" || kind === "never_ran") return readerKey === undefined ? { kind, forModel } : undefined;
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
  return { kind, forModel, readerKey: readerKey as FailureLine | LegacyFailureLine };
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
