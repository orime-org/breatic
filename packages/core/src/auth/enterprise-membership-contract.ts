// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { z } from "zod";
import { MEMBERSHIP_TIERS } from "@breatic/shared";

const tier = z.enum(MEMBERSHIP_TIERS);
const instant = z.string().datetime({ offset: true });
const count = z.number().int().min(0).max(2147483647);

/**
 * The current IANA zone names accepted by the date input contract.
 * @param value - A zone supplied by the operator.
 * @returns Whether the runtime knows the zone.
 */
function validZone(value: string): boolean {
  if (value !== "UTC" && !/^[A-Za-z]+(?:\/[A-Za-z_-]+){1,2}$/.test(value)) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(0);
    return true;
  } catch {
    return false;
  }
}

export const enterpriseMembershipLimitsSchema = z.object({
  team_studios: count,
  projects_per_studio: count,
  concurrent_editors: count,
  studio_members: count,
  project_members: count,
  storage_bytes: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
}).strict();

export const enterpriseMembershipWriteSchema = z.object({
  targetTier: z.literal("enterprise"),
  expiresAt: instant,
  entryTimezone: z.string().max(64).refine(validZone),
  contractNumber: z.string().trim().min(1).max(128).refine((s) => !s.includes("\u0000")),
  limits: enterpriseMembershipLimitsSchema,
  expectedRevision: z.number().int().positive().max(2147483646).nullable(),
  expectedStoredTier: tier,
}).strict();

export const enterpriseRecordSchema = z.object({
  expiresAt: instant,
  entryTimezone: enterpriseMembershipWriteSchema.shape.entryTimezone,
  contractNumber: enterpriseMembershipWriteSchema.shape.contractNumber,
  limits: enterpriseMembershipLimitsSchema,
  fallbackTier: z.enum(["base", "self_hosted"]),
  revision: z.number().int().positive().max(2147483647),
  createdAt: instant,
  updatedAt: instant,
}).strict();

export const rawMembershipSnapshotSchema = z.object({
  userId: z.string().uuid(),
  storedTier: tier,
  enterprise: enterpriseRecordSchema.nullable(),
}).strict();

const operation = z.object({
  key: z.string().regex(/^bo-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i),
  accountId: z.string().uuid(),
  adminId: z.string().min(1).max(255),
  requestHash: z.string().regex(/^[a-f0-9]{64}$/),
  recordedAt: instant,
}).strict();

export const enterpriseMembershipResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("applied"), operation, before: rawMembershipSnapshotSchema, after: rawMembershipSnapshotSchema }).strict(),
  z.object({ status: z.literal("refused"), operation, code: z.enum(["revision_conflict", "account_not_found"]), before: rawMembershipSnapshotSchema.nullable(), after: rawMembershipSnapshotSchema.nullable() }).strict(),
]).superRefine((value, ctx) => {
  const identity = [value.before, value.after].every((s) => s === null || s.userId === value.operation.accountId);
  let valid = identity;
  if (value.status === "applied") {
    valid = valid && value.after.storedTier === "enterprise" && value.after.enterprise !== null && value.after.enterprise.revision === (value.before.enterprise?.revision ?? 0) + 1;
  } else if (value.code === "account_not_found") {
    valid = valid && value.before === null && value.after === null;
  } else {
    valid = valid && value.before !== null && JSON.stringify(value.before) === JSON.stringify(value.after);
  }
  if (!valid) ctx.addIssue({ code: "custom", message: "Invalid membership operation relationship" });
});

export const enterpriseMembershipReadingSchema = z.object({
  asOf: instant,
  enterpriseState: z.enum(["ordinary", "missing", "active", "expired"]),
  effectiveTier: tier,
  limits: enterpriseMembershipLimitsSchema.nullable(),
  storageBytes: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable(),
  revision: z.number().int().positive().nullable(),
  expiresAt: instant.nullable(),
  fallbackTier: z.enum(["base", "self_hosted"]).nullable(),
  settlementProtected: z.boolean(),
}).strict();

export const enterpriseMembershipProfileSchema = z.object({
  account: z.object({ id: z.string().uuid(), email: z.string().email() }).strict(),
  snapshot: rawMembershipSnapshotSchema,
  reading: enterpriseMembershipReadingSchema,
}).strict().superRefine((value, ctx) => {
  if (value.account.id !== value.snapshot.userId || value.reading.revision !== (value.snapshot.enterprise?.revision ?? null) || value.reading.expiresAt !== (value.snapshot.enterprise?.expiresAt ?? null) || value.reading.fallbackTier !== (value.snapshot.enterprise?.fallbackTier ?? null)) ctx.addIssue({ code: "custom", message: "Invalid membership profile relationship" });
});

export type EnterpriseMembershipWrite = z.infer<typeof enterpriseMembershipWriteSchema>;
export type EnterpriseRecord = z.infer<typeof enterpriseRecordSchema>;
export type RawMembershipSnapshot = z.infer<typeof rawMembershipSnapshotSchema>;
export type EnterpriseMembershipResult = z.infer<typeof enterpriseMembershipResultSchema>;
export type EnterpriseMembershipProfile = z.infer<typeof enterpriseMembershipProfileSchema>;
