// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Everything a turn owes once it stops, run no matter how it stopped.
 *
 * The obligations used to sit after the streaming loop in the chat handler,
 * where any early exit skipped them: a failure, and a blocking interaction
 * tool returning. In both the reply went unsaved and the turn unbilled.
 *
 * The third way -- the user closing the page -- also skips everything after
 * the loop, because an async generator stops where the consumer stopped it.
 * That one is reachable now. It could not be found by watching writes fail:
 * hono's `StreamingApi.write` swallows the error, so a loop that only checks
 * whether its own writes landed runs on with nobody listening. PR-3 batch 3
 * (breatic #425) made the route subscribe to the departure itself -- the chat
 * entries call `s.onAbort` and pass that signal down to the loop -- so the
 * turn now learns about it and arrives here.
 *
 * What belongs here is what the turn's ending waits on. Work the user is not
 * waiting for -- memory consolidation, an LLM call of its own -- does not:
 * putting it in this list would hold `chat_done` behind it, leaving the
 * frontend spinning on a reply that finished streaming seconds ago. The
 * caller starts that kind of work without awaiting it.
 *
 * Two properties make this work, and both are deliberate:
 *
 * It is a plain async function, never a generator. That is the whole point:
 * a generator's body stops where the consumer stopped it, so cleanup written
 * as one would relocate the bug instead of removing it. The test asserts the
 * shape, because a `yield*` that never runs looks exactly like success.
 *
 * A step that throws does not stop the others. These are separate
 * obligations, not a transaction — losing a saved reply because memory
 * consolidation was down would trade one missing thing for a worse one.
 * Failures come back to the caller, which is the layer that knows the
 * userId, the conversation, and whether anyone should be paged. This
 * package does not log (see the package's CLAUDE.md).
 */

/** One obligation. Absent means this caller does not have that obligation. */
export interface TurnSteps {
  /** Write the turn's output where it belongs. */
  persist?: () => Promise<void>;
  /** Charge for what the turn consumed. */
  bill?: () => Promise<void>;
}

/** What a caller hands the finalizer. */
export interface FinalizeTurnRequest {
  /** The obligations this caller has. */
  steps: TurnSteps;
}

/** A step that threw, paired with what it threw. */
export interface TurnStepFailure {
  /** Which obligation failed. */
  step: keyof TurnSteps;
  /** What it threw, unwrapped for the caller to log or re-raise. */
  error: unknown;
}

/** Fixed order: save first, since billing can be redone from what was saved. */
const STEP_ORDER: ReadonlyArray<keyof TurnSteps> = ["persist", "bill"];

/**
 * Run a turn's obligations, whatever happened to the turn.
 * @param request - The obligations this caller has.
 * @returns The steps that threw, in the order they were tried; empty when all succeeded.
 */
export async function finalizeTurn(
  request: FinalizeTurnRequest,
): Promise<TurnStepFailure[]> {
  const failures: TurnStepFailure[] = [];

  for (const name of STEP_ORDER) {
    const step = request.steps[name];
    if (!step) continue;
    try {
      await step();
    } catch (error) {
      failures.push({ step: name, error });
    }
  }

  return failures;
}
