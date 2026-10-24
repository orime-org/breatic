// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { z } from "zod";
import { NativeEditRecordSchema, type NativeEditRecord } from "@shared/timeline/schema.js";

/** A persistence request scoped exclusively by its authenticated connection. */
export interface TimelinePersistenceRequest {
  version: 1;
  id: string;
  type: "timeline:persistence:query" | "timeline:persistence:retry";
  payload: { actionIds: string[] };
}

/** The result of one attempted store, distinct from record inclusion. */
export type TimelineStoreAttempt = "stored" | "refused" | "deferred" | "gone";

/** A typed result carrying the exact records decoded from persisted bytes. */
export type TimelinePersistenceResponse = {
  version: 1;
  id: string;
  type: "timeline:persistence:result";
} & ({ ok: true; result: { documentVersion: 1; persistedRecords: NativeEditRecord[]; missingActionIds: string[]; attempt?: TimelineStoreAttempt } }
  | { ok: false; error: { code: "FORBIDDEN" | "NOT_FOUND" | "INVALID_INPUT" | "UNSUPPORTED_DOCUMENT" | "INTERNAL"; message: string } });

const requestId = z.string().min(1).max(64);
const actionIds = z.array(z.uuid()).max(128);

/** Only a content connection can supply this request's target identity. */
export const TimelinePersistenceRequestSchema: z.ZodType<TimelinePersistenceRequest> = z.object({
  version: z.literal(1),
  id: requestId,
  type: z.enum(["timeline:persistence:query", "timeline:persistence:retry"]),
  payload: z.object({ actionIds: actionIds.transform((ids) => [...new Set(ids)]) }).strict(),
}).strict();

const responseBase = z.object({ version: z.literal(1), id: requestId, type: z.literal("timeline:persistence:result") });

/** A store attempt and persisted record inclusion remain separate facts. */
export const TimelinePersistenceResponseSchema: z.ZodType<TimelinePersistenceResponse> = z.discriminatedUnion("ok", [
  responseBase.extend({
    ok: z.literal(true),
    result: z.object({
      documentVersion: z.literal(1),
      persistedRecords: z.array(NativeEditRecordSchema).max(128),
      missingActionIds: actionIds,
      attempt: z.enum(["stored", "refused", "deferred", "gone"]).optional(),
    }).strict(),
  }).strict(),
  responseBase.extend({
    ok: z.literal(false),
    error: z.object({
      code: z.enum(["FORBIDDEN", "NOT_FOUND", "INVALID_INPUT", "UNSUPPORTED_DOCUMENT", "INTERNAL"]),
      message: z.string().min(1).max(512),
    }).strict(),
  }).strict(),
]);

/**
 * Compare complete normalized immutable edit records.
 * @param left - The locally accepted record.
 * @param right - The record read from actual persisted bytes.
 * @returns Whether both values name exactly the same accepted effect.
 * @throws {never} Never.
 */
export function sameNativeEditRecord(left: unknown, right: unknown): boolean {
  const a = NativeEditRecordSchema.safeParse(left);
  const b = NativeEditRecordSchema.safeParse(right);
  return a.success && b.success && JSON.stringify(a.data) === JSON.stringify(b.data);
}
