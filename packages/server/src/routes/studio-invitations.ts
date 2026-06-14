// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Studio invitation email-link routes — the `/studio-invite` landing page uses
 * these to show an invite and confirm/decline it (invite-confirm handshake,
 * 2026-06-14).
 *
 * Both auth-only: the invitee must be logged in. The one-time token resolves
 * the invite; the CAS guard inside the service ties confirm/decline to the
 * invitee, so a forwarded link cannot be acted on by someone else.
 *
 * Mounted at `/api/v1/studio-invitations`. Translation layer only
 * (prohibition #1): map the request to a `studioInviteService` call.
 */

import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { NotFoundError } from "@breatic/core";
import { t } from "@breatic/shared";
import { requireAuth } from "@server/middleware/auth.js";
import type { AuthVariables } from "@server/middleware/auth.js";
import * as studioInviteService from "@server/modules/studio/studioInvite.service.js";

/** Respond body — confirm (accept) or decline the invite, by its link token. */
const respondSchema = z.object({
  token: z.string().min(1),
  action: z.enum(["confirm", "decline"]),
});

const route = new Hono<{ Variables: AuthVariables }>();

route.use(requireAuth);

/**
 * `GET /api/v1/studio-invitations/:token` — the landing-page view for an invite
 * link (studio + inviter names, role, `expired`, `isInvitee`). Does NOT consume
 * the token (the invitee reads it before acting).
 * @returns `200` with `{ data: InvitationLandingView }`; `404` when the token /
 *   invite is gone (expired link or already decided)
 */
route.get("/:token", async (c) => {
  const user = c.get("user");
  const token = c.req.param("token");
  const data = await studioInviteService.getInviteForLanding(token, user.id);
  if (!data) {
    throw new NotFoundError(t("server.error.not_found"));
  }
  return c.json({ data });
});

/**
 * `POST /api/v1/studio-invitations/respond` — confirm or decline an invite from
 * the email link; consumes the one-time token. Returns the studio slug for the
 * post-confirm redirect.
 * @returns `200` with `{ data: { studioSlug } }`; `404` token / invite gone,
 *   already decided, expired, or the caller is not the invitee
 */
route.post("/respond", zValidator("json", respondSchema), async (c) => {
  const user = c.get("user");
  const { token, action } = c.req.valid("json");
  const data = await studioInviteService.respondToInvite(token, action, user.id);
  return c.json({ data });
});

export { route as studioInvitationsRoute };
