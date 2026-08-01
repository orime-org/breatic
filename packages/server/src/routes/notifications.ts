// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Notifications routes — per-user BellMenu inbox.
 *
 * Mounted under `/api/v1/users/me/notifications` (auth-only; caller
 * pulls their own inbox + flips read state).
 *
 * Endpoints:
 *   - GET ?unread=true|false — list (defaults to unread)
 *   - GET /count             — unread count for the red-dot badge
 *   - PATCH /:id/read        — mark a single notification read
 *   - POST /read-all         — mark every unread notification read
 *
 * The frontend pulls these via React Query; the collab stateless
 * invalidate signal (Phase 7) triggers refetch (~150ms total delay).
 *
 * Spec: access-permission design (2026-05-28) § 7.
 */

import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { NotFoundError } from "@breatic/core";
import { t } from "@breatic/shared";
import { requireAuth } from "@server/middleware/auth.js";
import type { AuthVariables } from "@server/middleware/auth.js";
import { notificationService } from "@server/modules";
import { withResolvedRefs } from "@server/modules/notification/notification-refs.js";
import * as studioTransferService from "@server/modules/studio/studioTransfer.service.js";
import * as studioInviteService from "@server/modules/studio/studioInvite.service.js";
import * as projectTransferService from "@server/modules/project/projectTransfer.service.js";

/** Action body — confirm or cancel an actionable notification. */
const actionSchema = z.object({
  action: z.enum(["confirm", "cancel"]),
});

const route = new Hono<{ Variables: AuthVariables }>();

route.use(requireAuth);

/**
 * `GET /api/v1/users/me/notifications` — list notifications for the
 * authenticated caller.
 *
 * Query param `unread=true` (default) returns only unread items;
 * `unread=false` returns the full history.
 */
route.get("/", async (c) => {
  const user = c.get("user");
  const unreadOnly = c.req.query("unread") !== "false";
  const list = unreadOnly
    ? await notificationService.listUnread(user.id)
    : await notificationService.listAll(user.id);
  // Notifications store ids; the names they display are resolved here, at read
  // time, so a renamed studio or a changed @handle never leaves an old entry
  // pointing somewhere wrong. `resolved` sits INSIDE `data` because the
  // frontend's request helper unwraps the envelope and drops anything beside it.
  const data = await withResolvedRefs(list);
  return c.json({ data });
});

/**
 * `GET /api/v1/users/me/notifications/count` — unread count for the
 * red-dot badge. Cheap COUNT query backed by the partial index.
 */
route.get("/count", async (c) => {
  const user = c.get("user");
  const count = await notificationService.countUnread(user.id);
  return c.json({ data: { count } });
});

/**
 * `PATCH /api/v1/users/me/notifications/:id/read` — mark a single
 * notification as read.
 *
 * The service throws NotFoundError if the notification doesn't exist,
 * is already read, or belongs to a different user — all collapse to a
 * 404 response (defense in depth on top of the userId scope).
 */
// `:id` reaches a uuid comparison, and this is the confirm / decline entry
// point for both transfer flows — the half that the per-request withdraw
// routes' guard does not cover.
const notificationParamSchema = z.object({ id: z.string().uuid() });

route.patch(
  "/:id/read",
  zValidator("param", notificationParamSchema),
  async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  await notificationService.markRead(id, user.id);
  return c.json({ data: { ok: true } });  },
);

/**
 * `POST /api/v1/users/me/notifications/read-all` — mark every unread
 * notification as read. Idempotent — returns the count of rows
 * updated.
 */
route.post("/read-all", async (c) => {
  const user = c.get("user");
  const count = await notificationService.markAllRead(user.id);
  return c.json({ data: { count } });
});

/**
 * `POST /api/v1/users/me/notifications/:id/action` — act on an actionable
 * notification (confirm / cancel). Dispatches by the notification's `type`:
 * `studio.transfer_request` routes to the transfer-admin handshake. The
 * caller must own the notification (the service's markRead userId guard);
 * a missing / already-decided / other-user's notification collapses to 404.
 */
/**
 * Read the id of the row an actionable bell entry stands for.
 *
 * These entries never carry the state they display — the invite or offer is a
 * row of its own, and the entry only points at it. A payload missing that
 * pointer is an entry nothing can act on, which is indistinguishable from a
 * missing one as far as the caller is concerned.
 * @param payload - The notification's opaque jsonb payload
 * @param key - Which pointer to read (`invitationId` / `transferId`)
 * @returns The row id
 * @throws {NotFoundError} when the payload carries no such pointer
 */
function readRowId(payload: unknown, key: string): string {
  const value = (payload as Record<string, unknown> | null)?.[key];
  if (typeof value !== "string") {
    throw new NotFoundError(t("server.error.not_found"));
  }
  return value;
}

route.post(
  "/:id/action",
  zValidator("param", notificationParamSchema),
  async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  const body = actionSchema.parse(await c.req.json());
  const notification = await notificationService.getById(id);
  if (!notification || notification.userId !== user.id) {
    throw new NotFoundError(t("server.error.not_found"));
  }
  switch (notification.type) {
    case "studio.transfer_request": {
      // Like the invite below: the offer's source of truth is the
      // `studio_transfers` row whose id rides in the payload, not this entry.
      const transferId = readRowId(notification.payload, "transferId");
      if (body.action === "confirm") {
        await studioTransferService.confirmTransfer(transferId, user.id);
      } else {
        await studioTransferService.declineTransfer(transferId, user.id);
      }
      break;
    }
    case "project.transfer_request": {
      const transferId = readRowId(notification.payload, "transferId");
      if (body.action === "confirm") {
        await projectTransferService.confirmProjectTransfer(
          transferId,
          user.id,
        );
      } else {
        await projectTransferService.declineProjectTransfer(
          transferId,
          user.id,
        );
      }
      break;
    }
    case "studio.invite_request": {
      // The invite's source of truth is the studio_invitations row whose id
      // rides in the notification payload (the notification is just the entry
      // point); confirm/decline act on that invitation.
      const invitationId = readRowId(notification.payload, "invitationId");
      if (body.action === "confirm") {
        await studioInviteService.confirmInvite(invitationId, user.id);
      } else {
        await studioInviteService.declineInvite(invitationId, user.id);
      }
      break;
    }
    // NOTE: `project.invite_request` is intentionally NOT actionable here. Unlike
    // studio (which confirms inline in the bell), the project bell row links OUT
    // to the `/project-invite?token=` landing page where confirm/decline happen,
    // so it never reaches this dispatch — it collapses to the `default` 404.
    default:
      // Not an actionable type — nothing to confirm/cancel.
      throw new NotFoundError(t("server.error.not_found"));
  }
  return c.json({ data: { ok: true } });  },
);

export { route as notificationsRoute };
