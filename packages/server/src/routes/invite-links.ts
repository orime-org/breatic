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
import { requireAuth } from "@server/middleware/auth.js";
import type { AuthVariables } from "@server/middleware/auth.js";
import { requireRole, getProjectId } from "@server/middleware/role.js";
import type { AuthRoleVariables } from "@server/middleware/role.js";
import {
  shareLinkService,
  shareInviteMail,
  projectService,
  userRepo,
  sendMail,
  logger,
} from "@breatic/core";
import type { SendMailResult } from "@breatic/core";
import { logMailResult } from "@server/utils/log-mail.js";

/**
 * Two ShareDialog flows are now discriminated by an explicit `kind`
 * field, NOT by `invitee_email` presence — one field carrying two
 * semantics (data + type) was the original PR-d design and got
 * refactored. The zod discriminated union below enforces the pairing
 * at the request boundary so the service never sees an inconsistent
 * combination.
 *
 *   - kind: 'email' — invitee_email REQUIRED. Single-use, 7-day TTL.
 *     Server dispatches a share-invite mail to that address.
 *   - kind: 'link'  — invitee_email MUST be omitted. Multi-use, no
 *     expiry. Server just returns the URL.
 *
 * Spec: breatic-inner/engineering/specs/2026-05-28-access-permission-design.md § 3.
 */
const bodySchemaCreate = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("email"),
    role: z.enum(["view", "edit"]),
    invitee_email: z.string().email(),
  }),
  z
    .object({
      kind: z.literal("link"),
      role: z.enum(["view", "edit"]),
      // Accept the property so we can explicitly reject it via the
      // refine below — otherwise zod silently strips unknown keys and
      // a kind='link' with a stray invitee_email would parse OK.
      invitee_email: z.string().optional(),
    })
    .refine((d) => d.invitee_email === undefined, {
      message: "invitee_email must be omitted when kind='link'",
      path: ["invitee_email"],
    }),
]);

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
    const projectId = getProjectId(c);
    const body = c.req.valid("json");

    const link = await shareLinkService.createLink({
      projectId,
      createdByUserId: user.id,
      role: body.role,
      kind: body.kind,
      boundEmail: body.kind === "email" ? body.invitee_email : null,
    });

    logger.info(
      {
        projectId,
        createdByUserId: user.id,
        linkId: link.id,
        kind: body.kind,
      },
      "invite_link_created",
    );

    if (body.kind === "email") {
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
  const projectId = getProjectId(c);
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
    const linkId = c.req.param("linkId");
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
 * + role to navigate to (the consumer becomes a member at `link.role`).
 * On an invalid / expired / spent / bound-email-mismatch token the
 * service throws → the caller surfaces a "link no longer valid,
 * contact the project owner" screen (2026-05-28 spec § 2.1). There is
 * no self-service access-request fallback (owner-invite-only model).
 *
 * `kind='email'` vs `kind='link'` semantics live in the service:
 *   - `kind='email'` (single-use): first consume sets `consumed_at`
 *     atomically; the link becomes 410 Gone on next visit
 *   - `kind='link'` (multi-use): idempotent; consume returns the link,
 *     no mutation
 */
consumeInviteLink.post("/:token/consume", async (c) => {
  const token = c.req.param("token");
  const user = c.get("user");
  const link = await shareLinkService.consumeLink(token, user.email);

  logger.info(
    {
      linkId: link.id,
      projectId: link.projectId,
      consumerUserId: user.id,
      kind: link.kind,
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
  link: { token: string; role: string; kind: "email" | "link"; boundEmail: string | null },
  inviteeEmail: string,
): Promise<void> {
  const [inviter, project] = await Promise.all([
    userRepo.getUserById(inviterUserId),
    projectService.get(projectId, inviterUserId).catch(() => null),
  ]);
  if (!inviter) return;
  const origin = originFrom(c, "http://localhost:8000");
  const mailOpts = shareInviteMail.buildShareInviteMail({
    inviteeEmail,
    inviterName: inviter.username ?? inviter.email,
    projectName: project?.name ?? "the project",
    inviteLink: `${origin}/invite/${link.token}`,
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
