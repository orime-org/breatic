// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Credit pre-check shared by every task-enqueuing route (#1580 #7, user
 * decision 2026-07-03: the server refuses obviously-insufficient balances
 * BEFORE creating a task; the worker still bills the actual usage at
 * completion).
 *
 * NON-LOCKING by design: the check reads what is available without reserving
 * anything, so two requests passing concurrently can both be admitted — the
 * accepted trade-off of a soft pre-check. The worker's charge remains the
 * billing source of truth.
 *
 * Extracted from mini-tools' route-local `checkCredits` so /canvas/tasks
 * and /mini-tools/* share ONE pre-check that can never drift.
 */

import { AppError } from "@breatic/core";
import { env } from "@breatic/core";
import { assetService, creditLotService } from "@breatic/domain";
import { t } from "@breatic/shared";

/**
 * Reject a task-enqueue request whose studio cannot cover `required` credits.
 * Skipped entirely when payments are disabled (dev / self-host).
 *
 * The pool belongs to the studio owning the project, so the refusal has three
 * distinct causes and they read as three different sentences. The one that
 * matters most is the middle one: a lot is unassigned the moment it is bought,
 * so "bought credits, went straight back to generating" is the most frequent
 * path there is, and answering it with "available 0" tells someone who just
 * paid that their payment did not arrive.
 * @param projectId - The project the task will run in; its studio pays.
 * @param userId - The authenticated caller, whose own unassigned lots decide
 *   whether the refusal can point them at the assignment step.
 * @param required - Credits the studio must at least hold (the model's
 *   `cost_per_call` estimate, or `MIN_TASK_CREDIT_COST` for flat checks).
 * Throws rather than returning a message, so the answer is built where every
 * other error answer is built. Returning a string meant each caller wrote its
 * own `c.json({error:{code:402,message}})`, which skipped `errorHandler`
 * entirely — the sentence never passed through `t()` and reached a Japanese
 * user in English, on the most frequent failure a paid product has.
 * @throws {AppError} 402 when the studio cannot cover `required`.
 */
export async function precheckCredits(
  projectId: string,
  userId: string,
  required: number,
): Promise<void> {
  if (!env.PAYMENT_ENABLED) return;

  const studioId = await assetService.resolveOwnerStudioId(projectId);
  const available = await creditLotService.getSpendableCredits(studioId);
  if (available >= required) return;

  if (available > 0) {
    throw new AppError(
      402,
      t("server.error.insufficient_credits", { required, available }),
    );
  }

  const unassigned = await creditLotService.getUnassignedCredits(userId);
  if (unassigned > 0) {
    throw new AppError(402, t("server.credit.unassigned", { available: unassigned }));
  }

  throw new AppError(402, t("server.credit.none"));
}
