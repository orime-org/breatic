// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import type { MiniToolExecution } from "@domain/mini-tool/execution.service.js";

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
 * @param _taskId - The immutable original run.
 * @returns Original SQL inputs, public record and internal delivery state.
 * @throws {Error} Until the persistent delivery owner is implemented.
 */
export async function readMiniToolDelivery(_taskId: string): Promise<MiniToolDeliveryContext> {
  throw new Error("Mini-tool delivery owner is not implemented");
}

/**
 * Acknowledge one original registered slot under its current delivery version.
 * @param _taskId - The immutable original run.
 * @param _ack - The original plan, slot, winner and publication disposition.
 * @returns Whether this transaction won, together with the current original context.
 * @throws {Error} Until the persistent delivery owner is implemented.
 */
export async function ackMiniToolDelivery(_taskId: string, _ack: MiniToolDeliveryAck): Promise<MiniToolDeliveryAcknowledgement> {
  throw new Error("Mini-tool delivery owner is not implemented");
}

/**
 * Preserve a stable failure diagnostic only for its current pending delivery version.
 * @param _taskId - The immutable original run.
 * @param _deferral - The version, slot and private stable error code.
 * @returns Nothing.
 * @throws {Error} Until the persistent delivery owner is implemented.
 */
export async function deferMiniToolDelivery(_taskId: string, _deferral: MiniToolDeliveryDeferral): Promise<void> {
  throw new Error("Mini-tool delivery owner is not implemented");
}

/**
 * Discover pending registered media independently of billing and computation deadlines.
 * @param _page - The bounded SQL primary-key page and optional preceding position.
 * @param _page.limit - The positive maximum number of candidates returned.
 * @param _page.cursor - The exact preceding task primary key, when continuing a page.
 * @returns Original task identities, delivery versions and the next exact keyset cursor.
 * @throws {Error} Until the persistent delivery owner is implemented.
 */
export async function listPendingMiniToolDeliveries(_page: { limit: number; cursor?: MiniToolDeliveryCursor }): Promise<PendingMiniToolDeliveryPage> {
  throw new Error("Mini-tool delivery owner is not implemented");
}
