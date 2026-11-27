// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * Credit admission shared by every route that starts paid work (#1580 #7,
 * inner#1611).
 *
 * A run is admitted by holding its estimate (`reserveForRun`): the studio's
 * designated lot balance less its debt less every counted hold must cover it, and
 * the hold stays until the worker charges the run or the run ends. Concurrent
 * runs therefore see each other's estimates instead of the same balance.
 *
 * Work that cannot know up front what it will cost (a chat turn, a text-tool
 * run, a Timeline execution) holds nothing: `precheckCredits` first refuses it
 * when its person or its studio has reached a monthly spend limit, then admits
 * it while the balance is above zero, and it is charged what it spent when it
 * ends, into debt if need be.
 *
 * Extracted from mini-tools' route-local `checkCredits` so /canvas/tasks
 * and /mini-tools/* share ONE admission that can never drift.
 */

import { AppError, env, getNodeTaskConfig, type DbTx } from "@breatic/core";
import { creditHoldService, creditLotService, SMALLEST_CREDIT } from "@breatic/domain";
import { SpendCapReachedError } from "@breatic/core";
import { parseCreditDecimal, quantizeQuotedCredits, serializeCreditMicro, ceilToCreditCent, formatCredits, getActiveLocale, t, type ProjectCreditsView } from "@breatic/shared";

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
 * @throws {AppError} 402, for every cause.
 */
async function refuse(userId: string, required: number, figures: RefusalFigures): Promise<never> {
  const { studioId, spendable, held, available } = figures;
  const locale = getActiveLocale();
  /**
   * A figure as the sentence shows it: two decimals at most, rounded up.
   * @param credits - The amount.
   * @returns The text.
   */
  const shown = (credits: number | string): string => formatCredits(credits, locale);

  if (parseCreditDecimal(spendable) < 0n) {
    const owed = await creditLotService.getStudioDebt(studioId);
    throw new AppError(402, t("server.credit.in_debt", { owed: shown(owed) }));
  }

  if (parseCreditDecimal(held) > 0n && parseCreditDecimal(spendable) >= quantizeQuotedCredits(required)) {
    const unassigned = await creditLotService.getUnassignedCredits(userId);
    // The sentence points at the step that certainly works.
    if (parseCreditDecimal(unassigned) > 0n) throw new AppError(402, t("server.credit.unassigned", { available: shown(unassigned) }));
    throw new AppError(402, t("server.credit.held_by_running", { held: shown(held), available: shown(available) }));
  }

  if (parseCreditDecimal(available) > 0n) {
    throw new AppError(402, t("server.error.insufficient_credits", { required: shown(required), available: shown(available) }));
  }

  const unassigned = await creditLotService.getUnassignedCredits(userId);
  if (parseCreditDecimal(unassigned) > 0n) {
    throw new AppError(402, t("server.credit.unassigned", { available: shown(unassigned) }));
  }

  // Granted credits are pinned to the holder's personal studio when they are
  // written, so an account holding any while this studio reaches none is
  // being stopped by that pin rather than by an empty account. Telling them
  // to top up would be the same mistake the unassigned branch avoids, on a
  // different cause.
  const granted = await creditLotService.getGrantedCredits(userId);
  if (parseCreditDecimal(granted) > 0n) {
    throw new AppError(402, t("server.credit.granted_elsewhere"));
  }

  throw new AppError(402, t("server.credit.none"));
}

/**
 * A balance refusal decided inside a caller's transaction ({@link reserveForRunIn}). Its sentence reads the account and
 * the studio's debt, so it is built once that transaction has rolled back ({@link explainHoldRefusal}), never while it
 * holds a connection.
 */
export class HoldRefused extends Error {
  /**
   * Carry what the refusal's sentence is built from.
   * @param userId - The caller.
   * @param required - The run's settled estimate.
   * @param figures - The studio's position when it was refused.
   */
  constructor(readonly userId: string, readonly required: number, readonly figures: RefusalFigures) {
    super("Run hold refused");
    this.name = "HoldRefused";
  }
}

/**
 * Admit an Agent turn on a balance above zero (#296), on the payer's own OpenRouter key too (inner#1953): the key pays
 * for the model, while web search, image search and page reading run on our services and are charged in credits, so a
 * turn that could not pay for them is refused before it starts. The refusal then says why the own key is not enough.
 * @param projectId - The turn's project.
 * @param userId - The authenticated caller.
 * @param keyOwner - The account whose own key runs the turn's model; undefined on our keys.
 * @throws {SpendCapReachedError} 402 when the caller or the studio has spent its monthly limit.
 * @throws {AppError} 402 when the balance is not above zero.
 */
export async function precheckAgentTurn(projectId: string, userId: string, keyOwner: string | undefined): Promise<void> {
  try {
    await precheckCredits(projectId, userId, SMALLEST_CREDIT);
  } catch (err) {
    // A spend limit says its own sentence; only a balance refusal is about the paid tools.
    if (keyOwner === undefined || err instanceof SpendCapReachedError || !(err instanceof AppError) || err.statusCode !== 402) throw err;
    const whose = keyOwner === userId ? "self" : "admin";
    throw new AppError(402, t("server.credit.agent_tools_need_credits", { refusal: err.message, whose }), err.reason);
  }
}

/**
 * Hold a run's estimate, inside `tx` when given. The hold lasts the task budget, the longest a run may go on (two hours,
 * `default_budget_ms`), so a run still working is still counted. The estimate is settled to whole hundredths once, here,
 * so the hold and the refusal's choice of cause read the same figure (inner#1666).
 * @param projectId - The project the run belongs to; its studio pays.
 * @param userId - The authenticated caller.
 * @param referenceId - The run's task id, which the worker releases by.
 * @param required - The run's estimate.
 * @param tx - The caller's transaction, or none.
 * @throws {SpendCapReachedError} 402 when a monthly spend limit cannot take the estimate.
 * @throws {HoldRefused} When the studio cannot cover it.
 * @throws {RangeError} When the estimate is negative or not a number.
 */
async function holdForRun(projectId: string, userId: string, referenceId: string, required: number, tx?: DbTx): Promise<void> {
  if (!env.CHARGING_ENABLED) return;
  const charge = ceilToCreditCent(required);
  const outcome = await creditHoldService.reserveCredits({
    projectId,
    actorUserId: userId,
    referenceId,
    amount: charge,
    ttlMs: getNodeTaskConfig().default_budget_ms,
  }, tx);
  if (outcome.ok) return;
  if (outcome.cap !== undefined) throw new SpendCapReachedError(outcome.cap);
  throw new HoldRefused(userId, charge, outcome);
}

/**
 * The answer to a failed admission: a {@link HoldRefused} becomes its 402 sentence; anything else is itself.
 * @param err - What the admission threw.
 * @returns The error to throw.
 */
export async function explainHoldRefusal(err: unknown): Promise<unknown> {
  if (!(err instanceof HoldRefused)) return err;
  return refuse(err.userId, err.required, err.figures).catch((answer: unknown) => answer);
}

/**
 * Admit a run by holding its estimate until the worker charges it or the run
 * ends. Skipped entirely when payments are disabled (dev / self-host).
 * @param projectId - The project the run belongs to; its studio pays.
 * @param userId - The authenticated caller.
 * @param referenceId - The run's task id, which the worker releases by.
 * @param required - The run's estimate.
 * @throws {SpendCapReachedError} 402 when a monthly spend limit cannot take the estimate.
 * @throws {AppError} 402 when the studio cannot cover it, running work holding what it needs among the causes.
 * @throws {RangeError} When the estimate is negative or not a number.
 */
export async function reserveForRun(
  projectId: string,
  userId: string,
  referenceId: string,
  required: number,
): Promise<void> {
  try {
    await holdForRun(projectId, userId, referenceId, required);
  } catch (err) {
    throw await explainHoldRefusal(err);
  }
}

/**
 * Hold a run's estimate inside the transaction that claims its task row (a mini-tool run whose task id the client chose,
 * inner#1968 design 3.10 U9): a refusal rolls the claim back. The caller passes what the admission throws through
 * {@link explainHoldRefusal} once the transaction has ended.
 * @param tx - The claim's transaction.
 * @param projectId - The project the run belongs to; its studio pays.
 * @param userId - The authenticated caller.
 * @param referenceId - The run's task id.
 * @param required - The run's estimate.
 * @throws {SpendCapReachedError} 402 when a monthly spend limit cannot take the estimate.
 * @throws {HoldRefused} When the studio cannot cover it.
 * @throws {RangeError} When the estimate is negative or not a number.
 */
export async function reserveForRunIn(tx: DbTx, projectId: string, userId: string, referenceId: string, required: number): Promise<void> {
  await holdForRun(projectId, userId, referenceId, required, tx);
}

/**
 * Admit work that holds nothing (chat turns, text tools, Timeline executions):
 * refuse it when the caller or the studio has reached a monthly spend limit,
 * then when the Studio's balance (designated lots less debt) is below
 * `required`, leaving running work's holds out of it. Skipped entirely when
 * payments are disabled.
 * @param projectId - The project the work belongs to; its studio pays.
 * @param userId - The authenticated caller.
 * @param required - Credits the studio's balance must at least reach.
 * @throws {SpendCapReachedError} 402 when the caller or the studio has spent its monthly limit.
 * @throws {AppError} 402 when the balance does not cover `required`.
 */
export async function precheckCredits(
  projectId: string,
  userId: string,
  required: number,
): Promise<void> {
  const refusal = await creditHoldService.judgeBalanceAdmission(projectId, userId, required);
  if (refusal === null) return;
  if (refusal.reason === "spend_cap") throw new SpendCapReachedError(refusal.cap);
  await refuse(userId, required, { studioId: refusal.studioId, spendable: refusal.spendable, held: serializeCreditMicro(0n), available: refusal.spendable });
}
