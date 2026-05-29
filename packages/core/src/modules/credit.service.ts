/**
 * Credit service — manages user credit balances and usage records.
 *
 * Usage recording and credit deduction are SEPARATE concerns:
 * - Recording: ALWAYS happens (audit trail for all LLM/AIGC usage)
 * - Deduction: Only when PAYMENT_ENABLED=true
 */

import * as userRepo from "@core/modules/user.repo.js";
import * as creditRepo from "@core/modules/credit.repo.js";
import { db } from "@core/db/client.js";
import { env } from "@core/config/env.js";
import { getRedis } from "@core/infra/redis.js";
import { t } from "@breatic/shared";
import { AppError, ValidationError } from "@core/errors.js";

/**
 * refKey format contract: ASCII alphanumerics plus a small punctuation
 * set (`_`, `:`, `.`, `-`), length 1-255. Matches the typical output of
 * UUID generators, `${conversationId}-turn-${N}` composites, and
 * `${taskId}:spawn:${idx}` patterns we'll use at call sites.
 *
 * Enforced at `deductOnce` entry so an empty/malformed key can never
 * slip through and create a lock-key collision like `dev:bill::userId:`.
 *
 * Exported for unit testing — not intended as a public API.
 */
export const REFKEY_PATTERN = /^[A-Za-z0-9_:.-]{1,255}$/;

/** Sentinel balance returned when payments are disabled. */
const UNLIMITED_BALANCE = 999_999;

/** Get user's current credit balance. Returns unlimited when payments disabled. */
export async function getBalance(userId: string): Promise<number> {
  if (!env.PAYMENT_ENABLED) return UNLIMITED_BALANCE;
  return userRepo.getCredits(userId);
}

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
    // Deduct + record in a single transaction so both succeed or both roll back.
    newBalance = await db.transaction(async () => {
      const success = await userRepo.deductCredits(userId, amount);
      if (!success) {
        const currentBalance = await userRepo.getCredits(userId);
        throw new AppError(
          402,
          t("server.error.insufficient_credits", { required: amount, available: currentBalance }),
        );
      }
      const balance = await userRepo.getCredits(userId);

      await creditRepo.recordTransaction({
        userId,
        txType: "deduct",
        amount: -amount,
        balanceAfter: balance,
        tokensUsed: options?.tokensUsed,
        model: options?.model,
        provider: options?.provider,
        description: description ?? "",
        referenceId,
      });

      return balance;
    });
  } else {
    newBalance = UNLIMITED_BALANCE;
    // Still record for audit trail (no deduction)
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
  }

  // Caller logs `credits_deducted` audit line with the returned
  // newBalance + the originating context (userId / model / tokens).
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

  // Caller logs `credits_added` audit line.
  return newBalance;
}

/**
 * Idempotent deduction — same refKey only deducts once **per user**.
 *
 * Uses Redis SETNX with 24h TTL. If the refKey was already used by this
 * user, returns `{ deducted: false }`. Safe for network retries, stream
 * replays, and concurrent calls.
 *
 * The lock key is scoped by userId (`${env}:bill:${userId}:${refKey}`),
 * matching the industry-standard idempotency pattern used by Stripe,
 * Square, AWS, and PayPal — different users with colliding refKeys
 * never interfere. This is what prevents "user B reuses user A's
 * refKey to skip their own charge": B's scoped key is independent
 * of A's, so B's SETNX succeeds and B gets billed normally.
 *
 * @throws {ValidationError} if refKey doesn't match REFKEY_PATTERN.
 *
 * Use for non-task-level billing: text stream, agent turn, subagent spawn.
 */
export async function deductOnce(
  userId: string,
  refKey: string,
  amount: number,
  description: string,
  options?: { tokensUsed?: number; model?: string; provider?: string },
): Promise<{ deducted: boolean; creditsAfter?: number }> {
  if (!REFKEY_PATTERN.test(refKey)) {
    throw new ValidationError(
      `deductOnce: refKey must match ${REFKEY_PATTERN} (got ${JSON.stringify(refKey)})`,
    );
  }

  const redis = getRedis();
  const lockKey = `${env.ENV}:bill:${userId}:${refKey}`;

  const acquired = await redis.set(lockKey, "1", "EX", 86400, "NX");
  if (acquired !== "OK") {
    // Caller decides whether to debug-log the already-billed skip.
    return { deducted: false };
  }

  try {
    const creditsAfter = await deduct(userId, amount, description, refKey, options);
    return { deducted: true, creditsAfter };
  } catch (err) {
    // Deduction failed — release lock so retry can attempt again
    await redis.del(lockKey);
    throw err;
  }
}
