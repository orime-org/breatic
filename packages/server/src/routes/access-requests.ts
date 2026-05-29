/**
 * Project access request routes — request / list / approve / reject.
 *
 * Mounted under `/api/v1/projects/:pid/access-requests` and the
 * per-user `/api/v1/users/me/access-requests`.
 *
 * Three notification dispatches happen at this application boundary
 * (per CLAUDE.md "library 层不写日志"):
 *
 *   POST  → buildAccessRequestCreatedMail  (owner notification)
 *   PATCH approve → buildAccessRequestApprovedMail (requester)
 *   PATCH reject  → buildAccessRequestRejectedMail (requester)
 *
 * Email dispatch outcome is logged via {@link logMailResult}. Audit
 * lines are emitted on every state transition so an oncall can trace
 * "who requested access to what / when / approved by whom".
 *
 * Spec: engineering/specs/2026-05-26-deprecate-noaccount-email-auth-spec.md
 * § 5.2 (endpoints) + § 7 decision 7 (NOT_MEMBER flow).
 */

import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { requireAuth } from "@/middleware/auth.js";
import type { AuthVariables } from "@/middleware/auth.js";
import { requireRole } from "@/middleware/role.js";
import type { AuthRoleVariables } from "@/middleware/role.js";
import {
  accessRequestService,
  accessRequestMail,
  projectMembersService,
  projectService,
  userRepo,
  sendMail,
  logger,
} from "@breatic/core";
import type { SendMailResult } from "@breatic/core";
import { logMailResult } from "@/utils/log-mail.js";

const bodySchemaCreate = z.object({
  requested_role: z.enum(["view", "edit"]),
  message: z.string().max(2000).nullable().optional(),
});

const bodySchemaPatch = z.object({
  decision: z.enum(["approved", "rejected"]),
});

// ── Per-project endpoints (mounted at /projects/:pid/access-requests)

const projectAccessRequests = new Hono<{ Variables: AuthRoleVariables }>();

projectAccessRequests.use(requireAuth);

/**
 * `POST /api/v1/projects/:pid/access-requests` — submit a new request.
 *
 * Open to any authenticated user — anyone can ask to join a project
 * they can see the id of. The service refuses if the caller is
 * already a member (Conflict) or already has a pending request.
 *
 * After insert, sends `accessRequestCreated` mail to the project
 * owner (gated by EMAIL_BACKEND).
 */
projectAccessRequests.post(
  "/",
  zValidator("json", bodySchemaCreate),
  async (c) => {
    const user = c.get("user");
    const projectId = c.req.param("pid") as string;
    const body = c.req.valid("json");

    const request = await accessRequestService.createRequest({
      projectId,
      requesterUserId: user.id,
      requestedRole: body.requested_role,
      message: body.message ?? null,
    });

    logger.info(
      {
        projectId,
        requesterUserId: user.id,
        requestedRole: body.requested_role,
        requestId: request.id,
      },
      "access_request_created",
    );

    // Fire-and-forget mail dispatch — log the outcome but don't fail
    // the request if mail can't be sent (the requester's request is
    // recorded either way).
    try {
      await dispatchOwnerNotification(
        c,
        projectId,
        user.id,
        request.requestedRole,
        request.message,
      );
    } catch (err) {
      logger.error(
        { err, projectId, requesterUserId: user.id, requestId: request.id },
        "access_request_owner_notification_failed",
      );
    }

    return c.json({ data: request }, 201);
  },
);

/**
 * `GET /api/v1/projects/:pid/access-requests` — list pending requests
 * on a project. Owner only.
 */
projectAccessRequests.get("/", requireRole("owner"), async (c) => {
  const projectId = c.req.param("pid") as string;
  const list = await accessRequestService.listPendingByProject(projectId);
  return c.json({ data: list });
});

/**
 * `PATCH /api/v1/projects/:pid/access-requests/:reqId` — approve or
 * reject a pending request. Owner only.
 *
 * Approve: atomically transitions status + inserts member row at the
 * requested role (service uses db.transaction).
 * Reject: status → rejected; no membership change.
 *
 * Both dispatch a mail to the requester (gated by EMAIL_BACKEND).
 */
projectAccessRequests.patch(
  "/:reqId",
  requireRole("owner"),
  zValidator("json", bodySchemaPatch),
  async (c) => {
    const user = c.get("user");
    const projectId = c.req.param("pid") as string;
    const reqId = c.req.param("reqId") as string;
    const { decision } = c.req.valid("json");

    const updated =
      decision === "approved"
        ? await accessRequestService.approveRequest(reqId, user.id)
        : await accessRequestService.rejectRequest(reqId, user.id);

    logger.info(
      {
        projectId,
        requestId: reqId,
        reviewerUserId: user.id,
        decision,
      },
      `access_request_${decision}`,
    );

    try {
      await dispatchRequesterDecisionMail(c, updated, decision);
    } catch (err) {
      logger.error(
        { err, projectId, requestId: reqId, decision },
        "access_request_decision_notification_failed",
      );
    }

    return c.json({ data: updated });
  },
);

// ── Per-user endpoint (mounted at /users/me/access-requests) ────────

const myAccessRequests = new Hono<{ Variables: AuthVariables }>();

myAccessRequests.use(requireAuth);

/**
 * `GET /api/v1/users/me/access-requests` — list all requests this
 * caller has submitted (their own status page).
 */
myAccessRequests.get("/", async (c) => {
  const user = c.get("user");
  const list = await accessRequestService.listByRequester(user.id);
  return c.json({ data: list });
});

// ── Mail dispatch helpers (application boundary owns log) ───────────

interface BaseCtx {
  req: { header(name: string): string | undefined };
}

function originFrom(c: BaseCtx, fallback: string): string {
  return c.req.header("Origin") ?? fallback;
}

async function dispatchOwnerNotification(
  c: BaseCtx,
  projectId: string,
  requesterUserId: string,
  requestedRole: string,
  message: string | null,
): Promise<void> {
  const [ownerId, project, requester] = await Promise.all([
    projectMembersService.getOwner(projectId),
    projectService.get(projectId, requesterUserId).catch(() => null),
    userRepo.getUserById(requesterUserId),
  ]);
  if (!ownerId || !requester) return;
  const owner = await userRepo.getUserById(ownerId);
  if (!owner) return;

  const origin = originFrom(c, "http://localhost:8000");
  const projectName = project?.name ?? "your project";
  const mailOpts = accessRequestMail.buildAccessRequestCreatedMail({
    ownerEmail: owner.email,
    ownerName: owner.username,
    requesterName: requester.username ?? requester.email,
    requesterEmail: requester.email,
    projectName,
    requestedRole,
    message,
    reviewUrl: `${origin}/p/${projectId}?bell=open`,
  });
  const result: SendMailResult = await sendMail(mailOpts);
  logMailResult(result, {
    userId: owner.id,
    subject: "access_request_created",
  });
}

async function dispatchRequesterDecisionMail(
  c: BaseCtx,
  request: {
    requesterUserId: string;
    projectId: string;
    requestedRole: string;
  },
  decision: "approved" | "rejected",
): Promise<void> {
  const [requester, project] = await Promise.all([
    userRepo.getUserById(request.requesterUserId),
    projectService.get(request.projectId, request.requesterUserId).catch(() => null),
  ]);
  if (!requester) return;
  const projectName = project?.name ?? "the project";
  const origin = originFrom(c, "http://localhost:8000");

  const mailOpts =
    decision === "approved"
      ? accessRequestMail.buildAccessRequestApprovedMail({
          requesterEmail: requester.email,
          projectName,
          projectUrl: `${origin}/p/${request.projectId}`,
        })
      : accessRequestMail.buildAccessRequestRejectedMail({
          requesterEmail: requester.email,
          projectName,
        });
  const result = await sendMail(mailOpts);
  logMailResult(result, {
    userId: requester.id,
    subject: `access_request_${decision}`,
  });
}

export { projectAccessRequests as projectAccessRequestsRoute };
export { myAccessRequests as myAccessRequestsRoute };
