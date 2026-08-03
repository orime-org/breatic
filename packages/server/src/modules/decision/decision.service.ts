// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * What one landing page says about any of the five waiting requests.
 *
 * The five flows keep their own tables and their own status words. This module
 * is where they stop being five things: it takes a token, finds the request,
 * and produces one shape the page can render without knowing which table it
 * came from.
 *
 * Two decisions are worth stating because they are easy to get backwards.
 *
 * The view carries no ids and no slugs. It is what an unanswered request looks
 * like to someone who has not decided yet, reached through a URL that reveals
 * nothing about which studio or project is involved — putting an id back in
 * would undo the reason the token exists.
 *
 * Names are resolved at read time, never stored. A studio can be renamed and a
 * personal studio's name IS its owner's display name, so a copy taken when the
 * request was filed would eventually describe someone else.
 */

import { eq } from "drizzle-orm";
import {
  db,
  studioInvitations,
  projectInvitations,
  roleUpgradeRequests,
  projectTransfers,
  studioTransfers,
  projectMembersRepo,
} from "@breatic/core";
import { studioMembersRepo } from "@breatic/domain";
import type {
  DecisionAction,
  DecisionKind,
  DecisionResult,
  DecisionState,
  DecisionView,
} from "@breatic/shared";
import { ConflictError, ForbiddenError, NotFoundError } from "@breatic/core";
import { t } from "@breatic/shared";
import * as studioInviteService from "@server/modules/studio/studioInvite.service.js";
import * as projectInviteService from "@server/modules/project-invite/projectInvite.service.js";
import * as roleUpgradeService from "@server/modules/role-upgrade-request/roleUpgradeRequest.service.js";
import * as projectTransferService from "@server/modules/project/projectTransfer.service.js";
import * as studioTransferService from "@server/modules/studio/studioTransfer.service.js";
import * as decisionRepo from "@server/modules/decision/decision.repo.js";
import * as studioRepo from "@server/modules/studio/studio.repo.js";
import * as projectRepo from "@server/modules/project/project.repo.js";
import { getDeferredRequestTtlDays } from "@server/config/limits.js";

/**
 * The parts of a request that differ by flow, once the flow-specific column
 * names are behind us.
 */
interface RequestDetail {
  /** The studio or project being decided about. */
  container: { kind: "studio" | "project"; id: string };
  /** Who set it in motion. */
  actorUserId: string;
  /** Who is being asked. */
  recipientUserId: string;
  role: string | null;
  message: string | null;
}

/** Terminal status words meaning the recipient said yes. */
const ACCEPTED = new Set(["accepted", "approved"]);
/** Terminal status words meaning the recipient said no. */
const DECLINED = new Set(["declined", "rejected"]);
/** Terminal status words meaning the initiator took it back. */
const WITHDRAWN = new Set(["revoked", "cancelled"]);

/** The two flows where the recipient is, by definition, not a member yet. */
const INVITE_KINDS = new Set<DecisionKind>(["studio_invite", "project_invite"]);

/**
 * Reads the flow-specific half of a request.
 *
 * Each flow names its columns differently — `invitedUserId` here, `toUserId`
 * there, `requesterUserId` in the third — so this is the one place that has to
 * know five shapes. Everything after it works on {@link RequestDetail}.
 * @param kind - Which flow the request belongs to.
 * @param id - The request row's id.
 * @returns Its detail, or null when the row vanished between two queries.
 */
async function readDetail(
  kind: DecisionKind,
  id: string,
): Promise<RequestDetail | null> {
  switch (kind) {
    case "studio_invite": {
      const [row] = await db
        .select({
          studioId: studioInvitations.studioId,
          invitedBy: studioInvitations.invitedBy,
          invitedUserId: studioInvitations.invitedUserId,
          role: studioInvitations.role,
        })
        .from(studioInvitations)
        .where(eq(studioInvitations.id, id))
        .limit(1);
      if (!row) return null;
      return {
        container: { kind: "studio", id: row.studioId },
        actorUserId: row.invitedBy,
        recipientUserId: row.invitedUserId,
        role: row.role,
        message: null,
      };
    }
    case "project_invite": {
      const [row] = await db
        .select({
          projectId: projectInvitations.projectId,
          invitedBy: projectInvitations.invitedBy,
          invitedUserId: projectInvitations.invitedUserId,
          role: projectInvitations.role,
        })
        .from(projectInvitations)
        .where(eq(projectInvitations.id, id))
        .limit(1);
      if (!row) return null;
      return {
        container: { kind: "project", id: row.projectId },
        actorUserId: row.invitedBy,
        recipientUserId: row.invitedUserId,
        role: row.role,
        message: null,
      };
    }
    case "role_upgrade": {
      const [row] = await db
        .select({
          projectId: roleUpgradeRequests.projectId,
          requesterUserId: roleUpgradeRequests.requesterUserId,
          requestedRole: roleUpgradeRequests.requestedRole,
          message: roleUpgradeRequests.message,
        })
        .from(roleUpgradeRequests)
        .where(eq(roleUpgradeRequests.id, id))
        .limit(1);
      if (!row) return null;
      // The requester is the ACTOR; the person being asked is the project's
      // owner, resolved below rather than stored on the request.
      const ownerId = await projectMembersRepo.getOwner(row.projectId);
      return {
        container: { kind: "project", id: row.projectId },
        actorUserId: row.requesterUserId,
        recipientUserId: ownerId ?? "",
        role: row.requestedRole,
        message: row.message,
      };
    }
    case "project_transfer": {
      const [row] = await db
        .select({
          projectId: projectTransfers.projectId,
          fromUserId: projectTransfers.fromUserId,
          toUserId: projectTransfers.toUserId,
        })
        .from(projectTransfers)
        .where(eq(projectTransfers.id, id))
        .limit(1);
      if (!row) return null;
      return {
        container: { kind: "project", id: row.projectId },
        actorUserId: row.fromUserId,
        recipientUserId: row.toUserId,
        role: null,
        message: null,
      };
    }
    case "studio_transfer": {
      const [row] = await db
        .select({
          studioId: studioTransfers.studioId,
          fromUserId: studioTransfers.fromUserId,
          toUserId: studioTransfers.toUserId,
        })
        .from(studioTransfers)
        .where(eq(studioTransfers.id, id))
        .limit(1);
      if (!row) return null;
      return {
        container: { kind: "studio", id: row.studioId },
        actorUserId: row.fromUserId,
        recipientUserId: row.toUserId,
        role: null,
        message: null,
      };
    }
  }
}

/**
 * Decides which of the four dead ends, or none of them, this request is in.
 *
 * Order is load-bearing. Deleted wins over everything, because a request that
 * went away with its project is gone whatever its status column still says.
 * Already-a-member comes next and ONLY for invites: the other three flows
 * require the recipient to be a member already, so asking "are you in?" there
 * would leave them permanently unanswerable.
 * @param input - The resolved request, its detail, and whether the recipient
 *   already belongs to the container.
 * @returns The state the landing page should render.
 */
function decideState(input: {
  kind: DecisionKind;
  status: string;
  deleted: boolean;
  expiresAt: Date;
  recipientAlreadyIn: boolean;
}): DecisionState {
  if (input.deleted) return "gone";
  if (ACCEPTED.has(input.status)) return "accepted";
  if (DECLINED.has(input.status)) return "declined";
  if (WITHDRAWN.has(input.status)) return "revoked";
  if (input.status === "expired") return "expired";
  // A timed-out row keeps `status = 'pending'` until a reaper rewrites it, so
  // the clock has to be checked as well as the column.
  if (input.expiresAt.getTime() <= Date.now()) return "expired";
  if (INVITE_KINDS.has(input.kind) && input.recipientAlreadyIn) {
    return "already_member";
  }
  return "answerable";
}

/**
 * Builds the landing view for a share token.
 * @param token - The token from the decision link.
 * @param viewerUserId - Who is looking; decides `isRecipient`.
 * @returns The view, or null when no request answers to that token — the one
 *   case the page may call an invalid link.
 */
export async function viewByToken(
  token: string,
  viewerUserId: string,
): Promise<DecisionView | null> {
  const found = await decisionRepo.resolveByToken(token);
  if (!found) return null;

  const detail = await readDetail(found.kind, found.id);
  if (!detail) return null;

  const [containerName, actorName, recipientAlreadyIn] = await Promise.all([
    readContainerName(detail.container),
    readDisplayName(detail.actorUserId),
    isAlreadyIn(detail.container, detail.recipientUserId),
  ]);

  const state = decideState({
    kind: found.kind,
    status: found.status,
    deleted: found.deleted,
    expiresAt: found.expiresAt,
    recipientAlreadyIn,
  });

  return {
    kind: found.kind,
    state,
    entityName: containerName,
    actorName,
    role: detail.role,
    message: detail.message,
    // Only the answerable card counts down; every other state either has no
    // meaningful date or would print one that reads as a lie.
    expiresAt: state === "answerable" ? found.expiresAt.toISOString() : null,
    isRecipient: detail.recipientUserId === viewerUserId,
    windowDays: getDeferredRequestTtlDays(),
  };
}

/**
 * Reads a container's current name.
 * @param container - Which studio or project.
 * @returns Its name, or an empty string when it is gone — the `gone` state
 *   already carries that news, so there is nothing to name.
 */
async function readContainerName(
  container: RequestDetail["container"],
): Promise<string> {
  if (container.kind === "studio") {
    const names = await studioRepo.getIdentitiesByStudioIds([container.id]);
    return names.get(container.id)?.name ?? "";
  }
  const names = await projectRepo.getIdentitiesByProjectIds([container.id]);
  return names.get(container.id)?.name ?? "";
}

/**
 * Reads a user's current display name.
 *
 * A user's name is their personal studio's name, so this goes through the same
 * resolution the bell uses rather than reading a stored copy.
 * @param userId - Whose name.
 * @returns The name, or an empty string if it cannot be resolved.
 */
async function readDisplayName(userId: string): Promise<string> {
  if (userId === "") return "";
  const profiles = await studioRepo.getPersonalProfilesByCreators([userId]);
  return profiles.get(userId)?.name ?? "";
}

/**
 * Whether the person being asked already belongs to the container.
 * @param container - Which studio or project.
 * @param userId - The recipient.
 * @returns True when they already have a live membership.
 */
async function isAlreadyIn(
  container: RequestDetail["container"],
  userId: string,
): Promise<boolean> {
  if (userId === "") return false;
  const role =
    container.kind === "studio"
      ? await studioMembersRepo.getRole(container.id, userId)
      : await projectMembersRepo.getRole(container.id, userId);
  return role !== null;
}

/**
 * The five flows' own settle functions, behind one shape.
 *
 * Each already knows how to do its own write — adding a member, swapping an
 * owner, rewriting a role — and each already re-checks its own preconditions
 * inside its transaction. Nothing is reimplemented here; this only picks.
 * @param kind - Which flow.
 * @param requestId - The request row.
 * @param deciderUserId - Whoever is answering.
 * @param action - Which way.
 * @returns Nothing; the flow's own service performs the write.
 * @throws {NotFoundError | ForbiddenError | ConflictError} whatever the
 *   underlying flow throws when it refuses.
 */
async function settle(
  kind: DecisionKind,
  requestId: string,
  deciderUserId: string,
  action: DecisionAction,
): Promise<void> {
  const confirming = action === "confirm";
  switch (kind) {
    case "studio_invite":
      await (confirming
        ? studioInviteService.confirmInvite(requestId, deciderUserId)
        : studioInviteService.declineInvite(requestId, deciderUserId));
      return;
    case "project_invite":
      await (confirming
        ? projectInviteService.confirmInvite(requestId, deciderUserId)
        : projectInviteService.declineInvite(requestId, deciderUserId));
      return;
    case "role_upgrade":
      await (confirming
        ? roleUpgradeService.approve({ requestId, ownerUserId: deciderUserId })
        : roleUpgradeService.reject({ requestId, ownerUserId: deciderUserId }));
      return;
    case "project_transfer":
      await (confirming
        ? projectTransferService.confirmProjectTransfer(requestId, deciderUserId)
        : projectTransferService.declineProjectTransfer(requestId, deciderUserId));
      return;
    case "studio_transfer":
      await (confirming
        ? studioTransferService.confirmTransfer(requestId, deciderUserId)
        : studioTransferService.declineTransfer(requestId, deciderUserId));
      return;
  }
}

/**
 * Where to send someone who just accepted.
 *
 * The paths follow the existing URL spec rather than anything invented here: a
 * project is `/project/{slug}-{id}` and a studio is `/studio/{slug}`. Declining
 * returns null — you stay on the page that tells you what you just did.
 * @param container - Which studio or project was accepted into.
 * @returns The path, or null when the container cannot be named any more.
 */
async function redirectFor(
  container: RequestDetail["container"],
): Promise<string | null> {
  if (container.kind === "studio") {
    const found = await studioRepo.getIdentitiesByStudioIds([container.id]);
    const slug = found.get(container.id)?.slug;
    return slug === undefined ? null : `/studio/${slug}`;
  }
  const found = await projectRepo.getIdentitiesByProjectIds([container.id]);
  const slug = found.get(container.id)?.slug;
  return slug === undefined ? null : `/project/${slug}-${container.id}`;
}

/**
 * Answers a request through its share token.
 *
 * The gate is here and the write is not: whether this request can still be
 * answered, and whether this person is the one being asked, used to be five
 * separate implementations. What happens on a yes stays with the flow that
 * owns it, including its own transactional re-check — this refusing early is a
 * courtesy to the caller, not the thing keeping the data honest.
 * @param token - The token from the decision link.
 * @param viewerUserId - Who is answering.
 * @param action - Confirm or decline.
 * @returns The state it settled into, and where to go next.
 * @throws {NotFoundError} when no request answers to that token.
 * @throws {ForbiddenError} when the viewer is not the one being asked.
 * @throws {ConflictError} when the request is no longer answerable.
 */
export async function respond(
  token: string,
  viewerUserId: string,
  action: DecisionAction,
): Promise<DecisionResult> {
  const found = await decisionRepo.resolveByToken(token);
  if (!found) throw new NotFoundError(t("server.error.not_found"));

  const detail = await readDetail(found.kind, found.id);
  if (!detail) throw new NotFoundError(t("server.error.not_found"));

  if (detail.recipientUserId !== viewerUserId) {
    throw new ForbiddenError(t("server.error.forbidden"));
  }

  const recipientAlreadyIn = await isAlreadyIn(
    detail.container,
    detail.recipientUserId,
  );
  const state = decideState({
    kind: found.kind,
    status: found.status,
    deleted: found.deleted,
    expiresAt: found.expiresAt,
    recipientAlreadyIn,
  });
  if (state !== "answerable") {
    throw new ConflictError(t("server.error.conflict"));
  }

  await settle(found.kind, found.id, viewerUserId, action);

  return {
    state: action === "confirm" ? "accepted" : "declined",
    redirectTo: action === "confirm" ? await redirectFor(detail.container) : null,
  };
}
