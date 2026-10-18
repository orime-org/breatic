// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Credit admission shared by every route that starts paid work (#1580 #7,
 * inner#1611).
 *
 * A run is admitted by holding its estimate (`reserveForRun`): the studio's
 * purchases less its debt less every hold still counted must cover it, and
 * the hold stays until the worker charges the run or the run ends. Concurrent
 * runs therefore see each other's estimates instead of the same balance.
 *
 * A chat turn cannot know up front what it will cost, so it holds nothing: the
 * chat route admits it with `precheckCredits` on the balance alone, and the
 * turn is charged what it spent when it ends, into debt if need be.
 *
 * Extracted from mini-tools' route-local `checkCredits` so /canvas/tasks
 * and /mini-tools/* share ONE admission that can never drift.
 */

import { AppError, env, getNodeTaskConfig } from "@breatic/core";
import { assetService, creditHoldService, creditLotService } from "@breatic/domain";
import { t, type ProjectCreditsView } from "@breatic/shared";

/**
 * A run refused because running work holds what it needs, so a lane that
 * stores the refusal on its node can name that cause.
 */
export class CreditsHeldError extends AppError {
  /**
   * Build the refusal.
   * @param message - The refusal, already translated.
   */
  constructor(message: string) {
    super(402, message);
  }
}

/** The figures a refusal is explained with: the studio and its position. */
type RefusalFigures = { studioId: string } & ProjectCreditsView;

/**
 * Build the refusal for a run the studio cannot cover.
 *
 * The pool belongs to the studio owning the project, so the refusal has six
 * distinct causes and they read as six different sentences. The one that
 * matters most is "assign them first": a lot is unassigned the moment it is
 * bought, so "bought credits, went straight back to generating" is the most
 * frequent path there is, and answering it with "available 0" tells someone
 * who just paid that their payment did not arrive.
 *
 * A studio that owes is asked about before the account's unassigned lots are.
 * Its balance is below zero, so the unassigned branch would otherwise claim
 * it — and assigning credits into a studio that owes pays the debt down
 * first, which may still leave nothing to generate with.
 *
 * Holds are named only when the balance would cover the run without them.
 * A hold turns into a charge when its run succeeds, so waiting frees credits
 * only when running work fails or costs less than it held; unassigned credits
 * in the caller's account are the answer that certainly works, and come
 * first. When the balance would not cover the run even unheld, the sentence
 * is the one that leads somewhere: the shortfall, assigning, or topping up.
 *
 * Thrown rather than returned, so the answer is built where every other error
 * answer is built: a string each caller sent itself skipped `errorHandler` and
 * never passed through `t()`.
 * @param userId - The caller, whose own unassigned lots decide whether the
 *   refusal can point them at the assignment step.
 * @param required - Credits the run needs.
 * @param figures - The studio's position at the moment it was refused.
 * @returns Never.
 * @throws {CreditsHeldError} 402, when running work holds what the run needs.
 * @throws {AppError} 402, for every other cause.
 */
async function refuse(userId: string, required: number, figures: RefusalFigures): Promise<never> {
  const { studioId, spendable, held, available } = figures;

  if (spendable < 0) {
    const owed = await creditLotService.getStudioDebt(studioId);
    throw new AppError(402, t("server.credit.in_debt", { owed }));
  }

  if (held > 0 && spendable >= required) {
    const unassigned = await creditLotService.getUnassignedCredits(userId);
    // Still a hold refusal: the sentence points at the step that certainly
    // works, and a lane that stores the cause on its node names the hold.
    if (unassigned > 0) throw new CreditsHeldError(t("server.credit.unassigned", { available: unassigned }));
    throw new CreditsHeldError(t("server.credit.held_by_running", { held, available }));
  }

  if (available > 0) {
    throw new AppError(402, t("server.error.insufficient_credits", { required, available }));
  }

  const unassigned = await creditLotService.getUnassignedCredits(userId);
  if (unassigned > 0) {
    throw new AppError(402, t("server.credit.unassigned", { available: unassigned }));
  }

  // Granted credits are pinned to the holder's personal studio when they are
  // written, so an account holding any while this studio reaches none is
  // being stopped by that pin rather than by an empty account. Telling them
  // to top up would be the same mistake the unassigned branch avoids, on a
  // different cause.
  const granted = await creditLotService.getGrantedCredits(userId);
  if (granted > 0) {
    throw new AppError(402, t("server.credit.granted_elsewhere"));
  }

  throw new AppError(402, t("server.credit.none"));
}

/**
 * Admit a run by holding its estimate until the worker charges it or the run
 * ends. Skipped entirely when payments are disabled (dev / self-host).
 *
 * The hold lasts the task budget, the longest a run may go on (two hours,
 * `default_budget_ms`), so a run still working is still counted.
 * @param projectId - The project the run belongs to; its studio pays.
 * @param userId - The authenticated caller.
 * @param referenceId - The run's task id, which the worker releases by.
 * @param required - The run's estimate.
 * @throws {CreditsHeldError} 402 when running work holds what it needs.
 * @throws {AppError} 402 when the studio cannot cover it for another cause.
 */
export async function reserveForRun(
  projectId: string,
  userId: string,
  referenceId: string,
  required: number,
): Promise<void> {
  if (!env.PAYMENT_ENABLED) return;
  const outcome = await creditHoldService.reserveCredits({
    projectId,
    actorUserId: userId,
    referenceId,
    amount: required,
    ttlMs: getNodeTaskConfig().default_budget_ms,
  });
  if (outcome.ok) return;
  await refuse(userId, required, outcome);
}

/**
 * Refuse work whose studio's balance (purchases less debt) is below
 * `required`, holding nothing and leaving running work's holds out of it.
 * Skipped entirely when payments are disabled.
 * @param projectId - The project the work belongs to; its studio pays.
 * @param userId - The authenticated caller.
 * @param required - Credits the studio's balance must at least reach.
 * @throws {AppError} 402 when the balance does not cover `required`.
 */
export async function precheckCredits(
  projectId: string,
  userId: string,
  required: number,
): Promise<void> {
  if (!env.PAYMENT_ENABLED) return;

  const studioId = await assetService.resolveOwnerStudioId(projectId);
  const spendable = await creditLotService.getSpendableCredits(studioId);
  if (spendable >= required) return;
  await refuse(userId, required, { studioId, spendable, held: 0, available: spendable });
}
