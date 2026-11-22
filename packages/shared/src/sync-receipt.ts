// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from "zod";

import type { DocKind } from "@shared/yjs-doc-names.js";

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

/**
 * Content documents whose unsynced edits the page counts before it lets the user leave. A Motion Space's document holds
 * only its annotations, which the page waits for like a Document's comments.
 */
const CONFIRMING: ReadonlySet<DocKind> = new Set<DocKind>(["canvas", "document", "web_animation"]);

/**
 * Whether a document of this kind takes a sync confirmation: the page sends one and collab answers it (#1490 design §3.3).
 * @param kind - The document's kind.
 * @returns True for canvas, Document and Motion content documents.
 * @throws {never} Never.
 */
export function confirmsSync(kind: DocKind): boolean {
  return CONFIRMING.has(kind);
}
