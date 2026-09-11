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
 * How one tool names what it does, in the sentences it fails with.
 *
 * Every word here is one a reason would otherwise have written for a single
 * tool. `web_search` failing and telling the user "search is unavailable" is
 * right; the same sentence out of an image search says a working capability
 * is down, and the reader is told something false about the tool they did
 * not use.
 */
export interface FailureVoice {
  /** What this tool does, as the model should name it to the reader. */
  readonly act: string;
  /** What a reply goes without when this tool fails. */
  readonly results: string;
  /** Opens "… once more may work". */
  readonly retrying: string;
  /** What to try instead when the query itself is not the problem. */
  readonly elsewhere: string;
  /** Opens a sentence about one attempt: `<attempting> "query" failed`. */
  readonly attempting: string;
  /** How to name the far side. */
  readonly service: string;
}

/** One of the moves a `nextMovesFor` table holds. */
export type NextMove = string & { readonly __nextMove: true };

/** What the model may do once a call has failed. */
export interface NextMoves {
  /** No wording reaches past this one; the sentence before it says why. */
  readonly stop: NextMove;
  /** The request is the model's to rewrite, once. */
  readonly rewordOnce: NextMove;
  /** This side never saw the answer; asking again may get it. */
  readonly retryOnce: NextMove;
  /** The call ran; there is nothing here to retry. */
  readonly searchElsewhere: NextMove;
}

/**
 * The moves one tool offers, in its own words.
 *
 * Every reason ends with one of these. Anthropic's guidance asks a tool error
 * to be actionable, and the half that keeps a failing tool from being called
 * the same way again is this one -- a reason that names only what broke leaves
 * the model with nowhere to go but the same call. Written as a table so a new
 * failure picks a move rather than phrasing its own, which is how three of
 * these drifted apart before.
 *
 * Each move is bound to the call rather than to a turn: a reason is read once
 * when the call fails and again every later turn that reads the record, and by
 * then "this turn" names a different one.
 * @param voice - How this tool names what it does.
 * @returns The four moves, phrased for that tool.
 */
export function nextMovesFor(voice: FailureVoice): NextMoves {
  const fallback = `continue without ${voice.results} and tell the user ${voice.act} is unavailable.`;
  return {
    stop: `Do not repeat this ${voice.act}; ${fallback}` as NextMove,
    rewordOnce: `Try a different wording at most once, then ${fallback}` as NextMove,
    retryOnce: `${voice.retrying} may work; if it fails again, ${fallback}` as NextMove,
    searchElsewhere: (`Rewording is unlikely to help; ${voice.elsewhere} if there is another ` +
      `angle, otherwise answer from what you already know and tell the user the ${voice.act} ` +
      "came back empty.") as NextMove,
  };
}

/**
 * Join what happened to what the model may do about it.
 * @param what - What happened, ending in a full stop.
 * @param next - What the model may do, from a `nextMovesFor` table.
 * @returns The reason, as the model reads it.
 */
export function reason(what: string, next: NextMove): string {
  return `${what} ${next}`;
}

/**
 * What to tell the model about a status the far side refused with.
 *
 * Two next moves hide behind "not 2xx" -- rewrite the query, or stop -- and the
 * model takes the one this sentence points at. A 5xx, a 429 or a 408 is the
 * service having a bad time and says nothing about the query. A 401 or 403 is
 * our credentials turned down; a 422 is what this side sent being refused, for
 * a token it will not accept or a parameter out of range, and its `detail` text
 * is the same either way. A 3xx reaches this function at all because the
 * redirect is not followed, and means the address held here has moved. What is
 * left is this request being one the service would not take, which the model
 * wrote and can rewrite.
 * @param voice - How this tool names what it does.
 * @param query - What was searched for.
 * @param status - The status the service answered with.
 * @returns The reason, ending in what the model may do instead.
 */
export function refusalReason(voice: FailureVoice, query: string, status: number): string {
  const moves = nextMovesFor(voice);
  const opening = `${voice.attempting} "${query}" failed: ${voice.service} answered HTTP ${String(status)}.`;
  // 408 travels with 429 because the transport already treats the two the same
  // (`decide-retry.ts`), and a 5xx joins them because these calls declare
  // themselves replay-safe. One that reaches here has survived every delivery
  // the transport was willing to make, or named a wait past the transport's own
  // ceiling and was handed back on the first.
  if (status >= 500 || status === 429 || status === 408) {
    return reason(
      `${opening} That is a fault on their side, not a problem with the query, so no ` +
        "wording of it reaches past this.",
      moves.stop,
    );
  }

  const ours =
    status === 401 || status === 403
      ? "It turned down the credentials this side sent, which is a fault in our configuration."
      : status === 422
        ? "It refused what this side sent it, which is a fault in our configuration."
        : status < 400 || status === 404
          ? "It answered from an address this side no longer reaches, so the address " +
            "configured here has moved. That is a fault in our configuration."
          : null;
  if (ours !== null) {
    return reason(`${opening} ${ours} No wording of the query reaches it.`, moves.stop);
  }
  return reason(
    `${opening} The service is reachable, so it is this request it would not take.`,
    moves.rewordOnce,
  );
}

/**
 * What to tell the model when the whole answer arrived and is not results.
 *
 * For an answer that came back complete and is not the payload the tool reads.
 * An answer that stopped arriving partway is a different fact and says so where
 * it is caught: this side never saw what the service meant to send, and asking
 * again may well get it.
 * @param voice - How this tool names what it does.
 * @param query - What was searched for.
 * @returns The reason, ending in what the model may do instead.
 */
export function notOurPayloadReason(voice: FailureVoice, query: string): string {
  return reason(
    `${voice.attempting} "${query}" failed: ${voice.service} answered, but not with results. ` +
      "That is a fault on their side.",
    nextMovesFor(voice).stop,
  );
}

/**
 * Keep a value to the single line it is printed on.
 *
 * Everything a tool prints outside a marked region is a line: the query, and
 * each result's own title and address. A line terminator in one of them puts
 * whatever follows where the tool's own lines live, in the same shape -- a page
 * whose title carries `\nurl: https://…` would be cited to the reader under
 * the address it chose.
 *
 * All four JavaScript calls line terminators, not the two ASCII ones: `^` and
 * `$` under the `m` flag break after U+2028 and U+2029 as readily as after a
 * newline, so a value carrying one is read as two lines.
 * @param text - The value about to be printed.
 * @returns The same text, on one line.
 */
export function onOneLine(text: string): string {
  return text.replace(/[\r\n\u2028\u2029]+/g, " ");
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
