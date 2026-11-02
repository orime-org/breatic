// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from "zod";
import { creditRowDecimalSchema, parseCreditDecimal, parseGrantCredits } from "@breatic/shared";

export const CREDIT_GRANT_KINDS = ["compensation", "gift"] as const;
export const CREDIT_GRANT_REFUSAL_CODES = ["account_not_found", "personal_studio_unavailable", "personal_studio_changed", "payments_disabled"] as const;
export const creditGrantKeySchema = z.string().regex(/^bo-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
const instant = z.string().datetime({ offset: true });
const amount = creditRowDecimalSchema.refine((value) => parseCreditDecimal(value) >= 0n);
const quantity = z.string().transform((value, ctx) => {
  try { return parseGrantCredits(value); } catch {
    ctx.addIssue({ code: "custom", message: "Invalid grant credits" });
    return z.NEVER;
  }
});

export const creditGrantWriteSchema = z.object({
  kind: z.enum(CREDIT_GRANT_KINDS),
  credits: quantity,
  reason: z.string().trim().min(1).max(500),
  expectedPersonalStudioId: z.string().uuid(),
}).strict();

export const creditGrantOperationSchema = z.object({
  key: creditGrantKeySchema,
  accountId: z.string().uuid(),
  adminId: z.string().uuid(),
  requestHash: z.string().regex(/^[a-f0-9]{64}$/),
  recordedAt: instant,
}).strict();

export const creditGrantResultSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("applied"), operation: creditGrantOperationSchema,
    sourceId: z.string().uuid(), sourceKind: z.enum(CREDIT_GRANT_KINDS), lotId: z.string().uuid(), personalStudioId: z.string().uuid(),
    grantedCredits: amount, repaidCredits: amount, remainingCredits: amount, debtBefore: amount, debtAfter: amount,
  }).strict(),
  z.object({ status: z.literal("refused"), operation: creditGrantOperationSchema, code: z.enum(CREDIT_GRANT_REFUSAL_CODES) }).strict(),
]).superRefine((value, ctx) => {
  if (ctx.issues.length > 0 || value.status !== "applied") return;
  const granted = parseCreditDecimal(value.grantedCredits);
  const repaid = parseCreditDecimal(value.repaidCredits);
  const remaining = parseCreditDecimal(value.remainingCredits);
  const before = parseCreditDecimal(value.debtBefore);
  const after = parseCreditDecimal(value.debtAfter);
  if (granted <= 0n || granted !== repaid + remaining || before !== repaid + after || repaid !== (granted < before ? granted : before)) {
    ctx.addIssue({ code: "custom", message: "Invalid credit grant relationship" });
  }
});

export const creditGrantProfileSchema = z.object({
  account: z.object({ id: z.string().uuid(), email: z.string().email() }).strict(),
  personalStudio: z.object({ id: z.string().uuid(), name: z.string(), slug: z.string() }).strict().nullable(),
  debtCredits: amount.nullable(),
  canGrant: z.boolean(),
  reason: z.enum(CREDIT_GRANT_REFUSAL_CODES).nullable(),
}).strict().superRefine((value, ctx) => {
  if ((value.canGrant && (value.personalStudio === null || value.debtCredits === null || value.reason !== null)) || (!value.canGrant && value.reason === null)) {
    ctx.addIssue({ code: "custom", message: "Invalid credit grant profile relationship" });
  }
});

export type CreditGrantKind = typeof CREDIT_GRANT_KINDS[number];
export type CreditGrantWrite = z.infer<typeof creditGrantWriteSchema>;
export type CreditGrantOperation = z.infer<typeof creditGrantOperationSchema>;
export type CreditGrantResult = z.infer<typeof creditGrantResultSchema>;
export type CreditGrantProfile = z.infer<typeof creditGrantProfileSchema>;
