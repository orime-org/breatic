// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/** Stable Project visit request and historical receipt protocol. */
import { z } from "zod";

/** A page entry supplies its own identity; legacy callers may omit it. */
export const projectVisitRequestSchema = z.object({ visit_id: z.uuid().optional() });
/** Original server receipt, retaining the SQL timestamp's microseconds. */
export const projectVisitReceiptSchema = z.object({
  account_id: z.uuid(),
  visit_id: z.uuid(),
  project_id: z.uuid(),
  occurred_at: z.iso.datetime({ offset: true }),
});
/** POST keeps its established success flag alongside the original receipt. */
export const projectVisitOpenedSchema = projectVisitReceiptSchema.extend({ ok: z.literal(true) });
/** Lookup confirms only the requesting account's original Project binding. */
export const projectVisitLookupSchema = z.discriminatedUnion("status", [
  projectVisitReceiptSchema.extend({ status: z.literal("recorded") }),
  projectVisitReceiptSchema.omit({ occurred_at: true }).extend({ status: z.literal("unconfirmed") }),
]);
export type ProjectVisitRequest = z.infer<typeof projectVisitRequestSchema>;
export type ProjectVisitReceipt = z.infer<typeof projectVisitReceiptSchema>;
export type ProjectVisitOpened = z.infer<typeof projectVisitOpenedSchema>;
export type ProjectVisitLookup = z.infer<typeof projectVisitLookupSchema>;
