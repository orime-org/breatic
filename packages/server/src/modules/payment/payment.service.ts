// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Payment service — Stripe Checkout for credit purchases.
 *
 * Users buy fixed credit tiers via Stripe Checkout. Credits never expire.
 * Webhook handler is idempotent (safe to replay).
 */

import * as paymentRepo from "@server/modules/payment/payment.repo.js";
import { creditLotService } from "@breatic/domain";
import { getStripeClient } from "@server/infra/stripe.js";
import { findTierByPriceCents, getPricingTiers } from "@server/config/pricing.js";
import type { PaymentEntity } from "@breatic/shared";
import { t, getActiveLocale } from "@breatic/shared";
import { AppError, NotFoundError, ForbiddenError } from "@breatic/core";
import { db } from "@breatic/core";
import type { DbTx } from "@breatic/core";
import { claimWebhookEvent } from "@server/modules/subscription/webhook-events.repo.js";
import { sendPurchaseConfirmation } from "@server/modules/payment/purchase-mail.js";
import { renderPurchaseConfirmation } from "@server/modules/payment/purchase-mail-template.js";
import {
  CONSENT_CREDITS_VERSION,
  REFUND_CREDITS_VERSION,
  creditsConsentText,
} from "@server/modules/payment/legal-text.js";
import * as consentRepo from "@server/modules/payment/purchase-consent.repo.js";
import * as mailRepo from "@server/modules/payment/purchase-mail.repo.js";
import { randomUUID } from "node:crypto";
import type Stripe from "stripe";

/**
 * The Checkout Session as Stripe reports it now.
 *
 * Asked fresh on every pass rather than read off whatever event arrived: the
 * four callers hold different things, and only the session itself answers the
 * same way to all of them.
 * @param stripeSessionId - The session to read.
 * @returns The session.
 * @throws {Error} If Stripe refuses or times out; the caller decides.
 */
async function readCheckoutSession(
  stripeSessionId: string,
): Promise<Stripe.Checkout.Session> {
  return getStripeClient().checkout.sessions.retrieve(stripeSessionId);
}

/**
 * The locale this purchase was made in, as stored at checkout.
 *
 * The confirmation email goes out in the language the buyer was using when
 * they paid, which no later request carries — a resend triggered from another
 * device would otherwise switch languages mid-record.
 * @param session - The Checkout Session.
 * @returns The locale, falling back to English when the metadata is absent.
 */
function sessionLocale(session: Stripe.Checkout.Session): string {
  const stored = session.metadata?.["locale"];
  return typeof stored === "string" && stored.length > 0 ? stored : "en";
}

/**
 * Record the consent this purchase carries, when it carries one.
 *
 * Evidence, not inference: a session that completed before the consent
 * control shipped says nothing about what its buyer agreed to, and writing a
 * record anyway would invent it. `payment_id` being unique makes the second
 * and later callers no-ops.
 * @param paymentId - The payment this consent belongs to.
 * @param userId - Who gave it.
 * @param session - The Checkout Session carrying the answer.
 * @param tx - The fulfillment transaction.
 */
async function writeConsentIfGiven(
  paymentId: string,
  userId: string,
  session: Stripe.Checkout.Session,
  tx: DbTx,
): Promise<void> {
  if (session.consent?.terms_of_service !== "accepted") return;
  const consentedAt = session.created
    ? new Date(session.created * 1000)
    : new Date();
  await consentRepo.insertConsent(tx, {
    paymentId,
    userId,
    locale: sessionLocale(session),
    consentTextVersion: String(
      session.metadata?.["consent_text_version"] ?? "v1",
    ),
    refundTextVersion: session.metadata?.["refund_text_version"] ?? null,
    consentedAt,
    stripePaymentIntentId:
      typeof session.payment_intent === "string"
        ? session.payment_intent
        : null,
  });
}

/**
 * Open the outbox row for this purchase's confirmation email.
 *
 * Born `pending` inside the fulfillment transaction, so "no row" is
 * unreachable and the resend control always has something to render — which
 * is what makes a send that never started recoverable by the buyer.
 * @param paymentId - The payment the email is about.
 * @param locale - The language it will be written in.
 * @param tx - The fulfillment transaction.
 */
async function openMailOutbox(
  paymentId: string,
  locale: string,
  tx: DbTx,
): Promise<void> {
  await mailRepo.openOutbox(tx, paymentId, locale);
}

/**
 * What one pass of {@link fulfillPayment} did.
 *
 * `granted` is the only outcome that wrote anything, and the only one that
 * mails: every caller commits its transaction, including the passes that
 * found the work already done.
 */
export type FulfillOutcome =
  | { status: "granted"; userId: string; creditsGranted: number; lotId: string }
  | { status: "replay" }
  | { status: "noop" }
  | { status: "expired" }
  | { status: "mismatch" }
  | { status: "unknown" };

/**
 * Grant the credits one paid Checkout Session bought, exactly once.
 *
 * Four callers reach this: the return-side confirmation endpoint, the webhook,
 * the reconcile pass the credits overlay runs on mount, and cancelling a
 * checkout that turns out to have been paid. They all ask Stripe what the
 * session is now rather than trusting what brought them here, so the answer
 * does not depend on which one arrives first.
 *
 * Two guards cover different things, and both live in the one transaction so
 * they succeed or roll back together. Claiming the event stops Stripe's
 * redelivery of the same event; the CAS on `payments.status` stops two callers
 * holding different events, or none. Committing the claim separately would be
 * worse than not claiming at all: a fulfillment that failed afterwards would
 * leave the event marked as handled, and redelivery is the only automatic
 * recovery Stripe offers.
 * @param stripeSessionId - The Checkout Session to fulfill.
 * @param eventId - The Stripe event that brought us here, or null for the
 *   callers that hold none.
 * @returns What this pass did.
 * @throws {Error} If a write inside the transaction fails; the claim rolls
 *   back with it so redelivery can try again.
 */
export async function fulfillPayment(
  stripeSessionId: string,
  eventId: string | null,
): Promise<FulfillOutcome> {
  const payment =
    await paymentRepo.getPaymentByStripeSessionId(stripeSessionId);
  // The webhook endpoint is shared across the account and receives sessions
  // that are none of ours. Answering 200 keeps Stripe from redelivering
  // something unanswerable for three days; the caller logs it.
  if (!payment) return { status: "unknown" };

  const session = await readCheckoutSession(stripeSessionId);
  if (session.mode !== "payment") return { status: "noop" };

  if (session.payment_status === "unpaid") {
    if (session.status !== "expired") return { status: "noop" };
    const expired = await paymentRepo.updatePaymentStatusCAS(
      payment.id,
      ["pending", "failed"],
      "expired",
    );
    return expired ? { status: "expired" } : { status: "replay" };
  }

  // What Stripe charged, against what our own price table says this tier
  // costs. The price id is pasted into the yaml by hand and nothing ties it
  // to the amount behind it, so one wrong paste would otherwise bill one
  // figure, record another, and grant credits for a third — and the recorded
  // figure is what a refund pays back.
  if (
    session.amount_subtotal !== payment.amountCents ||
    session.currency !== payment.currency
  ) {
    return { status: "mismatch" };
  }

  const outcome = await db.transaction(async (tx) => {
    if (eventId !== null) {
      const claimed = await claimWebhookEvent(eventId, "checkout.session", tx);
      // Nothing has been written yet, so letting this empty transaction
      // commit is the same as rolling it back — and it keeps the answer a
      // replay rather than an exception the webhook route would answer 500 to.
      if (!claimed) return { status: "replay" } as const;
    }

    const taken = await paymentRepo.updatePaymentStatusCAS(
      payment.id,
      ["pending", "failed"],
      "completed",
      {
        stripePaymentIntentId:
          typeof session.payment_intent === "string"
            ? session.payment_intent
            : undefined,
        taxCents: session.total_details?.amount_tax ?? undefined,
        totalCents: session.amount_total ?? undefined,
      },
      tx,
    );
    if (!taken) return { status: "replay" } as const;

    const lot = await creditLotService.grantFromPayment(
      {
        paymentId: payment.id,
        userId: payment.userId,
        purchasedCredits: payment.creditsGranted,
      },
      tx,
    );

    await writeConsentIfGiven(payment.id, payment.userId, session, tx);
    await openMailOutbox(payment.id, sessionLocale(session), tx);

    return {
      status: "granted",
      userId: payment.userId,
      creditsGranted: payment.creditsGranted,
      lotId: lot.id,
    } as const;
  });

  // Only the pass that granted mails. Every caller commits its transaction,
  // including the ones that wrote nothing — and a replay is the ordinary case,
  // not an edge one: the confirmation endpoint grants, then the webhook
  // arrives seconds later with an event of its own and finds the CAS no longer
  // matches. Mailing on "the transaction committed" would send twice for
  // every purchase where the buyer came back before Stripe did.
  if (outcome.status === "granted") {
    // Not awaited: the buyer is behind a full-screen wait, Stripe wants its
    // 2xx, and the overlay's shared gate is holding. The send records its own
    // outcome, and a row left behind by a process that went away still offers
    // its resend.
    void startConfirmationMail(payment.id);
  }
  return outcome;
}

/**
 * Gather what one purchase's confirmation says, and hand it to the sender.
 *
 * Everything the letter states about the purchase comes from our own rows, so
 * a resend months later reads the same as the first send. The account balance
 * is the exception the consent spec asks for: it is what the account holds
 * now, and a resend says so.
 * @param paymentId - The purchase to confirm.
 */
async function sendConfirmationFor(paymentId: string): Promise<void> {
  const view = await paymentRepo.getConfirmationView(paymentId);
  if (!view) return;
  const letter = renderPurchaseConfirmation(view);
  await sendPurchaseConfirmation({
    paymentId,
    to: view.email,
    subject: letter.subject,
    html: letter.html,
    text: letter.text,
  });
}

/**
 * Build and send one purchase's confirmation, swallowing whatever happens.
 *
 * Separated from the fulfillment path so that nothing here can fail a request
 * that has already taken money and granted credits.
 * @param paymentId - The purchase to confirm.
 */
async function startConfirmationMail(paymentId: string): Promise<void> {
  try {
    await sendConfirmationFor(paymentId);
  } catch {
    // `sendPurchaseConfirmation` records its own failures; anything reaching
    // here failed before it, and the row still reads as unsent, so the buyer
    // keeps the resend.
  }
}

/**
 * How long a checkout session stays open, in seconds.
 *
 * Stripe's own example uses two hours; the parameter takes thirty minutes to
 * twenty-four, and defaults to twenty-four. This is a backstop for the buyer
 * who closes the tab, loses signal, or runs out of battery — the one who
 * clicks Back is expired on the spot by `cancelCheckout`. Thirty minutes is
 * the floor Stripe offers for event tickets held for minutes at a time, and
 * taking it here would trade a real buyer's second card attempt for showing
 * an abandoned checkout as expired a little sooner.
 */
const SESSION_LIFETIME_SECONDS = 2 * 60 * 60;

/** What Stripe's Checkout page can be rendered in, by our locale. */
const STRIPE_LOCALES: Record<string, string> = {
  en: "en",
  "zh-CN": "zh",
  "zh-TW": "zh-TW",
  ja: "ja",
  ko: "ko",
};

/**
 * The two URLs a buyer can come back on.
 *
 * They come off one `return_url` and land on one route, so each carries the
 * parameters that say which way it was: `session_id` on the way back from a
 * payment, `cancelled` and `payment_id` on the way back from the Back button.
 *
 * `{CHECKOUT_SESSION_ID}` has to reach Stripe with its braces intact, which
 * is why it is appended as text after `URL` has done the rest: `searchParams`
 * percent-encodes them, Stripe then substitutes nothing, and the confirmation
 * endpoint looks up a literal and finds no row. Nothing about that failure is
 * visible in testing — the webhook still grants the credits.
 * @param returnUrl - Where the buyer started from.
 * @param paymentId - The row the Back button should point at.
 * @returns Both URLs.
 */
function returnUrls(
  returnUrl: string,
  paymentId: string,
): { successUrl: string; cancelUrl: string } {
  const success = new URL(returnUrl);
  success.searchParams.set("credits", "1");

  const cancel = new URL(returnUrl);
  cancel.searchParams.set("credits", "1");
  cancel.searchParams.set("cancelled", "1");
  cancel.searchParams.set("payment_id", paymentId);

  return {
    successUrl: `${success.toString()}&session_id={CHECKOUT_SESSION_ID}`,
    cancelUrl: cancel.toString(),
  };
}

/**
 * The buyer's time zone, or UTC when it is not one we recognise.
 *
 * It is reported by their browser and reaches us in a request body, so it is
 * checked against the zones this runtime knows before it is stored. The
 * confirmation email prints a purchase time in it.
 * @param timeZone - What the client said.
 * @returns An IANA zone name.
 */
function knownTimeZone(timeZone: string): string {
  return Intl.supportedValuesOf("timeZone").includes(timeZone)
    ? timeZone
    : "UTC";
}

/**
 * Create a Stripe Checkout session for purchasing credits.
 *
 * The row's id is generated before the session, because the Back button URL
 * has to carry it. Doing it the other way round — insert first, fill in the
 * session id after — leaves a `pending` row with no session id behind every
 * failed `sessions.create`: all three paths to `expired` need that id, and
 * reconciling would keep picking the row up and retrieving nothing. The buyer
 * would watch a purchase stay "processing" forever.
 * @param input - Who is buying, what, and where they came from.
 * @param input.userId - The buyer.
 * @param input.priceCents - The pack's face value, which is how a pack is named.
 * @param input.returnUrl - The page the buyer started from.
 * @param input.timeZone - The buyer's IANA zone, as their browser reports it.
 * @returns The row's id and the Checkout URL to send the buyer to.
 * @throws {AppError} 400 when no pack carries that face value; 503 when the
 *   pack has no Stripe Price configured for this environment.
 */
export async function createCheckout(input: {
  userId: string;
  priceCents: number;
  returnUrl: string;
  timeZone: string;
}): Promise<{ paymentId: string; url: string }> {
  const tier = findTierByPriceCents(input.priceCents);
  if (!tier) {
    throw new AppError(
      400,
      t("server.payment.tier_not_found", {
        tier: String(input.priceCents),
        available: getPricingTiers()
          .map((p) => String(p.priceCents))
          .join(", "),
      }),
    );
  }

  if (!tier.stripePriceId) {
    throw new AppError(
      503,
      t("server.payment.price_not_configured", { tier: tier.name }),
    );
  }

  const paymentId = randomUUID();
  const locale = getActiveLocale();
  const { successUrl, cancelUrl } = returnUrls(input.returnUrl, paymentId);

  const session = await getStripeClient().checkout.sessions.create({
    mode: "payment",
    line_items: [{ price: tier.stripePriceId, quantity: 1 }],
    success_url: successUrl,
    cancel_url: cancelUrl,
    locale: (STRIPE_LOCALES[locale] ?? "auto") as Stripe.Checkout.
      SessionCreateParams.Locale,
    consent_collection: { terms_of_service: "required" },
    custom_text: {
      terms_of_service_acceptance: { message: creditsConsentText(locale) },
    },
    automatic_tax: { enabled: true },
    expires_at: Math.floor(Date.now() / 1000) + SESSION_LIFETIME_SECONDS,
    metadata: { userId: input.userId, credits: String(tier.credits) },
  });

  const payment = await paymentRepo.createPayment({
    id: paymentId,
    userId: input.userId,
    stripeSessionId: session.id,
    amountCents: tier.priceCents,
    creditsGranted: tier.credits,
    currency: tier.currency,
    // These four cannot be worked out later. A webhook carries no
    // `Accept-Language` and no hint of a time zone, and the versions say what
    // wording this purchase was made under.
    metadata: {
      locale,
      timeZone: knownTimeZone(input.timeZone),
      consentTextVersion: CONSENT_CREDITS_VERSION,
      refundTextVersion: REFUND_CREDITS_VERSION,
    },
  });

  // Caller logs `payment_checkout_session_created` audit line with
  // the returned paymentId + sessionId.
  return { paymentId: payment.id, url: session.url ?? "" };
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
      /** The lot the purchase opened. Unassigned, so not yet spendable. */
      lotId: string;
    };

/**
 * Handle Stripe payment failure. Only transitions pending → failed.
 * @param stripeSessionId - Stripe Checkout session ID from the webhook event
 * @throws {NotFoundError} if no payment matches the Stripe session ID
 */
export async function handlePaymentFailed(stripeSessionId: string): Promise<void> {
  const payment = await paymentRepo.getPaymentByStripeSessionId(stripeSessionId);
  if (!payment) throw new NotFoundError(t("server.error.not_found"));
  if (payment.status !== "pending") return;
  await paymentRepo.updatePaymentStatus(payment.id, "failed");
}

/**
 * Get payment with ownership check.
 * @param paymentId - Payment UUID to fetch
 * @param userId - Authenticated user; must own the payment
 * @returns The payment entity owned by the caller
 * @throws {NotFoundError} if no payment matches the ID
 * @throws {ForbiddenError} if the payment belongs to a different user
 */
export async function getPayment(paymentId: string, userId: string): Promise<PaymentEntity> {
  const payment = await paymentRepo.getPaymentById(paymentId);
  if (!payment) throw new NotFoundError(t("server.error.not_found"));
  if (payment.userId !== userId) throw new ForbiddenError(t("server.error.forbidden"));
  return payment;
}

/**
 * List payments for a user.
 * @param userId - User whose payments to list
 * @param limit - Page size (capped at 100 by the repo)
 * @param offset - Pagination offset
 * @returns The user's payment entities, newest first
 */
export async function listPayments(userId: string, limit = 20, offset = 0): Promise<PaymentEntity[]> {
  return paymentRepo.listPaymentsByUser(userId, limit, offset);
}

/**
 * Get available pricing tiers for frontend display.
 *
 * Strips Stripe Price IDs — frontend doesn't need them.
 * @returns The configured pricing tiers (name, credits, priceCents, currency, description)
 *   with Stripe Price IDs omitted
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
