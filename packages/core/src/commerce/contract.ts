// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The request and answer shapes the product and the billing service exchange
 * (inner#1993 §3). Both sides parse with these schemas, so a change to one
 * side's shape fails the other's parse in tests instead of in production.
 */

import { z } from "zod";
import { ANALYTICS_EVENT_NAMES, BILLING_PERIODS, ConsentSnapshotSchema, MEMBERSHIP_TIERS, type AnalyticsEventName } from "@breatic/shared";
import { ADS_CONVERSIONS } from "@core/ads/ads-types.js";
import { STRIPE_SUBSCRIPTION_STATUSES } from "@core/auth/subscription-state.js";

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

/** `PUT /internal/v1/commerce/subscription-facts/:deliveryId`: store a subscription fact. */
export const subscriptionFactRequestSchema = z
  .object({ userId: uuid, fact: subscriptionFactSchema, notices: z.array(subscriptionNoticeSchema).max(10), started: subscriptionStartedSchema.nullable() })
  .strict();
export type SubscriptionFactRequest = z.infer<typeof subscriptionFactRequestSchema>;

/** The answer to a subscription fact: the tier now in force and the paid tier it ended, if any. */
export const subscriptionFactAnswerSchema = z
  .object({ tier: z.enum(MEMBERSHIP_TIERS), endedFrom: z.enum(MEMBERSHIP_TIERS).nullable() })
  .strict();
export type SubscriptionFactAnswer = z.infer<typeof subscriptionFactAnswerSchema>;
