// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Comment requests (breatic#1488 §11.9): the browser sends these on a Space
 * document's own connection after the provider's send window, so collab has
 * applied the edit they follow when it handles them. Collab writes the
 * record and its notification while it handles the request and answers on
 * the same connection. Also the per-user signal collab sends a member's
 * project pages when their notifications changed.
 */

import { z } from "zod";

/** A request id: the browser makes it, the answer echoes it. */
const RequestIdSchema = z.string().min(1).max(64);

/** A thread or entry id, as the editors make them. */
const CommentIdSchema = z.string().min(1).max(64);

export const CommentRequestSchema = z.discriminatedUnion("type", [
  z.object({
    id: RequestIdSchema,
    type: z.literal("comment:hand-over"),
    payload: z.object({ spaceId: z.uuid(), threadId: CommentIdSchema, connectionId: z.uuid() }),
  }),
  z.object({
    id: RequestIdSchema,
    type: z.literal("comment:cancel-hand-over"),
    payload: z.object({ spaceId: z.uuid(), threadId: CommentIdSchema }),
  }),
  z.object({
    id: RequestIdSchema,
    type: z.literal("comment:mentioned"),
    payload: z.object({ spaceId: z.uuid(), entryId: CommentIdSchema }),
  }),
]);
export type CommentRequest = z.infer<typeof CommentRequestSchema>;

/**
 * Why collab refused a request: `FORBIDDEN` the caller may not; `NOT_FOUND`
 * the thread, entry, record or Space is gone; `CONFLICT` the thread is
 * resolved; `BUSY` another Space change holds the lock; `INTERNAL` our side
 * failed.
 */
export const CommentRequestErrorCodeSchema = z.enum(["FORBIDDEN", "NOT_FOUND", "CONFLICT", "BUSY", "INTERNAL"]);
export type CommentRequestErrorCode = z.infer<typeof CommentRequestErrorCodeSchema>;

export const CommentResponseSchema = z.discriminatedUnion("ok", [
  z.object({ id: RequestIdSchema, ok: z.literal(true) }),
  z.object({ id: RequestIdSchema, ok: z.literal(false), error: z.object({ code: CommentRequestErrorCodeSchema, message: z.string() }) }),
]);
export type CommentResponse = z.infer<typeof CommentResponseSchema>;

/** The stateless signal on a member's meta connections: their notifications changed. */
export const NOTIFICATIONS_CHANGED_SIGNAL = "notifications:changed" as const;

export const NotificationsChangedSignalSchema = z.object({ t: z.literal(NOTIFICATIONS_CHANGED_SIGNAL) });
export type NotificationsChangedSignal = z.infer<typeof NotificationsChangedSignalSchema>;

/** Control event telling every collab instance which users' notifications changed. */
export interface NotificationsChangedControlEvent {
  type: "notifications:changed";
  userIds: string[];
  ts: number;
}

/**
 * The deployment-wide channel of {@link NotificationsChangedControlEvent}:
 * one member's project pages may sit on any instance, in any project.
 * @param prefix - Deployment namespace (`REDIS_KEY_PREFIX`).
 * @returns The channel name `{prefix}:notifications:changed`.
 */
export function notificationsChangedChannel(prefix: string): string {
  return `${prefix}:notifications:changed`;
}
