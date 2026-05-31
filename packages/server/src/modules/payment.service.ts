/**
 * Payment service — Stripe Checkout for credit purchases.
 *
 * Users buy fixed credit tiers via Stripe Checkout. Credits never expire.
 * Webhook handler is idempotent (safe to replay).
 */

import * as paymentRepo from "@server/modules/payment.repo.js";
import { creditRepo } from "@breatic/core";
import { getStripeClient } from "@breatic/core";
import { findTierByName, getPricingTiers } from "@breatic/core";
import type { PaymentEntity } from "@breatic/shared";
import { t } from "@breatic/shared";
import { AppError, NotFoundError, ForbiddenError } from "@breatic/core";

/**
 * Create a Stripe Checkout session for purchasing credits.
 *
 * @param userId - Authenticated user ID
 * @param tierName - Tier name from pricing.yaml (e.g. "Pro")
 * @param successUrl - Redirect URL after successful payment
 * @param cancelUrl - Redirect URL if user cancels
 * @returns Payment ID and Stripe Checkout URL
 */
export async function createCheckout(
  userId: string,
  tierName: string,
  successUrl: string,
  cancelUrl: string,
): Promise<{ paymentId: string; checkoutUrl: string }> {
  const tier = findTierByName(tierName);
  if (!tier) {
    throw new AppError(
      400,
      t("server.payment.tier_not_found", { tier: tierName, available: getPricingTiers().map((p) => p.name).join(", ") }),
    );
  }

  if (!tier.stripePriceId) {
    throw new AppError(
      503,
      t("server.payment.price_not_configured", { tier: tier.name }),
    );
  }

  const stripe = getStripeClient();

  const session = await stripe.checkout.sessions.create({
    mode: "payment",
    line_items: [{ price: tier.stripePriceId, quantity: 1 }],
    success_url: successUrl,
    cancel_url: cancelUrl,
    metadata: {
      userId,
      tierName: tier.name,
      credits: String(tier.credits),
    },
  });

  const payment = await paymentRepo.createPayment({
    userId,
    stripeSessionId: session.id,
    amountCents: tier.priceCents,
    creditsGranted: tier.credits,
    currency: tier.currency,
    metadata: { tierName: tier.name, successUrl, cancelUrl },
  });

  // Caller logs `payment_checkout_session_created` audit line with
  // the returned paymentId + sessionId.
  return { paymentId: payment.id, checkoutUrl: session.url ?? "" };
}

/**
 * Handle Stripe `checkout.session.completed` webhook.
 *
 * Idempotent: skips if payment is already completed.
 * Atomically grants credits and records the transaction.
 */
export type CheckoutCompletedOutcome =
  | { status: "replay" }
  | {
      status: "completed";
      userId: string;
      creditsGranted: number;
      newBalance: number;
    };

export async function handleCheckoutCompleted(
  stripeSessionId: string,
  paymentIntentId?: string,
): Promise<CheckoutCompletedOutcome> {
  const payment = await paymentRepo.getPaymentByStripeSessionId(stripeSessionId);
  if (!payment) {
    throw new NotFoundError(t("server.error.not_found"));
  }

  // CAS: only transition pending → completed. If another webhook
  // already transitioned it, this returns false and we skip.
  const updated = await paymentRepo.updatePaymentStatusCAS(
    payment.id, "pending", "completed", paymentIntentId,
  );
  if (!updated) {
    // Caller logs `webhook_replay` (payment already completed).
    return { status: "replay" };
  }

  const newBalance = await creditRepo.addBalance(payment.userId, payment.creditsGranted);

  await creditRepo.recordTransaction({
    userId: payment.userId,
    txType: "purchase",
    amount: payment.creditsGranted,
    balanceAfter: newBalance,
    description: `Credit purchase: ${payment.creditsGranted} credits`,
    referenceId: payment.id,
  });

  // Caller logs `payment_credits_granted` audit line with the
  // returned userId / creditsGranted / newBalance.
  return {
    status: "completed",
    userId: payment.userId,
    creditsGranted: payment.creditsGranted,
    newBalance,
  };
}

/** Handle Stripe payment failure. Only transitions pending → failed. */
export async function handlePaymentFailed(stripeSessionId: string): Promise<void> {
  const payment = await paymentRepo.getPaymentByStripeSessionId(stripeSessionId);
  if (!payment) throw new NotFoundError(t("server.error.not_found"));
  if (payment.status !== "pending") return;
  await paymentRepo.updatePaymentStatus(payment.id, "failed");
}

/** Get payment with ownership check. */
export async function getPayment(paymentId: string, userId: string): Promise<PaymentEntity> {
  const payment = await paymentRepo.getPaymentById(paymentId);
  if (!payment) throw new NotFoundError(t("server.error.not_found"));
  if (payment.userId !== userId) throw new ForbiddenError(t("server.error.forbidden"));
  return payment;
}

/** List payments for a user. */
export async function listPayments(userId: string, limit = 20, offset = 0): Promise<PaymentEntity[]> {
  return paymentRepo.listPaymentsByUser(userId, limit, offset);
}

/**
 * Get available pricing tiers for frontend display.
 *
 * Strips Stripe Price IDs — frontend doesn't need them.
 */
export function listTiers(): Array<{
  name: string;
  credits: number;
  priceCents: number;
  currency: string;
  description: string;
}> {
  return getPricingTiers().map((tier) => ({
    name: tier.name,
    credits: tier.credits,
    priceCents: tier.priceCents,
    currency: tier.currency,
    description: tier.description,
  }));
}
