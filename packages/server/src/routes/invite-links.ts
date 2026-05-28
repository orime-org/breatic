/**
 * Share / invite link routes — create / list / revoke / consume.
 *
 * Mounted under `/api/v1/projects/:pid/invite-links` (owner CRUD) and
 * `/api/v1/invite-links` (public consume by token).
 *
 * Two ShareDialog flows funnel through the same `POST create`:
 *   - email invite: body includes `inviteeEmail` → after create, the
 *     handler dispatches `buildShareInviteMail` to that address
 *   - copy link  : body omits `inviteeEmail` → no mail dispatched,
 *     caller gets the URL back to paste manually
 *
 * `POST consume` is the path 2/3 entry for a non-member who clicked
 * an invite link. It validates the token (single-use vs permanent,
 * expiry, soft-delete) and returns the resolved link so the caller's
 * client knows where to navigate (and what role they'll get).
 *
 * Per CLAUDE.md "library 层不写日志": mail dispatch + audit log live
 * here (application boundary) — the shareLink service stays pure.
 */

import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import type { AuthVariables } from "../middleware/auth.js";
import { requireRole } from "../middleware/role.js";
import type { AuthRoleVariables } from "../middleware/role.js";
import {
  shareLinkService,
  accessRequestMail,
  projectService,
  userRepo,
  sendMail,
  logger,
} from "@breatic/core";
import type { SendMailResult } from "@breatic/core";
import { logMailResult } from "../utils/log-mail.js";

const bodySchemaCreate = z.object({
  role: z.enum(["view", "edit"]),
  is_permanent: z.boolean(),
  /**
   * Optional email — when present, the server sends the invite mail
   * directly to this address (ShareDialog "send invite" flow). When
   * omitted, the caller just wants the URL back (copy-link flow).
   */
  invitee_email: z.string().email().optional(),
  /**
   * Optional ISO-8601 expiry (single-use links can have a clock too;
   * permanent links typically have no expiry).
   */
  expires_at: z.string().datetime().optional(),
});

// ── Per-project endpoints (owner CRUD) ──────────────────────────────

const projectInviteLinks = new Hono<{ Variables: AuthRoleVariables }>();

projectInviteLinks.use(requireAuth);

/**
 * `POST /api/v1/projects/:pid/invite-links` — create a new share link.
 *
 * Owner only. Server generates the token + 32-byte base64url. If
 * `invitee_email` is provided, dispatches `shareInvite` mail.
 *
 * @returns `201` with `{ data: ShareLink }`
 */
projectInviteLinks.post(
  "/",
  requireRole("owner"),
  zValidator("json", bodySchemaCreate),
  async (c) => {
    const user = c.get("user");
    const projectId = c.req.param("pid") as string;
    const body = c.req.valid("json");

    const link = await shareLinkService.createLink({
      projectId,
      createdByUserId: user.id,
      role: body.role,
      isPermanent: body.is_permanent,
      expiresAt: body.expires_at ? new Date(body.expires_at) : null,
    });

    logger.info(
      {
        projectId,
        createdByUserId: user.id,
        linkId: link.id,
        isPermanent: body.is_permanent,
        invited: body.invitee_email !== undefined,
      },
      "invite_link_created",
    );

    if (body.invitee_email) {
      try {
        await dispatchInviteeMail(c, projectId, user.id, link, body.invitee_email);
      } catch (err) {
        logger.error(
          { err, projectId, linkId: link.id, inviteeEmail: body.invitee_email },
          "invite_link_mail_dispatch_failed",
        );
      }
    }

    return c.json({ data: link }, 201);
  },
);

/**
 * `GET /api/v1/projects/:pid/invite-links` — list active links on a
 * project. Owner only.
 */
projectInviteLinks.get("/", requireRole("owner"), async (c) => {
  const projectId = c.req.param("pid") as string;
  const list = await shareLinkService.listByProject(projectId);
  return c.json({ data: list });
});

/**
 * `DELETE /api/v1/projects/:pid/invite-links/:linkId` — revoke a
 * link (soft-delete). Owner only.
 */
projectInviteLinks.delete(
  "/:linkId",
  requireRole("owner"),
  async (c) => {
    const linkId = c.req.param("linkId") as string;
    await shareLinkService.revokeLink(linkId);
    return c.json({ data: { ok: true } });
  },
);

// ── Public consume endpoint ─────────────────────────────────────────

const consumeInviteLink = new Hono<{ Variables: AuthVariables }>();

consumeInviteLink.use(requireAuth);

/**
 * `POST /api/v1/invite-links/:token/consume` — consume a token.
 *
 * Returns the resolved link so the caller's client knows the project
 * + role + whether the link is now spent. The caller is expected to
 * navigate to the project URL and either:
 *   - become a member at `link.role` (if not already), or
 *   - fall back to access request flow if the route can't auto-add
 *     them (e.g. project has a member cap or owner gate).
 *
 * Single-use vs permanent semantics live in the service:
 *   - single-use first consume: `consumed_at` set atomically, link
 *     becomes 410 Gone on next visit
 *   - permanent: idempotent; consume returns the link, no mutation
 */
consumeInviteLink.post("/:token/consume", async (c) => {
  const token = c.req.param("token") as string;
  const user = c.get("user");
  const link = await shareLinkService.consumeLink(token);

  logger.info(
    {
      linkId: link.id,
      projectId: link.projectId,
      consumerUserId: user.id,
      isPermanent: link.isPermanent,
    },
    "invite_link_consumed",
  );

  return c.json({ data: link });
});

// ── Mail dispatch helper ────────────────────────────────────────────

interface BaseCtx {
  req: { header(name: string): string | undefined };
}

function originFrom(c: BaseCtx, fallback: string): string {
  return c.req.header("Origin") ?? fallback;
}

async function dispatchInviteeMail(
  c: BaseCtx,
  projectId: string,
  inviterUserId: string,
  link: { token: string; role: string; isPermanent: boolean },
  inviteeEmail: string,
): Promise<void> {
  const [inviter, project] = await Promise.all([
    userRepo.getUserById(inviterUserId),
    projectService.get(projectId, inviterUserId).catch(() => null),
  ]);
  if (!inviter) return;
  const origin = originFrom(c, "http://localhost:8000");
  const mailOpts = accessRequestMail.buildShareInviteMail({
    inviteeEmail,
    inviterName: inviter.username ?? inviter.email,
    projectName: project?.name ?? "the project",
    inviteLink: `${origin}/invite/${link.token}`,
    isPermanent: link.isPermanent,
    role: link.role,
  });
  const result: SendMailResult = await sendMail(mailOpts);
  logMailResult(result, {
    userId: inviterUserId,
    subject: "share_invite",
  });
}

export { projectInviteLinks as projectInviteLinksRoute };
export { consumeInviteLink as consumeInviteLinkRoute };
