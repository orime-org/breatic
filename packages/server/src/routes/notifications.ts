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
import { z } from "zod";
import { NotFoundError } from "@breatic/core";
import { t } from "@breatic/shared";
import { requireAuth } from "@server/middleware/auth.js";
import type { AuthVariables } from "@server/middleware/auth.js";
import { notificationService } from "@server/modules";
import * as studioTransferService from "@server/modules/studio/studioTransfer.service.js";
import * as studioInviteService from "@server/modules/studio/studioInvite.service.js";

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
  return c.json({ data: list });
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
route.patch("/:id/read", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  await notificationService.markRead(id, user.id);
  return c.json({ data: { ok: true } });
});

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
route.post("/:id/action", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  const body = actionSchema.parse(await c.req.json());
  const notification = await notificationService.getById(id);
  if (!notification || notification.userId !== user.id) {
    throw new NotFoundError(t("server.error.not_found"));
  }
  switch (notification.type) {
    case "studio.transfer_request":
      if (body.action === "confirm") {
        await studioTransferService.confirmTransfer(id, user.id);
      } else {
        await studioTransferService.cancelTransfer(id, user.id);
      }
      break;
    case "studio.invite_request": {
      // The invite's source of truth is the studio_invitations row whose id
      // rides in the notification payload (the notification is just the entry
      // point); confirm/decline act on that invitation.
      const payload = notification.payload as { invitationId?: unknown };
      if (typeof payload.invitationId !== "string") {
        throw new NotFoundError(t("server.error.not_found"));
      }
      if (body.action === "confirm") {
        await studioInviteService.confirmInvite(payload.invitationId, user.id);
      } else {
        await studioInviteService.declineInvite(payload.invitationId, user.id);
      }
      break;
    }
    default:
      // Not an actionable type — nothing to confirm/cancel.
      throw new NotFoundError(t("server.error.not_found"));
  }
  return c.json({ data: { ok: true } });
});

export { route as notificationsRoute };
