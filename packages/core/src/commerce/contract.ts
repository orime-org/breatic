// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The request and answer shapes the product and the billing service exchange
 * (inner#1993 §3). Both sides parse with these schemas, so a change to one
 * side's shape fails the other's parse in tests instead of in production.
 */

import { z } from "zod";
import { ConsentSnapshotSchema } from "@breatic/shared";

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
