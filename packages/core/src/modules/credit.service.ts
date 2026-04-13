/**
 * Credit service — manages user credit balances and usage records.
 *
 * Usage recording and credit deduction are SEPARATE concerns:
 * - Recording: ALWAYS happens (audit trail for all LLM/AIGC usage)
 * - Deduction: Only when PAYMENT_ENABLED=true
 */

import * as userRepo from "./user.repo.js";
import * as creditRepo from "./credit.repo.js";
import { env } from "../config/env.js";
import { t } from "@breatic/shared";
import { AppError } from "../errors.js";
import { logger } from "../logger.js";

/** Sentinel balance returned when payments are disabled. */
const UNLIMITED_BALANCE = 999_999;

/**
 * Record usage and optionally deduct credits.
 *
 * Always records the transaction (tokens, model, credits) for auditing.
 * Only deducts from balance when PAYMENT_ENABLED is true.
 *
 * @param userId - The user who consumed resources
 * @param amount - Number of credits to deduct (must be positive)
 * @param description - Human-readable reason (e.g. "Agent chat", "SubAgent:researcher")
 * @param referenceId - External reference (e.g. conversation ID, task ID)
 * @param options - Token count and model name for detailed tracking
 * @returns The user's balance after operation
 * @throws {AppError} If PAYMENT_ENABLED and user has insufficient credits
 */
export async function deduct(
  userId: string,
  amount: number,
  description?: string,
  referenceId?: string,
  options?: { tokensUsed?: number; model?: string; provider?: string },
): Promise<number> {
  let newBalance: number;

  if (env.PAYMENT_ENABLED) {
    const success = await userRepo.deductCredits(userId, amount);
    if (!success) {
      const currentBalance = await userRepo.getCredits(userId);
      throw new AppError(
        402,
        t("server.error.insufficient_credits", { required: amount, available: currentBalance }),
      );
    }
    newBalance = await userRepo.getCredits(userId);
  } else {
    newBalance = UNLIMITED_BALANCE;
  }

  // Always record the transaction (audit trail)
  await creditRepo.recordTransaction({
    userId,
    txType: "deduct",
    amount: -amount,
    balanceAfter: newBalance,
    tokensUsed: options?.tokensUsed,
    model: options?.model,
    provider: options?.provider,
    description: description ?? "",
    referenceId,
  });

  logger.info(
    { userId, amount, tokens: options?.tokensUsed, model: options?.model, balance: newBalance, paymentEnabled: env.PAYMENT_ENABLED },
    "credits_deducted",
  );
  return newBalance;
}

/**
 * Add credits to a user's balance.
 *
 * @param userId - The user to credit
 * @param amount - Number of credits to add (must be positive)
 * @param description - Optional human-readable reason for the addition
 * @param referenceId - Optional external reference (e.g. payment ID)
 * @returns The user's new credit balance after addition
 */
export async function add(
  userId: string,
  amount: number,
  description?: string,
  referenceId?: string,
): Promise<number> {
  const newBalance = await userRepo.addCredits(userId, amount);

  await creditRepo.recordTransaction({
    userId,
    txType: "recharge",
    amount,
    balanceAfter: newBalance,
    description: description ?? "",
    referenceId,
  });

  logger.info(
    { userId, amount, balance: newBalance },
    "credits_added",
  );
  return newBalance;
}
