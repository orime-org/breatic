// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The request and answer shapes the product and the billing service exchange
 * (inner#1993 §3). Both sides parse with these schemas, so a change to one
 * side's shape fails the other's parse in tests instead of in production.
 */

import { z } from "zod";
import {
  ANALYTICS_EVENT_NAMES,
  BILLING_PERIODS,
  ConsentSnapshotSchema,
  MEMBERSHIP_TIERS,
  PROMOTER_CHANNEL_INPUT_MAX,
  PROMOTER_CHANNELS_MAX,
  PROMOTER_PLAN_INPUT_MAX,
  REFERRAL_CODE_INPUT_MAX,
  REQUEST_SHAPE_PARAMS,
  SIGNUP_REFERRAL_SOURCES,
  type AnalyticsEventName,
} from "@breatic/shared";
import { ADS_CONVERSIONS } from "@core/ads/ads-types.js";
import { STRIPE_SUBSCRIPTION_STATUSES } from "@core/auth/subscription-state.js";
import { storableText } from "@core/util/storable-text.js";

/**
 * The `error.reason` of a 503 the billing service answers when it is up but
 * the product could not take its call back (a grant or a subscription fact a
 * user is waiting on, §5.5). The product passes it to the browser unchanged,
 * as it does every answer in the public error shape the billing service's
 * /v1 handlers write.
 */
export const PRODUCT_UNAVAILABLE_REASON = "product_unavailable";

const uuid = z.string().uuid();
const cents = z.number().int().nonnegative();
const instant = z.string().datetime({ offset: true });

/** The Google Ads click a conversion is credited to. */
export const adClickSchema = z
  .object({ gclid: z.string().optional(), gbraid: z.string().optional(), wbraid: z.string().optional(), at: z.string() })
  .strict();

/** What a conversion report needs from the order that caused it. */
export const conversionContextSchema = z
  .object({ consent: ConsentSnapshotSchema, click: adClickSchema.nullable(), transactionId: z.string().min(1).max(200) })
  .strict();

/** `POST /internal/v1/commerce/payment-grants/:paymentId`: grant a completed payment. */
export const paymentGrantRequestSchema = z
  .object({
    userId: uuid,
    purchasedCredits: z.number().positive().finite(),
    amountCents: cents,
    taxCents: cents.nullable(),
    totalCents: cents.nullable(),
    currency: z.string().min(1).max(10),
    orderedAt: instant,
    conversion: conversionContextSchema,
  })
  .strict();
export type PaymentGrantRequest = z.infer<typeof paymentGrantRequestSchema>;

/** The answer to a payment grant: the lot and when it was granted. */
export const paymentGrantAnswerSchema = z.object({ lotId: uuid, grantedAt: instant }).strict();
export type PaymentGrantAnswer = z.infer<typeof paymentGrantAnswerSchema>;

/** `POST /internal/v1/commerce/refund-lots/facts`: read lots' refund facts. */
export const refundLotFactsRequestSchema = z.object({ lotIds: z.array(uuid).min(1).max(100) }).strict();
export type RefundLotFactsRequest = z.infer<typeof refundLotFactsRequestSchema>;

/** One lot's facts a refund decision reads. */
export const lotRefundFactsSchema = z
  .object({
    lotId: uuid,
    userId: uuid,
    sourceId: uuid,
    sourceKind: z.string(),
    lifecycle: z.string(),
    purchasedCredits: z.string(),
    remainingCredits: z.string(),
    refundAttempts: z.number().int().nonnegative(),
    refundRequestedAt: instant.nullable(),
    ledgerSum: z.string(),
    everSpent: z.boolean(),
    everRestored: z.boolean(),
    designated: z.boolean(),
    createdAt: instant,
  })
  .strict();
export type LotRefundFacts = z.infer<typeof lotRefundFactsSchema>;

/**
 * `POST /internal/v1/commerce/conversions`: report an event no product
 * transaction carries (a renewal, a cancellation, a failed payment).
 * `consent: "account"` stands for the account's latest reported consent.
 */
export const conversionReportSchema = z
  .object({
    name: z.string().refine((name): name is AnalyticsEventName => (ANALYTICS_EVENT_NAMES as readonly string[]).includes(name)),
    userId: uuid,
    insertId: z.string().min(1).max(200),
    properties: z.record(z.string(), z.unknown()),
    consent: z.union([ConsentSnapshotSchema, z.literal("account")]),
    ads: z
      .object({
        conversion: z.enum(ADS_CONVERSIONS),
        transactionId: z.string().min(1).max(64),
        click: adClickSchema.nullable(),
        value: z.object({ amountCents: cents, currency: z.string().min(1).max(10) }).strict().nullable(),
      })
      .strict()
      .nullable(),
  })
  .strict();
export type ConversionReport = z.infer<typeof conversionReportSchema>;

/** The answer to a conversion report: whether each side took it. */
export const conversionAnswerSchema = z.object({ tracked: z.boolean(), adsQueued: z.boolean() }).strict();
export type ConversionAnswer = z.infer<typeof conversionAnswerSchema>;

/**
 * One subscription as the billing service last read it from Stripe: the
 * product's `SubscriptionWrite` less what only the billing service acts on
 * (the item id, the invoice page), plus when it was first paid for.
 */
export const subscriptionFactSchema = z
  .object({
    stripeSubscriptionId: z.string().min(1).max(255),
    tier: z.enum(MEMBERSHIP_TIERS),
    period: z.enum(BILLING_PERIODS),
    status: z.enum(STRIPE_SUBSCRIPTION_STATUSES),
    currentPeriodEnd: instant.nullable(),
    cancelAtPeriodEnd: z.boolean(),
    hasPendingUpdate: z.boolean(),
    pendingTier: z.enum(MEMBERSHIP_TIERS).nullable(),
    pendingPeriod: z.enum(BILLING_PERIODS).nullable(),
    observedAt: instant,
    firstActiveAt: instant.nullable(),
  })
  .strict();
export type SubscriptionFact = z.infer<typeof subscriptionFactSchema>;

/** A bell notice written in the same transaction as the fact. */
export const subscriptionNoticeSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("membership_upgrade_incomplete"), toTier: z.enum(MEMBERSHIP_TIERS), toPeriod: z.enum(BILLING_PERIODS) }).strict(),
]);
export type SubscriptionNotice = z.infer<typeof subscriptionNoticeSchema>;

/** A subscription's first activation, reported after the fact commits. */
export const subscriptionStartedSchema = z
  .object({
    properties: z.object({ tier: z.enum(MEMBERSHIP_TIERS), interval: z.enum(BILLING_PERIODS), amountCents: cents, currency: z.string().min(1).max(10) }).strict(),
    consent: ConsentSnapshotSchema,
    click: adClickSchema.nullable(),
    transactionId: z.string().min(1).max(64),
  })
  .strict();
export type SubscriptionStarted = z.infer<typeof subscriptionStartedSchema>;

/**
 * `PUT /internal/v1/commerce/subscription-facts/:deliveryId`: store a
 * subscription fact. `referenceId` is what the tier ledger row the fact may
 * write points at: the Stripe event id, or the user action or recheck that
 * read the subscription (`checkout:<sessionId>`, `action:cancel:<subId>`, …).
 */
export const subscriptionFactRequestSchema = z
  .object({
    userId: uuid,
    fact: subscriptionFactSchema,
    notices: z.array(subscriptionNoticeSchema).max(10),
    started: subscriptionStartedSchema.nullable(),
    referenceId: z.string().min(1).max(255),
  })
  .strict();
export type SubscriptionFactRequest = z.infer<typeof subscriptionFactRequestSchema>;

/** The answer to a subscription fact: the tier now in force and the paid tier it ended, if any. */
export const subscriptionFactAnswerSchema = z
  .object({ tier: z.enum(MEMBERSHIP_TIERS), endedFrom: z.enum(MEMBERSHIP_TIERS).nullable() })
  .strict();
export type SubscriptionFactAnswer = z.infer<typeof subscriptionFactAnswerSchema>;

/** The edges a refund step takes on the product's lot (inner#1993 §3.3 `refund-steps`). */
export const REFUND_STEPS = ["mark_refunding", "settle", "send_back", "reject", "restore"] as const;
export type RefundStep = (typeof REFUND_STEPS)[number];

/**
 * What a finished disposition tells the buyer through the bell. A
 * `refund_completed` notice shows the request's `settled` amount, its only copy.
 */
export const refundTellSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("refund_completed") }).strict(),
  z.object({ kind: z.literal("refund_rejected") }).strict(),
  z.object({ kind: z.literal("refund_restored") }).strict(),
]);
export type RefundTell = z.infer<typeof refundTellSchema>;

/** What a settled refund paid back: the amount reported to analytics. */
export const refundSettledSchema = z.object({ amountCents: cents, currency: z.string().regex(/^[A-Za-z]{3}$/) }).strict();
export type RefundSettled = z.infer<typeof refundSettledSchema>;

/**
 * `POST /internal/v1/commerce/refund-steps/:operationId/:step`: move the lot
 * one edge. `referenceId` is what the ledger row the edge writes points at:
 * the Stripe refund for `settle`, the disposition otherwise. `settled` is
 * what a `settle` step paid back, whether the buyer is told or not, and null
 * on every other step; only a `settle` step tells `refund_completed`.
 */
export const refundStepRequestSchema = z
  .object({
    lotId: uuid,
    step: z.enum(REFUND_STEPS),
    referenceId: z.string().min(1).max(255),
    settled: refundSettledSchema.nullable(),
    tell: refundTellSchema.nullable(),
  })
  .strict()
  .refine((request) => (request.step === "settle") === (request.settled !== null), {
    message: "settled is required on a settle step and null on every other",
    path: ["settled"],
    params: REQUEST_SHAPE_PARAMS,
  })
  .refine((request) => request.tell?.kind !== "refund_completed" || request.step === "settle", {
    message: "refund_completed is told only on a settle step",
    path: ["tell"],
    params: REQUEST_SHAPE_PARAMS,
  });
export type RefundStepRequest = z.infer<typeof refundStepRequestSchema>;

/** The answer to a refund step: whether the edge applied, and the lot after it. */
export const refundStepAnswerSchema = z
  .object({ status: z.enum(["applied", "refused"]), code: z.literal("lot_state_changed").optional(), lot: lotRefundFactsSchema })
  .strict();
export type RefundStepAnswer = z.infer<typeof refundStepAnswerSchema>;

/**
 * `GET /internal/v1/commerce/accounts/:userId`: who to mail, in which
 * language, the tier in force (null for a deleted account) and the credits
 * the account holds, as a canonical credit decimal.
 */
export const accountFactsSchema = z
  .object({
    email: z.string(),
    locale: z.string(),
    deleted: z.boolean(),
    effectiveTier: z.enum(MEMBERSHIP_TIERS).nullable(),
    heldCredits: z.string(),
  })
  .strict();
export type AccountFacts = z.infer<typeof accountFactsSchema>;

/** `POST /internal/v1/commerce/accounts/lookup`: read many accounts' facts. */
export const accountLookupRequestSchema = z.object({ userIds: z.array(uuid).min(1).max(100) }).strict();
export type AccountLookupRequest = z.infer<typeof accountLookupRequestSchema>;

/** The answer to a lookup: one row per account that exists, deleted ones included. */
export const accountLookupAnswerSchema = z.array(
  z
    .object({ userId: uuid, email: z.string(), locale: z.string(), deleted: z.boolean(), personalStudioName: z.string().nullable() })
    .strict(),
);
export type AccountLookupAnswer = z.infer<typeof accountLookupAnswerSchema>;

/** What the product's outbox tells the billing service (inner#1993 §3.4). */
export const COMMERCE_OUTBOX_TYPES = ["referral_binding", "lot_refund_lifecycle", "account_erasure"] as const;
export type CommerceOutboxType = (typeof COMMERCE_OUTBOX_TYPES)[number];

/** A bought lot's lifecycle, mirrored by the billing service for its refund views. */
export const lotRefundLifecycleEventSchema = z
  .object({ lotId: uuid, paymentId: uuid, userId: uuid, lifecycle: z.string().min(1) })
  .strict();
export type LotRefundLifecycleEvent = z.infer<typeof lotRefundLifecycleEventSchema>;

/** A sign-up's referral code for the billing service to bind (§8.4). */
export const referralBindingEventSchema = z
  .object({ userId: uuid, code: z.string().min(1).max(64), source: z.enum(SIGNUP_REFERRAL_SOURCES), requestedAt: instant })
  .strict();
export type ReferralBindingEvent = z.infer<typeof referralBindingEventSchema>;

/** A deleted account whose consent the billing service's orders must drop. */
export const accountErasureEventSchema = z.object({ userId: uuid }).strict();
export type AccountErasureEvent = z.infer<typeof accountErasureEventSchema>;

/**
 * `POST /v1/inbox/:outboxId` on the billing service: one outbox row. `seq`
 * orders the rows of one aggregate.
 */
export const inboxDeliverySchema = z
  .object({
    type: z.enum(COMMERCE_OUTBOX_TYPES),
    aggregateKey: z.string().min(1).max(200),
    seq: z.number().int().positive(),
    payload: z.record(z.string(), z.unknown()),
  })
  .strict();
export type InboxDelivery = z.infer<typeof inboxDeliverySchema>;

/** The billing service's answer to one delivery. */
export const inboxAnswerSchema = z
  .object({ result: z.enum(["applied", "duplicate", "permanent_failure"]), detail: z.string().optional() })
  .strict();
export type InboxAnswer = z.infer<typeof inboxAnswerSchema>;

/**
 * The billing service's answer to a membership checkout confirm: the ad
 * conversion the page may report once the subscription is active.
 */
export const subscriptionConfirmAnswerSchema = z
  .object({
    data: z
      .object({
        conversion: z.object({ transactionId: z.string().min(1).max(64), amountCents: cents, currency: z.string().min(1).max(10) }).strict().nullable(),
      })
      .strict(),
  })
  .strict();
export type SubscriptionConfirmAnswer = z.infer<typeof subscriptionConfirmAnswerSchema>;

/**
 * A keyset position both sides write the same way: UTC, six fractional
 * digits, in Postgres's text form. Two of them compare as strings, which is
 * what lets purchase history merge the product's rows with the billing
 * service's.
 */
export const KEYSET_INSTANT = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{6}\+00$/;

/** One payment the billing service holds that opened no lot yet: still clearing, failed or abandoned. */
export const unlandedPaymentRowSchema = z
  .object({
    paymentId: uuid,
    amountCents: cents,
    taxCents: cents.nullable(),
    totalCents: cents.nullable(),
    currency: z.string().min(1).max(10),
    creditsGranted: z.string().regex(/^\d+\.\d{6}$/),
    status: z.string().min(1),
    createdAt: instant,
    cursorAt: z.string().regex(KEYSET_INSTANT),
    canResend: z.boolean(),
  })
  .strict();
export type UnlandedPaymentRow = z.infer<typeof unlandedPaymentRowSchema>;

/**
 * `GET /v1/users/:userId/payment/history/unlanded?limit=&before=`: the
 * newest `limit` such payments before the cursor, newest first.
 */
export const unlandedPaymentsAnswerSchema = z.object({ data: z.array(unlandedPaymentRowSchema) }).strict();

/** `POST /v1/users/:userId/payment/mail-status`: whether each purchase's letter can be sent again. */
export const mailStatusRequestSchema = z.object({ paymentIds: z.array(uuid).min(1).max(100) }).strict();
export const mailStatusAnswerSchema = z.object({ data: z.record(uuid, z.boolean()) }).strict();

const tierPrice = z.object({ priceCents: cents, currency: z.string().min(1).max(10) }).strict().nullable();

/**
 * `GET /v1/users/:userId/membership-panel`: what the membership panel needs
 * from the billing service — each comparable tier's price per period, and the
 * hosted page for the account's outstanding invoice.
 */
export const membershipPanelAnswerSchema = z
  .object({
    data: z
      .object({
        prices: z.record(z.string(), z.object({ month: tierPrice, year: tierPrice }).strict()),
        payableInvoiceUrl: z.string().url().nullable(),
      })
      .strict(),
  })
  .strict();
export type MembershipPanelAnswer = z.infer<typeof membershipPanelAnswerSchema>;

/** `POST /account/referral/binding`, forwarded as it came: the code to attach. */
export const referralBindingBodySchema = z.object({ code: z.string().min(1).max(REFERRAL_CODE_INPUT_MAX) });

/** `POST /account/referral/applications`, forwarded as it came: a promoter application. */
export const promoterApplicationBodySchema = z.object({
  country: z.string().regex(/^[A-Z]{2}$/),
  channels: z.array(storableText(z.string().trim().min(1).max(PROMOTER_CHANNEL_INPUT_MAX))).min(1).max(PROMOTER_CHANNELS_MAX),
  plan: storableText(z.string().trim().min(1).max(PROMOTER_PLAN_INPUT_MAX)),
  termsVersion: z.string().min(1).max(32),
});

/** `POST /v1/referral-codes/check`: whether a sign-up's code is active. */
export const referralCodeCheckRequestSchema = z.object({ code: z.string().min(1).max(64) }).strict();
/** The answer: whether it is active, and the code in the form it is stored. */
export const referralCodeCheckAnswerSchema = z.object({ active: z.boolean(), code: z.string().min(1).max(64) }).strict();
