// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

import { z } from "zod";
import { miniToolConsumptionIdentitySchema } from "@breatic/shared/mini-tools";
import type { MiniToolPlanJobRequest } from "@breatic/shared";
import type { MiniToolSettlementDiscovery } from "@breatic/core";

const containerPricingSchema = z.strictObject({
  configVersion: z.string().min(1),
  size: z.strictObject({ vcpu: z.number().positive(), memory_gib: z.number().positive(), disk_gb: z.number().positive() }),
  prices: z.strictObject({ vcpu_second_usd: z.number().nonnegative(), memory_gib_second_usd: z.number().nonnegative(), disk_gb_second_usd: z.number().nonnegative() }),
});
const consumptionKeySchema = z.string().regex(/^[a-f0-9]{64}$/);

/** Backend-owned consumption facts: a container job's computed cost and the frozen class pricing. */
export const miniToolConsumptionRecordSchema = z.strictObject({
  schemaVersion: z.literal(1), consumptionKey: consumptionKeySchema,
  identity: miniToolConsumptionIdentitySchema,
  state: z.enum(["pending", "known", "recorded"]),
  creditMultiplier: z.number().nonnegative(), chargeTo: z.enum(["user", "platform"]),
  costUsd: z.number().nonnegative().nullable(),
  costSource: z.literal("computed").nullable(),
  raw: z.json().nullable(), credits: z.number().nonnegative().nullable(),
  containerPricing: containerPricingSchema,
}).superRefine((record, ctx) => {
  if (record.state === "pending") {
    if (record.costUsd !== null || record.costSource !== null || record.credits !== null) {
      ctx.addIssue({ code: "custom", message: "Pending consumption has no confirmed amount" });
    }
    return;
  }
  if (record.costUsd === null || record.costSource !== "computed") {
    ctx.addIssue({ code: "custom", message: "Confirmed consumption requires its actual amount and source" });
  }
  if ((record.state === "recorded") !== (record.credits !== null)) {
    ctx.addIssue({ code: "custom", path: ["credits"], message: "Only recorded consumption carries user credits" });
  }
  if (record.state === "recorded" && record.chargeTo === "platform" && record.credits !== 0) {
    ctx.addIssue({ code: "custom", path: ["credits"], message: "Platform-funded consumption has zero user credits" });
  }
});

/** Persistent work remaining after consumption lookup or recording. */
export const miniToolSettlementSchema = z.strictObject({
  version: z.number().int().nonnegative(), state: z.enum(["idle", "waiting", "checking", "settled"]),
  pendingConsumptionKeys: z.array(consumptionKeySchema).refine((keys) => new Set(keys).size === keys.length),
  nextAttemptAt: z.iso.datetime().nullable(), leaseToken: z.string().min(1).nullable(),
  leaseUntil: z.iso.datetime().nullable(), lastError: z.string().nullable(),
  consumptionSetComplete: z.boolean().optional(),
});

/** A lookup answer may commit only under its still-current database lease. */
export const miniToolSettlementClaimSchema = z.strictObject({
  version: z.number().int().nonnegative(), leaseToken: z.string().min(1),
});

/** Recording accepts no replacement quote or new upstream call. */
export const recordMiniToolConsumptionInputSchema = z.strictObject({
  taskId: z.string().uuid(), stepId: z.string().uuid(), identity: miniToolConsumptionIdentitySchema,
  claim: miniToolSettlementClaimSchema.optional(),
});

export type MiniToolConsumptionRecord = z.infer<typeof miniToolConsumptionRecordSchema>;
export type MiniToolContainerPricing = z.infer<typeof containerPricingSchema>;
export type MiniToolSettlement = z.infer<typeof miniToolSettlementSchema>;
export type MiniToolSettlementClaim = z.infer<typeof miniToolSettlementClaimSchema>;
export type RecordMiniToolConsumptionInput = z.infer<typeof recordMiniToolConsumptionInputSchema>;

/** Internal producer policy, frozen before submitting a known container identity. */
export const openMiniToolConsumptionInputSchema = recordMiniToolConsumptionInputSchema.omit({ claim: true }).extend({
  chargeTo: z.enum(["user", "platform"]),
  creditMultiplier: z.number().nonnegative(),
  containerPricing: containerPricingSchema,
});
export type OpenMiniToolConsumptionInput = z.infer<typeof openMiniToolConsumptionInputSchema>;

/** Stable discovery position; the database's UTC microseconds stay as text. */
export type MiniToolSettlementCursor = NonNullable<MiniToolSettlementDiscovery["cursor"]>;
/** A wake identity discovered from SQL rather than a queue's retention state. */
export interface DueMiniToolSettlement extends MiniToolSettlementCursor { settlementVersion: number }
/** One ordered discovery page, without acquiring a lookup lease. */
export interface DueMiniToolSettlementPage { items: DueMiniToolSettlement[]; nextCursor: MiniToolSettlementCursor | null }

/** A container job's confirmed computed cost under the original lease, with no replacement pricing. */
export const confirmMiniToolConsumptionInputSchema = recordMiniToolConsumptionInputSchema.extend({
  claim: miniToolSettlementClaimSchema,
  costUsd: z.number().nonnegative(),
  costSource: z.literal("computed"),
  raw: z.json(),
});
export type ConfirmMiniToolConsumptionInput = z.infer<typeof confirmMiniToolConsumptionInputSchema>;

/** A read-only answer: a container report that has no price yet stays pending and is never read as zero, or a known cost. */
export const miniToolConsumptionLookupSchema = z.discriminatedUnion("state", [
  z.strictObject({ state: z.literal("pending"), reason: z.string().min(1) }),
  z.strictObject({ state: z.literal("known"), costUsd: z.number().nonnegative(), costSource: z.literal("computed"), raw: z.json() }),
]);
export type MiniToolConsumptionLookup = z.infer<typeof miniToolConsumptionLookupSchema>;
/** Original expense and the immutable authority required to read a container report. */
export interface MiniToolConsumptionLookupInput { consumption: MiniToolConsumptionRecord; plan: MiniToolPlanJobRequest }
