// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { z } from "zod";
import { MEMBERSHIP_TIERS, tierLimitsSchema } from "@breatic/shared";

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
  // Optional (inner#1968): a result stored before these existed is re-parsed
  // strictly by findOperation and replayed as stored, so neither has a default.
  // A save that leaves one out keeps the value already agreed.
  monthly_operations: count.optional(),
  running_tasks_per_user: z.number().int().min(1).max(30).optional(),
}).strict();

/**
 * What an enterprise account without a saved agreement gets, and what the
 * agreement columns default to (migration 0126): 16,000 operations a month and
 * 10 running tasks a person.
 */
export const MISSING_AGREEMENT_OPERATIONS = { monthlyOperations: 16000, runningTasksPerUser: 10 } as const;

/** The two operation terms an account's reading grants. */
export interface NegotiatedOperations {
  /** Operations included each month. */
  readonly monthlyOperations: number;
  /** Tasks one person may have running at once. */
  readonly runningTasksPerUser: number;
}

/**
 * The one answer to "how many operations a month, and how many running tasks
 * a person" for a reading: an active agreement's, the 16,000 and 10 of an
 * enterprise account without one, or the effective tier's configured values.
 * Never goes through the throwing enterprise limits lookup.
 * @param reading - One membership reading.
 * @param reading.limits - The limits it resolved, null for an enterprise account without an agreement.
 * @returns The two terms.
 */
export function negotiatedOperationsOf(reading: { readonly limits: { readonly monthly_operations?: number; readonly running_tasks_per_user?: number } | null }): NegotiatedOperations {
  return {
    monthlyOperations: reading.limits?.monthly_operations ?? MISSING_AGREEMENT_OPERATIONS.monthlyOperations,
    runningTasksPerUser: reading.limits?.running_tasks_per_user ?? MISSING_AGREEMENT_OPERATIONS.runningTasksPerUser,
  };
}

export const enterpriseMembershipWriteSchema = z.object({
  targetTier: z.literal("enterprise"),
  expiresAt: instant.refine((value) => {
    const at = new Date(value);
    return Number.isFinite(at.getTime()) && at.getUTCFullYear() >= 1 && at.getUTCFullYear() <= 9999;
  }, { message: "Expiry must be within UTC years 0001 through 9999" }),
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
  limits: tierLimitsSchema.strict().nullable(),
  storageBytes: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable(),
  revision: z.number().int().positive().nullable(),
  expiresAt: instant.nullable(),
  fallbackTier: z.enum(["base", "self_hosted"]).nullable(),
  settlementProtected: z.boolean(),
}).strict().refine(
  (reading) => reading.enterpriseState !== "active" || enterpriseMembershipLimitsSchema.safeParse(reading.limits).success,
  { path: ["limits"], message: "Invalid active enterprise limits" },
);

const profileShape = {
  account: z.object({ id: z.string().uuid(), email: z.string().email() }).strict(),
  snapshot: rawMembershipSnapshotSchema,
  reading: enterpriseMembershipReadingSchema,
};

/**
 * Whether a profile's account, snapshot and reading describe the same agreement.
 * @param value - The parsed profile.
 * @returns Whether the relations hold.
 */
function profileRelated(value: z.infer<z.ZodObject<typeof profileShape>>): boolean {
  return value.account.id === value.snapshot.userId && value.reading.revision === (value.snapshot.enterprise?.revision ?? null) && value.reading.expiresAt === (value.snapshot.enterprise?.expiresAt ?? null) && value.reading.fallbackTier === (value.snapshot.enterprise?.fallbackTier ?? null);
}

export const enterpriseMembershipProfileSchema = z.object(profileShape).strict().superRefine((value, ctx) => {
  if (!profileRelated(value)) ctx.addIssue({ code: "custom", message: "Invalid membership profile relationship" });
});

/**
 * The internal read answer: the profile plus this period's operations, null
 * where operations are not counted. Validates the current reading only and is
 * never stored.
 */
export const enterpriseMembershipAccountAnswerSchema = z.object({
  ...profileShape,
  operations: z.object({
    monthly: count,
    used: count,
    remaining: count,
    periodStart: instant,
    nextResetAt: instant,
  }).strict().nullable(),
}).strict().superRefine((value, ctx) => {
  if (!profileRelated(value)) ctx.addIssue({ code: "custom", message: "Invalid membership profile relationship" });
  const operations = value.operations;
  if (operations === null) return;
  if (operations.monthly !== negotiatedOperationsOf(value.reading).monthlyOperations || operations.remaining !== Math.max(0, operations.monthly - operations.used)) {
    ctx.addIssue({ code: "custom", path: ["operations"], message: "Invalid operations relationship" });
  }
});

export type EnterpriseMembershipWrite = z.infer<typeof enterpriseMembershipWriteSchema>;
export type EnterpriseRecord = z.infer<typeof enterpriseRecordSchema>;
export type RawMembershipSnapshot = z.infer<typeof rawMembershipSnapshotSchema>;
export type EnterpriseMembershipResult = z.infer<typeof enterpriseMembershipResultSchema>;
export type EnterpriseMembershipProfile = z.infer<typeof enterpriseMembershipProfileSchema>;
export type EnterpriseMembershipAccountAnswer = z.infer<typeof enterpriseMembershipAccountAnswerSchema>;
