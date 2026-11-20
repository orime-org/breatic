// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A video mini-tool's model steps through provider (inner#1306 execution design §11.2, §11.4).
 *
 * Each model step keeps its own provider ticket and send mark on its `task_upstream_steps` row, with the same meaning
 * as a canvas generation's on its task row. A step ends once: returned with its link, or failed with its category; the
 * end writes its result, its costs (those handed over then and those appended on earlier throws) and its consumption in
 * one transaction. The consumption waits on its pending costs the way a canvas generation's wait does (`cost-wait.ts`):
 * first due `cost_wait_delay_ms` after the end, each later lookup twice as late, `cost_wait_attempts` lookups in all.
 */

import { z } from "zod";
import { costSchema, type Cost } from "@breatic/provider";
import { db, env, getNodeTaskConfig, type DbTx } from "@breatic/core";
import { DeadlinePassed } from "@breatic/shared";
import { miniToolConsumptionKey } from "@breatic/shared/mini-tools";
import * as creditHoldService from "@domain/credit/creditHold.service.js";
import * as taskRepo from "@domain/task/task.repo.js";
import * as stepRepo from "@domain/task/upstreamStep.repo.js";
import { mirrorMiniToolExecutionConsumption } from "@domain/mini-tool/execution-usage.service.js";
import { isUnresolvedModelStep, modelStepEnded, nextSettlementDue } from "@domain/mini-tool/consumption-due.js";
import {
  miniToolConsumptionRecordSchema, miniToolSettlementSchema, recordMiniToolConsumptionLookupInputSchema,
  type MiniToolConsumptionRecord, type MiniToolSettlement, type RecordMiniToolConsumptionLookupInput,
} from "@domain/mini-tool/consumption.types.js";

/** How a model step ended. */
export type MiniToolModelStepEnd =
  | { kind: "returned"; link: string }
  | { kind: "failed"; category: "model_rejected" | "timeout" | "failed"; error: Record<string, z.core.util.JSONType> };

/** A model step's end and what its run cost. */
export interface EndMiniToolModelStepInput {
  taskId: string;
  stepId: string;
  end: MiniToolModelStepEnd;
  /** The costs the run handed over at its end; those appended on earlier throws are added. */
  costs: Cost[];
  /** The upstream that served it, or null when none did. */
  servedBy: string | null;
}

/** A model step a run's end must abandon: its ticket, if it holds one. */
export interface UnresolvedMiniToolModelStep { stepId: string; ticket: ({ version: number } & Record<string, unknown>) | null }

/**
 * The configured first delay and number of lookups.
 * @returns Them.
 */
function pace(): { delay: number; attempts: number } {
  const cfg = getNodeTaskConfig();
  return { delay: cfg.cost_wait_delay_ms, attempts: cfg.cost_wait_attempts };
}

/**
 * The step under the task lock, or an error when the task owns no such step.
 * @param taskId - The task.
 * @param stepId - The step.
 * @param tx - The transaction.
 * @returns The locked task and the step.
 * @throws {Error} When the task or the step is not the task's.
 */
async function owned(taskId: string, stepId: string, tx: DbTx): Promise<{ task: taskRepo.LockedMiniToolConsumptionTask; step: stepRepo.UpstreamStep }> {
  const task = await taskRepo.lockMiniToolConsumptionTask(taskId, tx);
  if (!task || task.source !== "mini_tool") throw new Error("Model step has no owning mini-tool task");
  const step = await stepRepo.getStepForConsumption(taskId, stepId, tx);
  if (!step || step.kind !== "generate") throw new Error("Model step does not belong to its task");
  return { task, step };
}

/**
 * Whether the task's call set takes no new call.
 * @param task - The locked task.
 * @returns True once billed, complete or settled.
 * @throws {z.ZodError} When the settlement is malformed.
 */
function closed(task: taskRepo.LockedMiniToolConsumptionTask): boolean {
  const period = task.result.settlement === undefined ? null : miniToolSettlementSchema.parse(task.result.settlement);
  return task.billedAt !== null || period?.consumptionSetComplete === true || period?.state === "settled";
}

/**
 * A model step's ticket and send mark.
 * @param taskId - The owning task.
 * @param stepId - The step.
 * @returns What it holds.
 * @throws {Error} When the task owns no such step.
 */
export async function getStepTicket(taskId: string, stepId: string): Promise<stepRepo.StoredStepTicket> {
  const held = await stepRepo.getStepTicket(taskId, stepId);
  if (held === null) throw new Error("Model step does not belong to its task");
  return held;
}

/**
 * Store a model step's ticket over an older one.
 * @param taskId - The owning task.
 * @param stepId - The step.
 * @param ticket - provider's ticket.
 * @returns True when stored; false when a ticket as new or newer is stored.
 * @throws {Error} When the task owns no such step.
 */
export async function storeStepTicket(taskId: string, stepId: string, ticket: { version: number } & Record<string, unknown>): Promise<boolean> {
  const stored = await stepRepo.storeStepTicket(taskId, stepId, ticket);
  if (stored === null) throw new Error("Model step does not belong to its task");
  return stored;
}

/**
 * Mark a model step's send in flight, before the paid request goes out: refused once the task ended or its bill is
 * closed, and past the deadline by the database clock; the first send opens the task's settlement. No consumption is
 * opened here; the step's end opens it.
 * @param taskId - The owning task.
 * @param stepId - The step.
 * @param deadlineAt - The run's deadline, in epoch milliseconds.
 * @throws {DeadlinePassed} When the deadline has passed.
 * @throws {Error} When the task owns no such step, has ended or its call set is closed.
 */
export async function markStepSending(taskId: string, stepId: string, deadlineAt: number): Promise<void> {
  const passed = await db.transaction(async (tx): Promise<boolean> => {
    const { task, step } = await owned(taskId, stepId, tx);
    if ((task.status !== "pending" && task.status !== "running") || closed(task) || modelStepEnded(step)) {
      throw new Error("Model step's task takes no new send");
    }
    const now = await taskRepo.miniToolSettlementDatabaseNow(task.id, tx);
    if (Date.parse(now) >= deadlineAt) return true;
    await stepRepo.setStepSending(task.id, step.id, now, tx);
    if (task.result.settlement === undefined) {
      await taskRepo.storeMiniToolSettlement(task.id, miniToolSettlementSchema.parse({
        version: 0, state: "waiting", consumptionSetComplete: false, pendingConsumptionKeys: [],
        nextAttemptAt: now, leaseToken: null, leaseUntil: null, lastError: null,
      }), tx);
    }
    return false;
  });
  if (passed) throw new DeadlinePassed();
}

/**
 * Clear a model step's send mark.
 * @param taskId - The owning task.
 * @param stepId - The step.
 * @throws {Error} When the task owns no such step.
 */
export async function clearStepSending(taskId: string, stepId: string): Promise<void> {
  if (!await stepRepo.setStepSending(taskId, stepId, null)) throw new Error("Model step does not belong to its task");
}

/**
 * Keep the costs a model step's run handed over on a throw, which its end adds to its own.
 * @param taskId - The owning task.
 * @param stepId - The step.
 * @param costs - What `costsOf` handed over.
 * @throws {Error} When the task owns no such step.
 */
export async function appendMiniToolStepDeliveredCosts(taskId: string, stepId: string, costs: readonly Cost[]): Promise<void> {
  if (costs.length === 0) return;
  const parsed = z.array(costSchema).parse(costs);
  await db.transaction(async (tx) => {
    const { step } = await owned(taskId, stepId, tx);
    if (modelStepEnded(step)) throw new Error("Model step has ended; its costs are recorded");
    await stepRepo.appendStepDeliveredCosts(taskId, stepId, parsed, tx);
  });
}

/**
 * Count a send the upstream did not take.
 * @param taskId - The owning task.
 * @param stepId - The step.
 * @returns How many sends of it the upstream has not taken.
 * @throws {Error} When the task owns no such step.
 */
export async function recordStepSendNotAccepted(taskId: string, stepId: string): Promise<number> {
  return stepRepo.countStepSendNotAccepted(taskId, stepId);
}

/**
 * The model steps a run's end must abandon: a ticket or a send mark, and no end (§11.2 unresolved row). A ticket never
 * sent costs nothing to abandon.
 * @param taskId - The task.
 * @returns Each with its ticket.
 */
export async function listUnresolvedMiniToolModelSteps(taskId: string): Promise<UnresolvedMiniToolModelStep[]> {
  return (await stepRepo.listSteps(taskId)).flatMap((step) => (isUnresolvedModelStep(step)
    ? [{ stepId: step.id, ticket: (step.output.providerTicket as UnresolvedMiniToolModelStep["ticket"] | undefined) ?? null }]
    : []));
}

/**
 * The consumption of a step that ended now: the costs known or missing, the costs it waits on, the known dollars and
 * the first lookup's due time.
 * @param base - The identity and policy fields.
 * @param costs - Every cost the step's run handed over.
 * @param servedBy - The upstream that served it.
 * @param now - The database clock, in epoch milliseconds.
 * @returns The record.
 * @throws {z.ZodError} When it is malformed.
 */
function openedConsumption(base: Pick<MiniToolConsumptionRecord, "consumptionKey" | "identity" | "chargeTo" | "creditMultiplier">,
  costs: readonly Cost[], servedBy: string | null, now: number): MiniToolConsumptionRecord {
  const { delay, attempts } = pace();
  const settled = costs.filter((cost) => cost.state !== "pending");
  const waiting = costs.flatMap((cost) => (cost.state === "pending" ? [{ lookup: cost.lookup }] : []));
  const known = settled.reduce((sum, cost) => sum + (cost.state === "known" ? cost.usd : 0), 0);
  const pending = waiting.length > 0;
  return miniToolConsumptionRecordSchema.parse({
    schemaVersion: 1, ...base, state: pending ? "pending" : "known", costUsd: pending ? null : known, costSource: null,
    raw: null, credits: null, containerPricing: null, servedBy, costs: settled, waiting, known, attempts: 0,
    windowEndsAt: now + delay * (2 ** attempts - 1), nextLookupAt: pending ? now + delay : null,
  });
}

/**
 * Write the settlement after a consumption changed: waiting, with the remaining keys, due at the earliest unrecorded
 * item.
 * @param task - The locked task.
 * @param previous - Its settlement.
 * @param now - The database clock as text.
 * @param tx - The transaction.
 * @returns The written settlement.
 * @throws {Error} When persistence fails.
 */
async function rewaitSettlement(task: taskRepo.LockedMiniToolConsumptionTask, previous: MiniToolSettlement, now: string, tx: DbTx): Promise<MiniToolSettlement> {
  const steps = await stepRepo.listSteps(task.id, tx);
  const due = nextSettlementDue(steps, Date.parse(now));
  const next = miniToolSettlementSchema.parse({
    ...previous, version: previous.version + 1, state: "waiting",
    pendingConsumptionKeys: due.pendingKeys, nextAttemptAt: new Date(due.at ?? Date.parse(now)).toISOString(),
    leaseToken: null, leaseUntil: null, lastError: null,
  });
  await taskRepo.storeMiniToolSettlement(task.id, next, tx);
  return next;
}

/**
 * Keep the run's credits held until the latest window of its waiting consumptions ends, as `holdUntil` in
 * cost-wait.ts does for a canvas generation.
 * @param taskId - The task, the hold's reference.
 * @param windows - Each waiting consumption's window end, in epoch milliseconds.
 * @param now - The clock, in epoch milliseconds.
 */
async function holdThroughWindows(taskId: string, windows: readonly number[], now: number): Promise<void> {
  if (windows.length === 0) return;
  const { delay, attempts } = pace();
  await creditHoldService.extendHold(taskId, new Date(Math.max(now, ...windows) + delay * 2 ** (attempts - 1)));
}

/**
 * End a model step once: its result, every cost its run handed over and its consumption, in one transaction, the send
 * mark cleared; a second end keeps the first.
 * @param input - The end.
 * @throws {Error} When the task owns no such step or persistence fails.
 */
export async function endMiniToolModelStep(input: EndMiniToolModelStepInput): Promise<void> {
  const costs = z.array(costSchema).parse(input.costs);
  const waits = await db.transaction(async (tx): Promise<{ windows: number[]; now: number } | null> => {
    const { task, step } = await owned(input.taskId, input.stepId, tx);
    if (modelStepEnded(step)) return null;
    const delivered = z.array(costSchema).parse(step.output.deliveredCosts ?? []);
    const nowText = await taskRepo.miniToolSettlementDatabaseNow(task.id, tx);
    const now = Date.parse(nowText);
    const identity = { kind: "provider" as const, stepId: step.id };
    // A model step is the user's call; only container work can be the platform's (frames-split design §5.4).
    const consumption = openedConsumption({
      consumptionKey: await miniToolConsumptionKey({ taskId: task.id, stepId: step.id, identity }), identity,
      chargeTo: "user", creditMultiplier: env.CREDIT_MULTIPLIER,
    }, [...delivered, ...costs], input.servedBy, now);
    await stepRepo.storeStepEnd(task.id, step.id, input.end.kind === "returned" ? "submitted" : "failed", {
      miniToolConsumption: consumption,
      ...(input.end.kind === "returned" ? { providerReturn: { link: input.end.link } } : { modelStepError: { category: input.end.category, ...input.end.error } }),
    }, tx);
    const previous = miniToolSettlementSchema.parse(task.result.settlement ?? {
      version: 0, state: "idle", pendingConsumptionKeys: [], nextAttemptAt: null, leaseToken: null, leaseUntil: null, lastError: null,
    });
    if (previous.state !== "settled") await rewaitSettlement(task, previous, nowText, tx);
    await mirrorMiniToolExecutionConsumption(task, consumption, tx);
    return consumption.state === "pending" ? { windows: [consumption.windowEndsAt!], now } : null;
  });
  if (waits !== null) await holdThroughWindows(input.taskId, waits.windows, waits.now);
}

/**
 * Write back one lookup of a model step's waiting costs under the original lease: each answer, one more attempt and the
 * next due time twice as late; the consumption is known once every waiting cost has an answer, a missing one counting
 * nothing.
 * @param input - The step, the lease and each waiting cost's answer in order.
 * @returns The consumption after the lookup.
 * @throws {Error} When the lease is not current, the answers do not match the waiting costs or persistence fails.
 */
export async function recordMiniToolConsumptionLookup(input: RecordMiniToolConsumptionLookupInput): Promise<MiniToolConsumptionRecord> {
  const request = recordMiniToolConsumptionLookupInputSchema.parse(input);
  const written = await db.transaction(async (tx): Promise<{ consumption: MiniToolConsumptionRecord; now: number }> => {
    const { task, step } = await owned(request.taskId, request.stepId, tx);
    if (!await taskRepo.hasMiniToolSettlementLease(task.id, request.claim, tx)) throw new Error("Mini-tool settlement lease is not current");
    const held = miniToolConsumptionRecordSchema.parse(step.output.miniToolConsumption);
    if (held.identity.kind !== "provider" || held.state !== "pending") return { consumption: held, now: Date.now() };
    const waiting = held.waiting!;
    if (request.costs.length !== waiting.length) throw new Error("Lookup answers differ from the waiting costs");
    const nowText = await taskRepo.miniToolSettlementDatabaseNow(task.id, tx);
    const now = Date.parse(nowText);
    const answered = waiting.map((cost, index) => ({ ...cost, cost: request.costs[index]! }));
    const attempts = held.attempts! + 1;
    const done = answered.every((cost) => cost.cost.state !== "pending");
    const known = held.costs!.reduce((sum, cost) => sum + (cost.state === "known" ? cost.usd : 0), 0)
      + answered.reduce((sum, cost) => sum + (cost.cost.state === "known" ? cost.cost.usd : 0), 0);
    const consumption = miniToolConsumptionRecordSchema.parse({
      ...held, waiting: answered, attempts, known: done ? known : held.known,
      state: done ? "known" : "pending", costUsd: done ? known : null,
      nextLookupAt: done ? null : now + pace().delay * 2 ** attempts,
    });
    await stepRepo.storeMiniToolConsumption(task.id, step.id, consumption, tx);
    await mirrorMiniToolExecutionConsumption(task, consumption, tx);
    // As a container confirmation does, the answer commits only under a lease still current after its writes.
    if (!await taskRepo.hasMiniToolSettlementLease(task.id, request.claim, tx)) throw new Error("Mini-tool settlement lease expired before the lookup was written");
    // A known consumption is recorded next under the same lease; a pending one waits for its next lookup.
    if (!done) await rewaitSettlement(task, miniToolSettlementSchema.parse(task.result.settlement), nowText, tx);
    return { consumption, now };
  });
  if (written.consumption.state === "pending") await holdThroughWindows(request.taskId, [written.consumption.windowEndsAt!], written.now);
  return written.consumption;
}

/**
 * Whether a model step's next lookup is the last the wait allows.
 * @param consumption - The step's pending consumption.
 * @param now - The clock, in epoch milliseconds.
 * @returns True on the last.
 */
export function lastMiniToolConsumptionLookup(consumption: MiniToolConsumptionRecord, now: number): boolean {
  return (consumption.attempts ?? 0) + 1 >= pace().attempts || now >= (consumption.windowEndsAt ?? 0);
}

export type { RecordMiniToolConsumptionLookupInput };
