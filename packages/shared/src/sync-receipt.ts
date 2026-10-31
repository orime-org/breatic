// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { z } from "zod";

/** A barrier after earlier Yjs messages on the same content Connection. */
export const SyncConfirmRequestSchema = z.object({
  type: z.literal("sync:confirm"),
  id: z.string().uuid(),
}).strict();

/** Success confirms application to the server document in memory. */
export const SyncConfirmedResponseSchema = z.object({
  type: z.literal("sync:confirmed"),
  id: z.string().uuid(),
  ok: z.boolean(),
}).strict();

export type SyncConfirmRequest = z.infer<typeof SyncConfirmRequestSchema>;
export type SyncConfirmedResponse = z.infer<typeof SyncConfirmedResponseSchema>;
