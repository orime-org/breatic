// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The credits a chat turn holds while it runs (inner#1611).
 *
 * Before each model call the turn's hold is set to what it has already spent,
 * plus what its calls still waiting for a price may cost, plus the dearest the
 * next call can be; a paying tool grows it by its own estimate before it
 * spends. Concurrent turns and generations in one studio therefore see what
 * this turn may still take. A hold that cannot grow ends the turn.
 *
 * At the end, `settleHeldUsage` charges what the turn actually spent and
 * releases its hold in the same commit; the same settlement serves a memory
 * consolidation.
 */

import { env, getAgentConfig, getUsagePricing, logger } from "@breatic/core";
import type { PromptCacheTtl } from "@breatic/core";
import { creditHoldService, creditLotService, estimateModelCallCredits } from "@breatic/domain";
import type { ToolHold, UsageRecorder } from "@breatic/domain";

/** A turn's hold, as the turn and its tools move it. */
export interface TurnHold extends ToolHold {
  /**
   * Hold enough for the next model call on top of what the turn has spent.
   * @returns Whether the hold now covers it; false ends the turn.
   */
  coverNextCall(inputTokens: number): Promise<boolean>;
  /** Whether a call could not be covered. */
  readonly exhausted: boolean;
  /** What one call still waiting for its price is held at: the dearest call seen. */
  lookupHoldCredits(): number;
}

/** What a turn's hold is opened with. */
export interface TurnHoldOptions {
  projectId: string;
  userId: string;
  /** The hold's key; the turn's charge key. */
  key: string;
  /** The turn's recorder, whose spend the hold carries. */
  usage: UsageRecorder;
  /** The model the turn calls. */
  model: string;
  /** How long the turn's calls ask the provider to cache, or null. */
  cacheTtl: PromptCacheTtl | null;
}

/**
 * Open the hold for one chat turn. Nothing is held until the first call is
 * covered; with payments off nothing is ever held or priced.
 * @param options - Whose turn, under which key, and what it calls.
 * @returns The hold.
 */
export function openTurnHold(options: TurnHoldOptions): TurnHold {
  const { projectId, userId, key, usage, model, cacheTtl } = options;
  let exhausted = false;
  let dearestCall = 0;
  return {
    get exhausted() {
      return exhausted;
    },
    lookupHoldCredits: () => dearestCall,
    async coverNextCall(inputTokens) {
      if (!env.PAYMENT_ENABLED) return true;
      const config = getAgentConfig();
      const next = estimateModelCallCredits(
        { model, inputTokens, maxOutputTokens: config.max_output_tokens, cacheTtl },
        getUsagePricing(),
        env.CREDIT_MULTIPLIER,
      );
      dearestCall = Math.max(dearestCall, next);
      const amount = usage.spent() + usage.awaitingLookup().length * dearestCall + next;
      const covered = await creditHoldService.resizeHold({
        projectId,
        actorUserId: userId,
        referenceId: key,
        amount,
        ttlMs: config.credit_hold_ttl_ms,
      });
      if (!covered) exhausted = true;
      return covered;
    },
    async extend(credits) {
      if (!env.PAYMENT_ENABLED) return true;
      return creditHoldService.extendHold({ referenceId: key, delta: credits, ttlMs: getAgentConfig().credit_hold_ttl_ms });
    },
  };
}

/** What a settlement charges, besides the amount. */
export interface HeldCharge {
  projectId: string;
  actorUserId: string;
  description: string;
  model?: string;
  provider?: string;
}

/** What settling a held operation is handed. */
export interface SettleHeldUsage {
  usage: UsageRecorder;
  /** The hold the operation ran under. */
  holdKey: string;
  /** The key the charge is made once under. */
  chargeKey: string;
  /** What each call still waiting for a price is held at until it is charged. */
  lookupHoldCredits: number;
  /** Queues the lookups of the calls still waiting for a price. */
  handOff: () => Promise<void>;
  charge: HeldCharge;
}

/**
 * Charge what a held operation spent and release its hold.
 *
 * Each call still waiting for its price keeps a hold of its own under the key
 * its lookup charges by, placed before the lookup is queued. Then the spend is
 * charged once under `chargeKey`, releasing the operation's hold in the same
 * commit; when nothing was spent, the key was already billed, or the charge
 * fails, the hold is released on its own.
 * @param input - The operation, its keys and what to charge.
 * @returns What was spent, and the charge's outcome when one was made.
 * @throws {Error} When the charge itself fails; the hold is released first.
 */
export async function settleHeldUsage(
  input: SettleHeldUsage,
): Promise<{ credits: number; outcome: Awaited<ReturnType<typeof creditLotService.chargeOnceForGeneration>> }> {
  const { usage, holdKey, chargeKey, charge } = input;
  const ttlMs = getAgentConfig().credit_hold_ttl_ms;
  for (const generationId of usage.awaitingLookup()) {
    const referenceId = `${usage.operation.operationKey}:gen:${generationId}`;
    await creditHoldService
      .placeHold({ projectId: charge.projectId, actorUserId: charge.actorUserId, referenceId, amount: input.lookupHoldCredits, ttlMs })
      .catch((err: unknown) => logger.error({ err, referenceId }, "credit_hold_place_failed"));
  }
  await input.handOff();

  /**
   * Release the operation's hold, logging a failure; the hold then expires.
   * @returns When it is done.
   */
  const release = (): Promise<void> =>
    creditHoldService.releaseHold(holdKey).catch((err: unknown) =>
      logger.error({ err, holdKey }, "credit_hold_release_failed"),
    );

  const credits = await usage.settle();
  if (credits === 0) {
    await release();
    return { credits, outcome: null };
  }
  try {
    const outcome = await creditLotService.chargeOnceForGeneration(chargeKey, { ...charge, amount: credits, releaseHold: holdKey });
    if (outcome === null) await release();
    return { credits, outcome };
  } catch (err) {
    await release();
    throw err;
  }
}
