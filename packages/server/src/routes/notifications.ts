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
 * Spec: breatic-inner/engineering/specs/2026-05-28-access-permission-design.md § 7.
 */

import { Hono } from "hono";
import { requireAuth } from "@server/middleware/auth.js";
import type { AuthVariables } from "@server/middleware/auth.js";
import { notificationService } from "@server/modules";

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

export { route as notificationsRoute };
