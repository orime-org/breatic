// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Everything a turn owes once it stops, run no matter how it stopped.
 *
 * The obligations used to sit after the streaming loop in the chat handler,
 * where any early exit skipped them: a failure, and a blocking interaction
 * tool returning. In both the reply went unsaved and the turn unbilled.
 *
 * The third way -- the turn being stopped -- also skips everything after the
 * loop, because an async generator stops where the consumer stopped it. A
 * chat run hands the turn its stop signal (the user's stop, the conversation
 * deleted, a shutdown; `packages/server/src/agent/chat-run.ts`), so the turn
 * learns about it and arrives here.
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
 * package does not log (see `AGENTS.md#library-packages-do-not-log`).
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

/**
 * Fixed order: bill first, so the turn's charge request is recorded as soon as
 * its usage rows are in, before the reply is saved (inner#1617); the reply is
 * saved after it either way.
 */
const STEP_ORDER: ReadonlyArray<keyof TurnSteps> = ["bill", "persist"];

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
