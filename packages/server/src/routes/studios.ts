// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Studio routes — the container shell (slice 1).
 *
 * Endpoints, all authenticated:
 *   - `GET /api/v1/studios`            — the current user's studios (switcher).
 *   - `GET /api/v1/studios/recent`     — the cross-studio "Recent" landing feed.
 *   - `GET /api/v1/studio/:slug`       — one studio's public-facing shell.
 *   - `GET /api/v1/studio/:slug/projects` — the studio's projects, filtered
 *     to what the viewer may see (open-baseline visibility, slice 2).
 *
 * The shell is visible to any authenticated user (decision A — a studio's
 * `/studio/{slug}` page is its front door): a non-member gets a `200` with
 * `myStudioRole: null`, NOT a `403`. A slug with no active studio
 * surfaces as `NotFoundError` → `404` via the global error handler.
 *
 * Translation layer only (prohibition #1): map the request to a
 * `studioService` call and wrap the result in the `{ data }` envelope.
 */

import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { createTeamStudioSchema } from "@breatic/shared";
import { requireAuth } from "@server/middleware/auth.js";
import { requireStudioRole } from "@server/middleware/studio-role.js";
import { rateLimit } from "@server/middleware/rate-limit.js";
import type { AuthVariables } from "@server/middleware/auth.js";
import { studioService, projectService, recentService } from "@server/modules";
import * as studioMemberService from "@server/modules/studio/studioMember.service.js";
import * as studioTransferService from "@server/modules/studio/studioTransfer.service.js";
import * as studioInviteService from "@server/modules/studio/studioInvite.service.js";
import { buildStudioInvitationMail } from "@server/modules/studio/studio-invite-mail.js";
import { sendMail } from "@server/infra/mailer.js";
import { logger } from "@breatic/core";

/** Invite body — a registered email + the granted role (never admin). */
const inviteMemberSchema = z.object({
  email: z.string().email(),
  role: z.enum(["maintainer", "guest"]),
});

/** Change-role body — maintainer ↔ guest only. */
const changeRoleSchema = z.object({
  role: z.enum(["maintainer", "guest"]),
});

/** Transfer-admin body — the member proposed as the new studio admin. */
const transferAdminSchema = z.object({
  toUserId: z.string().uuid(),
});

const studios = new Hono<{ Variables: AuthVariables }>();

studios.use(requireAuth);

/**
 * `GET /api/v1/studios` — every studio the current user is an active
 * member of, personal-first (the switcher list).
 * @returns `200` with `{ data: StudioSummary[] }`
 */
studios.get("/", async (c) => {
  const user = c.get("user");
  const data = await studioService.listUserStudios(user.id);
  return c.json({ data });
});

/**
 * `GET /api/v1/studios/recent` — the cross-studio "Recent" landing feed: the
 * projects the current user has opened, newest-first by the user's OWN
 * last-open time, filtered to the ones they can still access (a project they
 * were kicked from / that turned private / was deleted never appears; another
 * user's private project is never leaked). Backs the `/studio` default landing.
 *
 * Mounted on the plural `studios` app (a cross-studio read, alongside the
 * `GET /studios` switcher) — NOT under `/studio/:slug`, so there is no
 * collision with the `:slug` param route.
 * @returns `200` with `{ data: RecentItem[] }`
 */
studios.get("/recent", async (c) => {
  const user = c.get("user");
  const data = await recentService.listRecent(user.id);
  return c.json({ data });
});

/**
 * `GET /api/v1/studios/slug-available?slug=` — live slug availability for the
 * create dialog's debounced indicator (and the personal-studio onboarding slug
 * page). A UX helper only — the authoritative uniqueness guard is the
 * insert-time unique index, so an "available" slug can still lose a concurrent
 * race and surface as `409` on submit. High-frequency, so per-user rate limited.
 * @returns `200` with `{ data: { available: boolean, reason?: string } }`
 */
studios.get(
  "/slug-available",
  rateLimit({ prefix: "slug-check", max: 60, windowSeconds: 60, keyBy: "user" }),
  async (c) => {
    const slug = c.req.query("slug") ?? "";
    const data = await studioService.checkStudioSlug(slug);
    return c.json({ data });
  },
);

/**
 * `POST /api/v1/studios` — create a team studio (display name + globally-unique
 * slug, both hand-typed). The creator becomes its sole admin, atomically. Any
 * authenticated user may create (it is a top-level action, not scoped to an
 * existing studio); per-user rate limited (10/hour) to bound abuse, and capped
 * at a per-user soft limit of active team studios.
 * @returns `201` with `{ data: Studio }`; `409` taken slug / per-user limit
 *   reached, `400` invalid body (zValidator), `429` rate limited
 */
studios.post(
  "/",
  rateLimit({ prefix: "studio-create", max: 10, windowSeconds: 3600, keyBy: "user" }),
  zValidator("json", createTeamStudioSchema),
  async (c) => {
    const user = c.get("user");
    const { name, slug } = c.req.valid("json");
    const data = await studioService.createTeamStudio(user.id, name, slug);
    return c.json({ data }, 201);
  },
);

const studio = new Hono<{ Variables: AuthVariables }>();

studio.use(requireAuth);

/**
 * `GET /api/v1/studio/:slug` — one studio's public-facing shell, with the
 * viewing user's role (`admin` / `maintainer` / `guest` / `null` = non-member).
 * @returns `200` with `{ data: StudioDetail }`; `404` when no active studio
 *   has that slug (service throws `NotFoundError`)
 */
studio.get("/:slug", async (c) => {
  const user = c.get("user");
  const slug = c.req.param("slug");
  const data = await studioService.getStudioDetail(slug, user.id);
  return c.json({ data });
});

/**
 * `GET /api/v1/studio/:slug/projects` — the studio's projects visible to the
 * viewer (open-baseline visibility, slice 2).
 *
 * Server-side filtered (`projectService.listByStudioSlug`): a studio member
 * sees studio-visible projects + their own private ones; an admin sees all;
 * a non-member gets `[]` (the non-member shell shows no projects). A slug with no
 * active studio surfaces as `404`.
 * @returns `200` with `{ data: ProjectSummary[] }`
 */
studio.get("/:slug/projects", async (c) => {
  const user = c.get("user");
  const slug = c.req.param("slug");
  const data = await projectService.listByStudioSlug(slug, user.id);
  return c.json({ data });
});

/**
 * `GET /api/v1/studio/:slug/members` — the studio's active members for the
 * Members tab (display name / email / role / join date). Visible to any
 * authenticated user (decision A); a non-member's tab never calls it. A
 * personal studio returns exactly its owner.
 * @returns `200` with `{ data: StudioMemberSummary[] }`; `404` when no active
 *   studio has that slug (service throws `NotFoundError`)
 */
studio.get("/:slug/members", async (c) => {
  const user = c.get("user");
  const slug = c.req.param("slug");
  const data = await studioService.getStudioMembers(slug, user.id);
  return c.json({ data });
});

/**
 * `POST /api/v1/studio/:slug/members` — invite a registered user (by email) to
 * the studio. Admin-only; creates a PENDING invite + an actionable bell
 * notification, and (best-effort) sends an email link. The invitee becomes a
 * member only on confirm (invite-confirm handshake, 2026-06-14).
 * @returns `201` with `{ data: { ok: true } }`; `404` unregistered email,
 *   `403` personal studio / caller not admin, `409` already a member or already
 *   invited
 */
studio.post("/:slug/members", requireStudioRole("admin"), async (c) => {
  const user = c.get("user");
  const slug = c.req.param("slug");
  const body = inviteMemberSchema.parse(await c.req.json());
  const invite = await studioInviteService.createInvite(
    slug,
    user.id,
    body.email,
    body.role,
  );
  // Email is an OPTIONAL enhancement — the bell notification is the always-
  // delivered path. A send failure must NOT fail the request (the invite + bell
  // already landed); best-effort, logged at the application boundary.
  try {
    const token = await studioInviteService.issueInviteToken(invite.invitationId);
    const origin = c.req.header("Origin") ?? "http://localhost:8000";
    const mailResult = await sendMail(
      buildStudioInvitationMail({
        inviteeEmail: invite.inviteeEmail,
        inviterName: invite.inviterName,
        studioName: invite.studioName,
        role: invite.role,
        inviteLink: `${origin}/studio-invite?token=${token}`,
      }),
    );
    logger.info({ slug, mailStatus: mailResult.status }, "studio_invite_email");
  } catch (err) {
    logger.error({ err, slug }, "studio_invite_email_failed");
  }
  return c.json({ data: { ok: true } }, 201);
});

/**
 * `DELETE /api/v1/studio/:slug/members/:userId` — remove (kick) a member.
 * Admin-only; clears the member's access across all the studio's projects and
 * transfers their owned projects to the acting admin, in one transaction.
 * @returns `200` with `{ data: { ok: true } }`; `403` personal / not admin,
 *   `404` not a member, `409` the sole admin (transfer first)
 */
studio.delete("/:slug/members/:userId", requireStudioRole("admin"), async (c) => {
  const user = c.get("user");
  const slug = c.req.param("slug");
  const targetUserId = c.req.param("userId");
  await studioMemberService.removeMember(slug, targetUserId, user.id);
  return c.json({ data: { ok: true } });
});

/**
 * `PATCH /api/v1/studio/:slug/members/:userId` — change a member's role
 * (maintainer ↔ guest). Admin-only; admin grant/demote goes through
 * transfer-admin, not here.
 * @returns `200` with `{ data: { ok: true } }`; `403` personal / not admin,
 *   `404` not a member, `409` target is the admin (demote via transfer)
 */
studio.patch("/:slug/members/:userId", requireStudioRole("admin"), async (c) => {
  const slug = c.req.param("slug");
  const targetUserId = c.req.param("userId");
  const body = changeRoleSchema.parse(await c.req.json());
  await studioMemberService.updateMemberRole(slug, targetUserId, body.role);
  return c.json({ data: { ok: true } });
});

/**
 * `POST /api/v1/studio/:slug/transfer-admin` — the admin asks an existing
 * member to take over as admin (step 1 of the two-step handshake). Admin-only;
 * drops an actionable `studio.transfer_request` notification (confirm/cancel,
 * 7-day TTL) in the recipient's inbox. No role change yet — that lands when the
 * recipient confirms via the notification action endpoint.
 * @returns `201` with `{ data: { ok: true } }`; `403` personal / not admin,
 *   `404` recipient not a member, `422` recipient is the acting admin
 */
studio.post("/:slug/transfer-admin", requireStudioRole("admin"), async (c) => {
  const user = c.get("user");
  const slug = c.req.param("slug");
  const body = transferAdminSchema.parse(await c.req.json());
  await studioTransferService.requestTransfer(slug, user.id, body.toUserId);
  return c.json({ data: { ok: true } }, 201);
});

/**
 * `DELETE /api/v1/studio/:slug/invitations/:invitationId` — the admin revokes a
 * pending invite. Admin-only; flips it to `revoked` and clears the invitee's
 * bell notification.
 * @returns `200` with `{ data: { ok: true } }`; `403` personal / not admin,
 *   `404` studio not found or no matching pending invite
 */
studio.delete(
  "/:slug/invitations/:invitationId",
  requireStudioRole("admin"),
  async (c) => {
    const slug = c.req.param("slug");
    const invitationId = c.req.param("invitationId");
    await studioInviteService.revokeInvite(slug, invitationId);
    return c.json({ data: { ok: true } });
  },
);

export { studios as studiosRoute, studio as studioRoute };
