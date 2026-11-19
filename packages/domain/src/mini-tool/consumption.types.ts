// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from "zod";
import { costSchema } from "@breatic/provider";
import { miniToolConsumptionIdentitySchema } from "@breatic/shared/mini-tools";
import type { MiniToolPlanJobRequest } from "@breatic/shared";
import type { MiniToolSettlementDiscovery } from "@breatic/core";

const containerPricingSchema = z.strictObject({
  configVersion: z.string().min(1),
  size: z.strictObject({ vcpu: z.number().positive(), memory_gib: z.number().positive(), disk_gb: z.number().positive() }),
  prices: z.strictObject({ vcpu_second_usd: z.number().nonnegative(), memory_gib_second_usd: z.number().nonnegative(), disk_gb_second_usd: z.number().nonnegative() }),
});
const consumptionKeySchema = z.string().regex(/^[a-f0-9]{64}$/);

/** One cost a model step's run handed over pending, and what its last lookup found (as `WaitingCost` in cost-wait.ts). */
export const miniToolWaitingCostSchema = z.strictObject({ lookup: z.looseObject({ upstream: z.string().min(1) }), cost: costSchema.optional() });
export type MiniToolWaitingCost = z.infer<typeof miniToolWaitingCostSchema>;

/**
 * Backend-owned consumption facts. A model step's (inner#1306 execution design §11.4) carries what its run cost the way a
 * canvas generation's wait does (`CostWait`): the upstream that served it, the costs known or missing when it ended, the
 * costs it waits on with what their last lookup found, the known dollars, how many lookups ran, when the window ends and
 * when the next lookup is due; it is known once every waiting cost has an answer. A container job's carries its computed
 * cost and the frozen class pricing.
 */
export const miniToolConsumptionRecordSchema = z.strictObject({
  schemaVersion: z.literal(1), consumptionKey: consumptionKeySchema,
  identity: miniToolConsumptionIdentitySchema,
  state: z.enum(["pending", "known", "recorded"]),
  creditMultiplier: z.number().nonnegative(), chargeTo: z.enum(["user", "platform"]),
  costUsd: z.number().nonnegative().nullable(),
  costSource: z.literal("computed").nullable(),
  raw: z.json().nullable(), credits: z.number().nonnegative().nullable(),
  containerPricing: containerPricingSchema.nullable(),
  servedBy: z.string().min(1).nullable().optional(),
  costs: z.array(costSchema).optional(),
  waiting: z.array(miniToolWaitingCostSchema).optional(),
  known: z.number().nonnegative().optional(),
  attempts: z.number().int().nonnegative().optional(),
  windowEndsAt: z.number().int().nonnegative().optional(),
  nextLookupAt: z.number().int().nonnegative().nullable().optional(),
}).superRefine((record, ctx) => {
  const provider = record.identity.kind === "provider";
  if (provider !== (record.containerPricing === null)) {
    ctx.addIssue({ code: "custom", path: ["containerPricing"], message: "Container consumption requires frozen class pricing; provider consumption has none" });
  }
  const wait = [record.servedBy, record.costs, record.waiting, record.known, record.attempts, record.windowEndsAt, record.nextLookupAt];
  if (provider ? wait.some((field) => field === undefined) : wait.some((field) => field !== undefined)) {
    ctx.addIssue({ code: "custom", message: "Only a model step's consumption carries its cost wait, and it carries all of it" });
  }
  if (provider && (record.costs ?? []).some((cost) => cost.state === "pending")) {
    ctx.addIssue({ code: "custom", path: ["costs"], message: "A pending cost waits in waiting" });
  }
  if (provider && record.state !== "pending" && (record.waiting ?? []).some((held) => held.cost === undefined || held.cost.state === "pending")) {
    ctx.addIssue({ code: "custom", path: ["waiting"], message: "Known consumption has an answer for every waiting cost" });
  }
  if (record.state === "pending") {
    if (record.costUsd !== null || record.costSource !== null || record.credits !== null) {
      ctx.addIssue({ code: "custom", message: "Pending consumption has no confirmed amount" });
    }
    return;
  }
  if (record.costUsd === null || record.costSource !== (provider ? null : "computed")) {
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
  containerPricing: containerPricingSchema.nullable(),
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

/** One lookup of a model step's waiting costs, written back under the original lease (§11.4 lookup row). */
export const recordMiniToolConsumptionLookupInputSchema = z.strictObject({
  taskId: z.string().uuid(), stepId: z.string().uuid(), claim: miniToolSettlementClaimSchema,
  /** What each waiting cost's lookup answered, in the order the consumption lists them. */
  costs: z.array(costSchema),
});
export type RecordMiniToolConsumptionLookupInput = z.infer<typeof recordMiniToolConsumptionLookupInputSchema>;

/**
 * A read-only answer: a container report that has no price yet stays pending and is never read as zero; a known
 * container cost; or, for a model step, what each of its waiting costs' lookups answered, in their order.
 */
export const miniToolConsumptionLookupSchema = z.discriminatedUnion("state", [
  z.strictObject({ state: z.literal("pending"), reason: z.string().min(1) }),
  z.strictObject({ state: z.literal("known"), costUsd: z.number().nonnegative(), costSource: z.literal("computed"), raw: z.json() }),
  z.strictObject({ state: z.literal("looked_up"), costs: z.array(costSchema) }),
]);
export type MiniToolConsumptionLookup = z.infer<typeof miniToolConsumptionLookupSchema>;
/**
 * Original expense and the immutable authority required to read a container report; a model step's lookup also says
 * whether it is the last the wait allows, so a cost still unanswered on it is missing.
 */
export interface MiniToolConsumptionLookupInput { consumption: MiniToolConsumptionRecord; plan?: MiniToolPlanJobRequest; lastAttempt?: boolean }
