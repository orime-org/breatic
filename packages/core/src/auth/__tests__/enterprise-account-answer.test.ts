// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The internal read answer with its operations (inner#1968, test spec F-14).
 *
 * `enterpriseMembershipAccountAnswerSchema` is the profile plus a top-level
 * `operations`, with two relations: `monthly` equals what the reading's
 * agreement grants (`negotiatedOperationsOf(reading).monthlyOperations`) and
 * `remaining` equals `max(0, monthly - used)`. `operations` may be null on a
 * self-hosted deployment (5.1 #2); the relations apply only when it is not.
 */

import { describe, expect, it } from "vitest";
import { enterpriseMembershipAccountAnswerSchema } from "../enterprise-membership-contract.js";

const id = "00000000-0000-4000-8000-000000001968";
const agreed = { team_studios: 8, projects_per_studio: 500, concurrent_editors: 30, studio_members: 200, project_members: 80, storage_bytes: 5497558138880, monthly_operations: 20000, running_tasks_per_user: 20 };
const record = { expiresAt: "2099-01-01T00:00:00.000Z", entryTimezone: "UTC", contractNumber: "ENT-F14", limits: agreed, fallbackTier: "base", revision: 1, createdAt: "2026-10-10T00:00:00.000Z", updatedAt: "2026-10-10T00:00:00.000Z" };
const answer = {
  account: { id, email: "enterprise@example.test" },
  snapshot: { userId: id, storedTier: "enterprise", enterprise: record },
  reading: { asOf: "2026-11-15T12:00:00.000Z", enterpriseState: "active", effectiveTier: "enterprise", limits: agreed, storageBytes: agreed.storage_bytes, revision: 1, expiresAt: record.expiresAt, fallbackTier: "base", settlementProtected: true },
  operations: { monthly: 20000, used: 9830, remaining: 10170, periodStart: "2026-11-10T00:00:00.000Z", nextResetAt: "2026-12-10T00:00:00.000Z" },
};

describe("enterpriseMembershipAccountAnswerSchema", () => {
  it("accepts an answer whose operations agree with the agreement", () => {
    expect(enterpriseMembershipAccountAnswerSchema.safeParse(answer).success).toBe(true);
  });

  it("accepts null operations", () => {
    expect(enterpriseMembershipAccountAnswerSchema.safeParse({ ...answer, operations: null }).success).toBe(true);
  });

  it("F-14 refuses a monthly that differs from the agreement's", () => {
    const parsed = enterpriseMembershipAccountAnswerSchema.safeParse({ ...answer, operations: { ...answer.operations, monthly: 16000, remaining: 6170 } });
    expect(parsed.success).toBe(false);
  });

  it("F-14 refuses a remaining other than max(0, monthly - used)", () => {
    const wrong = enterpriseMembershipAccountAnswerSchema.safeParse({ ...answer, operations: { ...answer.operations, remaining: 10000 } });
    expect(wrong.success).toBe(false);
    const negative = enterpriseMembershipAccountAnswerSchema.safeParse({ ...answer, operations: { ...answer.operations, used: 25000, remaining: -5000 } });
    expect(negative.success).toBe(false);
    const floored = enterpriseMembershipAccountAnswerSchema.safeParse({ ...answer, operations: { ...answer.operations, used: 25000, remaining: 0 } });
    expect(floored.success).toBe(true);
  });

  it.each(["monthly", "used", "remaining", "periodStart", "nextResetAt"] as const)("requires operations.%s", (field) => {
    const { [field]: _dropped, ...rest } = answer.operations;
    expect(enterpriseMembershipAccountAnswerSchema.safeParse({ ...answer, operations: rest }).success).toBe(false);
  });
});
