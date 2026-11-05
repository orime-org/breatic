// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * When a turn folds its oldest history into memory, and how far back it goes
 * (inner#1567, design 6.2 and 6.4).
 *
 * The request goes as it is unless the provider has said it does not fit.
 * Two things say so: the count the provider reported for the previous call
 * (input plus output) reaching the lower of `fold_trigger_tokens` and the main
 * model's window less the output reserve, checked before each call
 * (inner#1879); and the provider turning a call
 * away as over its window. Nothing not yet sent is estimated to decide this:
 * characters overstate DeepSeek's tokens two to three times.
 *
 * Both triggers size the fold the same way (`planConsolidation`) and fold
 * through the same `consolidateWindow`; what happens after it is the caller's.
 */

import type { ModelMessage } from "ai";
import { getAgentConfig, logger, memoryReserveTokens } from "@breatic/core";
import type { ResolvedAgentConfig } from "@breatic/domain";
import { planConsolidation } from "@server/agent/consolidation-window.js";
import { providerErrorOf, type ContextOverflow } from "@server/agent/context-overflow.js";
import { consolidateWindow } from "@server/agent/memory-consolidator.js";
import { stripThinking } from "@server/agent/history-replay.js";
import type { ReplayedRow, UserForModel } from "@server/agent/history-replay.js";
import { measureMessages } from "@server/agent/payload-size.js";
import { costPerTurn, requestTokens } from "@server/agent/request-size.js";

/** One reading of everything a turn sends, and what it was built from. */
export interface Assembly {
  /** Model, instructions and tools, as the factory resolved them. */
  agentConfig: ResolvedAgentConfig;
  /** The unconsolidated history this assembly read, row by row as it is replayed. */
  replayed: ReplayedRow[];
  /** How far the conversation was folded when this was read. */
  watermark: number;
  /** This turn's logical message, picture facts and Space snapshot before projection. */
  userKept: UserForModel;
  /** The history and this turn's question, as they will be sent. */
  messages: ModelMessage[];
  /** Initial selected logical facts, reused without restoring omissions within the SDK loop. */
  logicalMessages?: ModelMessage[];
}

/** Who is asking, and whether they are still there. */
export interface TurnIdentity {
  userId: string;
  conversationId: string;
  projectId: string;
  /** The turn being answered; only turns before it may be folded. */
  turnIndex: number;
  /** Raised when the reader stopped the turn or the client went away. */
  signal?: AbortSignal;
  /**
   * Called once, when a fold is about to run.
   *
   * Fires after the decision and before the model call, so it reaches the
   * reader only on turns that really do stop to fold.
   */
  onStart?: () => void;
}

/** What set a fold off. */
export type FoldTrigger =
  /** About to call: `known` is the provider's last reported count, when there is one to trust. */
  | { kind: "precheck"; at: "start" | "step"; known: number | undefined }
  /**
   * The provider turned the call away as over its window: `error` is what it
   * answered, and `attempt` counts this turn's overflows, this one included.
   */
  | { kind: "overflow"; overflow: ContextOverflow; known: number | undefined; attempt: number; error: unknown };

/**
 * How a fold check ended.
 *
 * - `none`: no fold ran; send as it stands.
 * - `moved`: the watermark moved (`written`, `superseded`); assemble again.
 * - `untouched`: the fold could not start, or failed and wrote nothing.
 * - `aborted`: the reader left during the fold.
 * - `too_long`: an overflow that no fold can fix, or one past
 *   `overflow_folds_per_turn`; end the turn as too long.
 */
export type FoldResult = "none" | "moved" | "untouched" | "aborted" | "too_long";

/**
 * The line a fold runs down to: the lower of the keep line and the room the
 * window leaves, less the room memory itself takes.
 * @param lines - The four figures, in tokens.
 * @param lines.keep - `memory_keep_tokens`.
 * @param lines.window - The main model's context window.
 * @param lines.maxOutput - `max_output_tokens`.
 * @param lines.reserve - The room held back for the memory a fold writes.
 * @returns The target, in tokens.
 * @throws {never} Never.
 */
export function foldTarget(lines: { keep: number; window: number; maxOutput: number; reserve: number }): number {
  return Math.min(lines.keep, lines.window - lines.maxOutput) - lines.reserve;
}

/**
 * Whether the provider's last count has reached the fold line: the lower of
 * the trigger and the window less the output reserve.
 * @param room - The window, the output reserve, the trigger, and the known count.
 * @param room.window - The main model's context window.
 * @param room.maxOutput - `max_output_tokens`.
 * @param room.trigger - `fold_trigger_tokens`.
 * @param room.known - Input plus output the provider reported last; absent, nothing is checked.
 * @returns True when the turn must fold before it sends.
 * @throws {never} Never.
 */
export function needsFold(room: { window: number; maxOutput: number; trigger: number; known: number | undefined }): boolean {
  return room.known !== undefined && room.known >= Math.min(room.trigger, room.window - room.maxOutput);
}

/**
 * How big the request is, for sizing a fold: the largest count in hand.
 * @param counts - The provider's last count, the size an overflow stated,
 *   and the estimate, which can always be worked out.
 * @param counts.known - The provider's last reported count.
 * @param counts.reported - The prompt size the overflow error stated.
 * @param counts.estimate - The request and this turn's finished steps, estimated.
 * @returns The size, in tokens.
 * @throws {never} Never.
 */
export function foldSize(counts: { known?: number; reported?: number; estimate: number }): number {
  return Math.max(counts.estimate, counts.known ?? 0, counts.reported ?? 0);
}

/**
 * Fold the oldest part of the conversation when the provider says the request
 * does not fit.
 * @param assembly - What this turn sends as it stands.
 * @param steps - This turn's finished steps, as they go back to the model.
 * @param who - Who is asking, and whether they are still there.
 * @param trigger - What set it off.
 * @returns How it ended; see {@link FoldResult}.
 * @throws {never} Never; a fold that fails ends as one of its outcomes.
 */
export async function foldIfTooLong(
  assembly: Assembly,
  steps: readonly ModelMessage[],
  who: TurnIdentity,
  trigger: FoldTrigger,
): Promise<FoldResult> {
  const config = getAgentConfig();
  const window = assembly.agentConfig.contextWindow;
  const maxOutput = config.max_output_tokens;
  if (trigger.kind === "precheck" && !needsFold({ window, maxOutput, trigger: config.fold_trigger_tokens, known: trigger.known })) return "none";

  const turns = costPerTurn(assembly.replayed);
  const takeable = turns.filter((turn) => turn.turnIndex < who.turnIndex);
  const where = {
    userId: who.userId,
    conversationId: who.conversationId,
    projectId: who.projectId,
    turnIndex: who.turnIndex,
    model: assembly.agentConfig.modelId,
    window,
    known: trigger.known,
  };

  if (trigger.kind === "overflow") {
    const stated = trigger.overflow.tokens;
    const overflowAt = {
      ...where,
      providerError: providerErrorOf(trigger.error),
      reported: stated,
      lowerBound: trigger.overflow.lowerBound,
      attempt: trigger.attempt,
    };
    const takeableTokens = takeable.reduce((sum, turn) => sum + turn.tokens, 0);
    // Past the cap the folds are not converging; with nothing to take, or
    // with every earlier turn taken still over the window, this turn's own
    // content does not fit, and a fold would be paid for in vain.
    if (
      trigger.attempt > config.overflow_folds_per_turn ||
      takeable.length === 0 ||
      (stated !== undefined && stated - takeableTokens > window - maxOutput)
    ) {
      logger.warn({ ...overflowAt, takeableTurns: takeable.length, takeableTokens }, "agent_turn_too_long");
      return "too_long";
    }
    logger.warn(overflowAt, "agent_fold_on_overflow");
  }

  const plan = planConsolidation({
    turns,
    assembled: foldSize({
      ...(trigger.known === undefined ? {} : { known: trigger.known }),
      ...(trigger.kind === "overflow" && trigger.overflow.tokens !== undefined ? { reported: trigger.overflow.tokens } : {}),
      estimate: requestTokens(assembly, turns) + measureMessages(steps),
    }),
    target: foldTarget({ keep: config.memory_keep_tokens, window, maxOutput, reserve: memoryReserveTokens(config) }),
    currentTurn: who.turnIndex,
  });
  const newWatermark = plan.newWatermark;
  // A precheck with nothing to take sends as it stands; the provider decides.
  if (newWatermark === null) return "none";
  if (trigger.kind === "precheck") logger.info({ ...where, at: trigger.at, newWatermark }, "agent_fold_on_precheck");

  who.onStart?.();

  const outcome = await consolidateWindow({
    userId: who.userId,
    conversationId: who.conversationId,
    projectId: who.projectId,
    // The window as the model was sent it, turn by turn, less its own working.
    turns: takeable
      .filter((turn) => turn.turnIndex <= newWatermark)
      .map((turn) => ({
        turnIndex: turn.turnIndex,
        messages: stripThinking(
          assembly.replayed.filter((one) => one.row.turnIndex === turn.turnIndex).flatMap((one) => one.messages),
        ),
      })),
    watermarkBefore: assembly.watermark,
    newWatermark,
    turnIndex: who.turnIndex,
    ...(who.signal ? { signal: who.signal } : {}),
  });

  if (outcome === "written" || outcome === "superseded") return "moved";
  // A fold that failed moved nothing: the request in hand still carries the
  // turns, and the caller goes on with it the way it does when nothing moved.
  if (outcome === "failed") return "untouched";
  return outcome;
}
