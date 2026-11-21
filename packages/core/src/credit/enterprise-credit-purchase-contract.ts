// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from "zod";
import { creditRowDecimalSchema, parseCreditDecimal, parseGrantCredits } from "@breatic/shared";
import { creditGrantOperationSchema } from "@core/credit/credit-grant-contract.js";

export const ENTERPRISE_CREDIT_PURCHASE_REFUSAL_CODES = ["account_not_found", "not_enterprise", "enterprise_expired", "enterprise_missing", "enterprise_changed", "payments_disabled"] as const;
const instant = z.string().datetime({ offset: true });
const revision = z.number().int().positive().max(2147483647);
const contractNumber = z.string().trim().min(1).max(128).refine(value => !value.includes("\u0000"));
const amount = creditRowDecimalSchema.refine(value => parseCreditDecimal(value) >= 0n);
const quantity = z.string().transform((value, ctx) => {
  try { return parseGrantCredits(value); }
  catch {
    ctx.addIssue({ code: "custom", message: "Invalid enterprise purchase credits" });
    return z.NEVER;
  }
});

export const enterpriseCreditPurchaseWriteSchema = z.object({
  credits: quantity,
  reason: z.string().trim().min(1).max(500).refine(value => !value.includes("\u0000")),
  expectedEnterpriseRevision: revision,
  expectedContractNumber: contractNumber,
}).strict();

export const enterpriseCreditPurchaseOperationSchema = creditGrantOperationSchema;

export const enterpriseCreditPurchaseResultSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("applied"), operation: enterpriseCreditPurchaseOperationSchema,
    sourceId: z.string().uuid(), sourceKind: z.literal("enterprise"), lotId: z.string().uuid(),
    credits: amount, contractNumber, designatedStudioId: z.null(), remainingCredits: amount,
  }).strict(),
  z.object({ status: z.literal("refused"), operation: enterpriseCreditPurchaseOperationSchema, code: z.enum(ENTERPRISE_CREDIT_PURCHASE_REFUSAL_CODES) }).strict(),
]).superRefine((value, ctx) => {
  if (ctx.issues.length > 0 || value.status !== "applied") return;
  if (parseCreditDecimal(value.credits) <= 0n || parseCreditDecimal(value.credits) !== parseCreditDecimal(value.remainingCredits)) {
    ctx.addIssue({ code: "custom", message: "Invalid enterprise purchase creation snapshot" });
  }
});

export const enterpriseCreditPurchaseProfileSchema = z.object({
  account: z.object({ id: z.string().uuid(), email: z.string().email() }).strict(),
  enterpriseState: z.enum(["active", "expired", "missing", "ordinary"]),
  revision: revision.nullable(), contractNumber: contractNumber.nullable(), expiresAt: instant.nullable(),
  canPurchase: z.boolean(), reason: z.enum(ENTERPRISE_CREDIT_PURCHASE_REFUSAL_CODES).nullable(),
}).strict().superRefine((value, ctx) => {
  const complete = value.revision !== null && value.contractNumber !== null && value.expiresAt !== null;
  const stateReason = { ordinary: "not_enterprise", missing: "enterprise_missing", expired: "enterprise_expired" } as const;
  const valid = value.enterpriseState === "active"
    ? complete && (value.canPurchase ? value.reason === null : value.reason === "payments_disabled")
    : !value.canPurchase && value.reason === stateReason[value.enterpriseState]
      && (value.enterpriseState === "expired" ? complete : value.enterpriseState === "missing" ? !complete : true);
  if (!valid) ctx.addIssue({ code: "custom", message: "Invalid enterprise purchase eligibility" });
});

export type EnterpriseCreditPurchaseWrite = z.infer<typeof enterpriseCreditPurchaseWriteSchema>;
export type EnterpriseCreditPurchaseOperation = z.infer<typeof enterpriseCreditPurchaseOperationSchema>;
export type EnterpriseCreditPurchaseResult = z.infer<typeof enterpriseCreditPurchaseResultSchema>;
export type EnterpriseCreditPurchaseProfile = z.infer<typeof enterpriseCreditPurchaseProfileSchema>;
