// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import type { MiniToolExecution } from "@domain/mini-tool/execution.service.js";
import { z } from "zod";
import { db, NotFoundError, type DbTx } from "@breatic/core";
import { t } from "@breatic/shared";
import { recordFromPlan } from "@domain/mini-tool/execution.service.js";
import { executionPlanFromTask } from "@domain/mini-tool/execution-plan.service.js";
import { synchronizeMiniToolDelivery } from "@domain/mini-tool/delivery-state.js";
import * as taskRepo from "@domain/task/task.repo.js";

/** One original registered slot, independent of computation and financial versions. */
export interface MiniToolDeliveryOutput {
  outputIndex: number;
  state: "pending" | "published" | "history_only";
}
/** Internal durable delivery metadata, never a public execution projection. */
export interface MiniToolDeliveryState {
  schemaVersion: 1;
  planFingerprint: string;
  version: number;
  outputs: MiniToolDeliveryOutput[];
  lastErrorCode: string | null;
}
/** Original frozen inputs and public manifest with their independent delivery sibling. */
export interface MiniToolDeliveryContext extends MiniToolExecution { delivery: MiniToolDeliveryState | null }
/** An acknowledgement is bound to the current delivery version and original registered winner. */
export interface MiniToolDeliveryAck {
  deliveryVersion: number;
  planFingerprint: string;
  outputIndex: number;
  assetId: string;
  disposition: "published" | "history_only";
}
/** Whether this call won the versioned acknowledgement, plus current original context. */
export interface MiniToolDeliveryAcknowledgement extends MiniToolDeliveryContext { acknowledged: boolean }
/** A stable application-stage diagnostic cannot change a successor delivery version. */
export interface MiniToolDeliveryDeferral { deliveryVersion: number; outputIndex: number; errorCode: string }
/** SQL task primary keys retain their exact keyset position. */
export interface MiniToolDeliveryCursor { taskId: string }
/** A discoverable original run and its current delivery version. */
export interface PendingMiniToolDelivery { taskId: string; deliveryVersion: number }
/** One bounded keyset page; its cursor is independent of time and fee state. */
export interface PendingMiniToolDeliveryPage { items: PendingMiniToolDelivery[]; nextCursor: MiniToolDeliveryCursor | null }

/**
 * Read original planned context and initialize an absent delivery sibling under its task lock.
 * @param taskId - The immutable original run.
 * @returns Original SQL inputs, public record and internal delivery state.
 * @throws {Error} When original context, manifest validation or persistence fails.
 */
export async function readMiniToolDelivery(taskId: string): Promise<MiniToolDeliveryContext> {
  const id = z.uuid().parse(taskId);
  return db.transaction((tx) => lockedDelivery(id, tx));
}

/**
 * Acknowledge one original registered slot under its current delivery version.
 * @param taskId - The immutable original run.
 * @param ack - The original plan, slot, winner and publication disposition.
 * @returns Whether this transaction won, together with the current original context.
 * @throws {Error} When original context, manifest validation or persistence fails.
 */
export async function ackMiniToolDelivery(taskId: string, ack: MiniToolDeliveryAck): Promise<MiniToolDeliveryAcknowledgement> {
  const id = z.uuid().parse(taskId);
  const input = z.strictObject({
    deliveryVersion: z.number().int().nonnegative(), planFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    outputIndex: z.number().int().nonnegative(), assetId: z.uuid(), disposition: z.enum(["published", "history_only"]),
  }).parse(ack);
  return db.transaction(async (tx) => {
    const context = await lockedDelivery(id, tx);
    const { delivery, record } = context;
    const slot = record.outputs.find((output) => output.outputIndex === input.outputIndex);
    if (delivery === null || delivery.version !== input.deliveryVersion || input.planFingerprint !== delivery.planFingerprint
      || slot?.result?.status !== "registered" || slot.result.assetId !== input.assetId
      || !delivery.outputs.some((output) => output.outputIndex === input.outputIndex && output.state === "pending")) {
      return { ...context, acknowledged: false };
    }
    const next: MiniToolDeliveryState = {
      ...delivery, version: delivery.version + 1, lastErrorCode: null,
      outputs: delivery.outputs.map((output) => output.outputIndex === input.outputIndex ? { ...output, state: input.disposition } : output),
    };
    await taskRepo.storeMiniToolDelivery(id, next, tx);
    return { ...context, task: await deliveryTask(id, tx), delivery: next, acknowledged: true };
  });
}

/**
 * Preserve a stable failure diagnostic only for its current pending delivery version.
 * @param taskId - The immutable original run.
 * @param deferral - The version, slot and private stable error code.
 * @returns Nothing.
 * @throws {Error} When original context, manifest validation or persistence fails.
 */
export async function deferMiniToolDelivery(taskId: string, deferral: MiniToolDeliveryDeferral): Promise<void> {
  const id = z.uuid().parse(taskId);
  const input = z.strictObject({
    deliveryVersion: z.number().int().nonnegative(), outputIndex: z.number().int().nonnegative(),
    errorCode: z.string().regex(/^[a-z][a-z0-9_]*$/),
  }).parse(deferral);
  await db.transaction(async (tx) => {
    const { delivery } = await lockedDelivery(id, tx);
    if (delivery === null || delivery.version !== input.deliveryVersion || delivery.lastErrorCode === input.errorCode
      || !delivery.outputs.some((output) => output.outputIndex === input.outputIndex && output.state === "pending")) return;
    await taskRepo.storeMiniToolDelivery(id, { ...delivery, lastErrorCode: input.errorCode }, tx);
  });
}

/**
 * Discover pending registered media independently of billing and computation deadlines.
 * @param page - The bounded SQL primary-key page and optional preceding position.
 * @param page.limit - The positive maximum number of candidates returned.
 * @param page.cursor - The exact preceding task primary key, when continuing a page.
 * @returns Original task identities, delivery versions and the next exact keyset cursor.
 * @throws {Error} When original context, manifest validation or persistence fails.
 */
export async function listPendingMiniToolDeliveries(page: { limit: number; cursor?: MiniToolDeliveryCursor }): Promise<PendingMiniToolDeliveryPage> {
  const input = z.strictObject({ limit: z.number().int().positive(), cursor: z.strictObject({ taskId: z.uuid() }).optional() }).parse(page);
  const candidates = await taskRepo.listMiniToolDeliveryCandidates(input.limit + 1, input.cursor);
  const scanned = candidates.slice(0, input.limit);
  const items: PendingMiniToolDelivery[] = [];
  for (const taskId of scanned) {
    const { delivery } = await readMiniToolDelivery(taskId);
    if (delivery?.outputs.some((output) => output.state === "pending")) items.push({ taskId, deliveryVersion: delivery.version });
  }
  const last = scanned.at(-1);
  return { items, nextCursor: candidates.length > input.limit && last !== undefined ? { taskId: last } : null };
}

/**
 * Read and validate delivery facts under the same immutable parent lock as computation.
 * @param id - The validated original task identity.
 * @param tx - The short transaction retaining that task's row lock.
 * @returns Current frozen inputs, public manifest and initialized delivery sibling.
 * @throws {Error} When original context validation or persistence fails.
 */
async function lockedDelivery(id: string, tx: DbTx): Promise<MiniToolDeliveryContext> {
  const task = await taskRepo.lockMiniToolExecutionTask(id, tx);
  if (task === null) throw new NotFoundError(t("server.error.not_found"));
  const plan = await executionPlanFromTask(task);
  const record = recordFromPlan(plan);
  const delivery = await synchronizeMiniToolDelivery(task, record, tx);
  return { ...plan, task: await deliveryTask(id, tx), record, delivery };
}

/**
 * Return the physical task after a delivery sibling may have been written.
 * @param id - The original immutable task.
 * @param tx - The transaction already retaining its parent lock.
 * @returns Its current parent without synthesizing a replacement result.
 * @throws {Error} When the parent disappeared or the SQL read fails.
 */
async function deliveryTask(id: string, tx: DbTx): Promise<MiniToolExecution["task"]> {
  const task = await taskRepo.getMiniToolExecutionTask(id, tx);
  if (task === null) throw new Error("Delivery task no longer exists");
  return task;
}
