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
import { validate } from "@server/middleware/validate.js";
import { t } from "@breatic/shared";
import { createTeamStudioSchema, updateStudioSchema } from "@breatic/shared";
import { creditPageQuerySchema } from "@server/routes/schemas.js";
import { requireAuth } from "@server/middleware/auth.js";
import { requireStudioRole } from "@server/middleware/studio-role.js";
import { rateLimitFor } from "@server/middleware/rate-limit.js";
import type { AuthVariables } from "@server/middleware/auth.js";
import {
  studioService,
  projectService,
  recentService,
  creditViewService,
} from "@server/modules";
import { getStorageConfig, NotFoundError, ValidationError } from "@breatic/core";
import { readBoundedBody } from "@server/utils/read-bounded-body.js";
import * as studioMemberService from "@server/modules/studio/studioMember.service.js";
import * as studioAvatarService from "@server/modules/studio/studioAvatar.service.js";
import * as studioTransferService from "@server/modules/studio/studioTransfer.service.js";
import * as studioInviteService from "@server/modules/studio/studioInvite.service.js";

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
  rateLimitFor("slug-check", "user"),
  async (c) => {
    const slug = c.req.query("slug") ?? "";
    // `excludeStudioId` lets a caller ask "ignoring this studio's own claim,
    // is the slug free" — the question a rename form has. Passing an id here
    // leaks nothing: the answer is about the slug, not about that studio.
    //
    // Validated rather than passed through, because it reaches the query as a
    // uuid comparison and anything that is not a uuid makes Postgres reject
    // the statement — a user-supplied string turning into a 500.
    //
    // No client sends it today: the web rename form knows its own slug and
    // short-circuits locally instead of asking. It stays because it is the
    // endpoint's honest contract, and it is covered by tests.
    const excludeStudioId = c.req.query("excludeStudioId");
    if (
      excludeStudioId !== undefined &&
      !z.string().uuid().safeParse(excludeStudioId).success
    ) {
      throw new ValidationError(t("server.error.validation"));
    }
    const data = await studioService.checkStudioSlug(slug, excludeStudioId);
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
 *   reached, `422` invalid body, `429` rate limited
 */
studios.post(
  "/",
  rateLimitFor("studio-create", "user"),
  validate("json", createTeamStudioSchema),
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
 * `PATCH /api/v1/studio/:slug` — edit the studio's display name, URL slug,
 * and/or bio. Admin-only; every field is optional so the settings form sends
 * only what changed, and an entirely empty patch is a `422` rather than a
 * successful no-op.
 *
 * Changing the slug frees the old one immediately — no redirect, no alias
 * (rule 7) — so every existing link to the old address breaks. The frontend
 * puts this behind a confirmation dialog; the API simply applies it. Personal
 * studios are editable: their name, handle and bio are the owner's own
 * profile.
 *
 * Rate limited per user: a rename churns every link to the studio, and the
 * slug-availability probe next to it is already limited.
 * @returns `200` with `{ data: Studio }`; `422` invalid or empty patch,
 *   `403` not the admin, `404` no such studio, `409` slug taken,
 *   `429` rate limited
 */
studio.patch(
  "/:slug",
  requireStudioRole("admin"),
  rateLimitFor("studio-update", "user"),
  validate("json", updateStudioSchema),
  async (c) => {
    const slug = c.req.param("slug");
    const data = await studioService.updateStudio(slug, c.req.valid("json"));
    return c.json({ data });
  },
);

/**
 * `POST /api/v1/studio/:slug/avatar` — upload the studio's avatar. Admin-only.
 *
 * The body is the image bytes themselves, not a multipart envelope. Multipart
 * would be a wrapper around a single file with no other fields, and its
 * envelope bytes (`--boundary…`) are what the sniffer would see — every valid
 * upload would be refused as "not an image" unless we first parsed the whole
 * body in memory or took on a streaming parser dependency the repo does not
 * have. One file, no envelope.
 *
 * The `Content-Type` header is ignored: the type is sniffed from the bytes,
 * because the header is the client's claim about content the client chose.
 *
 * Rate limited — every call permanently adds a storage object that runtime
 * never deletes, so an unthrottled admin could write to storage without bound.
 * The picture itself is not inspected. Two things happen to the bytes: they
 * are bounded, and their signature is read to decide the extension and content
 * type the stored object is served under. Bytes whose signature is not PNG
 * have nothing to be stored as and are refused — that is the whitelist holding
 * one entry, not a judgement about the image. What the pixels are is the
 * client's business: an avatar is one URL on one row, shown cropped into a
 * fixed-size element, and only an admin of the studio that displays it can
 * reach this at all.
 * @returns `200` with `{ data: Studio }`; `403` not the admin — also when the
 *   slug matches no studio, since `requireStudioRole` hides existence rather
 *   than answering `404`; `413` over the byte cap, `415` bytes whose signature
 *   is not one this server has an extension for, `422` empty body, `429` rate
 *   limited
 */
studio.post(
  "/:slug/avatar",
  requireStudioRole("admin"),
  rateLimitFor("avatar-upload", "user"),
  async (c) => {
    const slug = c.req.param("slug");
    const { avatar } = getStorageConfig();
    const bytes = await readBoundedBody(c, avatar.max_bytes);
    const data = await studioAvatarService.setAvatar(slug, bytes);
    return c.json({ data });
  },
);

/**
 * `DELETE /api/v1/studio/:slug/avatar` — drop the studio's avatar, falling
 * the UI back to initials. Admin-only.
 *
 * Clears the column only; the stored object is left in place, since runtime
 * never deletes from storage.
 * @returns `200` with `{ data: Studio }`; `403` not the admin — also when the
 *   slug matches no studio, since `requireStudioRole` hides existence rather
 *   than answering `404`
 */
studio.delete("/:slug/avatar", requireStudioRole("admin"), async (c) => {
  const slug = c.req.param("slug");
  const data = await studioAvatarService.clearAvatar(slug);
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
studio.post(
  "/:slug/members",
  requireStudioRole("admin"),
  validate("json", inviteMemberSchema),
  async (c) => {
    const user = c.get("user");
    const slug = c.req.param("slug");
    const body = c.req.valid("json");
    // The optional best-effort invite email is sent inside the service (the bell
    // notification is the always-delivered path); the route only passes the Origin.
    await studioInviteService.createInvite(
      slug,
      user.id,
      body.email,
      body.role,
      c.req.header("Origin") ?? "http://localhost:8000",
    );
    return c.json({ data: { ok: true } }, 201);
  },
);

/**
 * `DELETE /api/v1/studio/:slug/members/:userId` — remove (kick) a member.
 * Admin-only; clears the member's access across all the studio's projects and
 * transfers their owned projects to **the studio's admin**, in one
 * transaction. The service resolves the admin itself rather than taking the
 * caller's id — the two coincide here because of the gate above, but the
 * self-service leave route has no such actor, and one definition of "who
 * inherits" beats two.
 * @returns `200` with `{ data: { ok: true } }`; `403` personal / not admin,
 *   `404` not a member, `409` the sole admin (transfer first)
 */
studio.delete("/:slug/members/:userId", requireStudioRole("admin"), async (c) => {
  const slug = c.req.param("slug");
  const targetUserId = c.req.param("userId");
  await studioMemberService.removeMember(slug, targetUserId);
  return c.json({ data: { ok: true } });
});

/**
 * `DELETE /api/v1/studio/:slug/membership` — leave a studio of one's own
 * accord. Any active member of the studio; the sole admin has to transfer
 * first.
 *
 * The path is `/membership`, not `/members/me`, because the sibling kick route
 * above claims `/members/:userId` — `me` would match that wildcard and be
 * refused by its admin gate, so the only people entitled to leave would be
 * exactly the people turned away. Reordering the two registrations does make
 * `me` win, but only as long as nobody reorders them again; a path that cannot
 * collide needs no such discipline.
 *
 * Gated on membership rather than admin for the same reason: the callers are
 * precisely the non-admins. A non-member is refused with 403, like every other
 * studio route, which also keeps the studio's existence hidden.
 * @returns `200` with `{ data: { ok: true } }`; `403` not a member or the
 *   studio is personal, `404` no such studio, `409` the sole admin
 */
studio.delete("/:slug/membership", requireStudioRole("guest"), async (c) => {
  const user = c.get("user");
  const slug = c.req.param("slug");
  await studioMemberService.leaveStudio(slug, user.id);
  return c.json({ data: { ok: true } });
});

/**
 * `PATCH /api/v1/studio/:slug/members/:userId` — change a member's role
 * (maintainer ↔ guest). Admin-only; admin grant/demote goes through
 * transfer-admin, not here.
 * @returns `200` with `{ data: { ok: true } }`; `403` personal / not admin,
 *   `404` not a member, `409` target is the admin (demote via transfer)
 */
studio.patch(
  "/:slug/members/:userId",
  requireStudioRole("admin"),
  validate("json", changeRoleSchema),
  async (c) => {
    const slug = c.req.param("slug");
    const targetUserId = c.req.param("userId");
    const body = c.req.valid("json");
    await studioMemberService.updateMemberRole(slug, targetUserId, body.role);
    return c.json({ data: { ok: true } });
  },
);

/**
 * `POST /api/v1/studio/:slug/transfer-admin` — the admin asks an existing
 * member to take over as admin (step 1 of the two-step handshake). Admin-only;
 * drops an actionable `studio.transfer_request` notification (confirm/cancel,
 * expiring with the decision window) in the recipient's inbox. No role change
 * yet — that lands when the recipient confirms via the notification action
 * endpoint.
 * @returns `201` with `{ data: { ok: true } }`; `403` personal / not admin,
 *   `404` recipient not a member, `422` recipient is the acting admin
 */
studio.post(
  "/:slug/transfer-admin",
  requireStudioRole("admin"),
  validate("json", transferAdminSchema),
  async (c) => {
    const user = c.get("user");
    const slug = c.req.param("slug");
    const body = c.req.valid("json");
    // The service sends the best-effort transfer email itself (needs the recipient
    // + profile repos); the route only forwards the request Origin for the link.
    await studioTransferService.requestTransfer(
      slug,
      user.id,
      body.toUserId,
      c.req.header("Origin") ?? "http://localhost:8000",
    );
    return c.json({ data: { ok: true } }, 201);
  },
);

/**
 * `GET /api/v1/studio/:slug/transfer` — the studio's outstanding adminship
 * offer, or null.
 *
 * Admin-gated because it is the admin's own "transfer pending · withdraw"
 * surface; the recipient sees the same offer in their bell.
 * @returns `200` with `{ data: { id, fromUserId, toUserId, expiresAt } | null }`
 */
studio.get("/:slug/transfer", requireStudioRole("admin"), async (c) => {
  const live = await studioTransferService.findLiveTransfer(
    c.req.param("slug"),
  );
  return c.json({
    data: live ? { ...live, expiresAt: live.expiresAt.toISOString() } : null,
  });
});

/**
 * `DELETE /api/v1/studio/:slug/transfer/:transferId` — the CURRENT admin
 * withdraws an outstanding offer, freeing the studio's slot at once.
 *
 * Withdrawal belongs to whoever administers the studio now, not to whoever sent
 * the offer: after a transfer the former admin is gone, and a second unanswered
 * offer would block adminship for a week with the only key held by someone who
 * has left. The service matches the offer against this studio, so an id from
 * elsewhere answers 404.
 * @returns `200` with `{ data: { ok: true } }`; `404` no live offer matches
 */
studio.delete(
  "/:slug/transfer/:transferId",
  // Registered BEFORE the role middleware, the same way the project routes do
  // it: a validator behind a middleware that already reads the param cannot
  // stop what the middleware does with it.
  validate(
    "param",
    z.object({ slug: z.string(), transferId: z.string().uuid() }),
  ),
  requireStudioRole("admin"),
  async (c) => {
    await studioTransferService.withdrawTransfer(
      c.req.param("transferId"),
      c.req.param("slug"),
    );
    return c.json({ data: { ok: true } });
  },
);

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

/**
 * `GET /api/v1/studio/:slug/credits` — this studio's credits, for its admin.
 *
 * The pool is the studio's money and the admin is who manages it, so this
 * page is theirs alone. The web app leaves the section out of everyone else's
 * strip, but a URL is typed as easily as it is clicked, so the door is here.
 *
 * The ledger beside it is the studio's own, one line per generation: taking
 * it by payer would hide what everyone else's top-ups paid for, and would
 * split a generation that ran short between two people, since its spend rows
 * are against the lot owner and its shortfall against whoever ran it.
 * @returns `200` with `{ data: StudioCreditsView }`; `403` for anyone who is
 *   not this studio's admin (which also hides whether the studio exists),
 *   `401` when signed out
 */
studio.get(
  "/:slug/credits",
  requireStudioRole("admin"),
  validate("query", creditPageQuerySchema),
  async (c) => {
    const slug = c.req.param("slug");
    const target = await studioService.getStudioBySlug(slug);
    if (!target) throw new NotFoundError(t("server.error.not_found"));
    const { limit, cursor } = c.req.valid("query");
    const data = await creditViewService.getStudioCredits(
      target.id,
      limit,
      cursor,
    );
    return c.json({ data });
  },
);

export { studios as studiosRoute, studio as studioRoute };
