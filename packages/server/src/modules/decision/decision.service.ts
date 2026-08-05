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
 * would undo the reason the token exists. `destination` is the sole exception
 * and stays inside the rule: it is filled only for a recipient who is already
 * a member, so the only person it ever names the entity to is one who can
 * already open it.
 *
 * Names are resolved at read time, never stored. A studio can be renamed and a
 * personal studio's name IS its owner's display name, so a copy taken when the
 * request was filed would eventually describe someone else.
 */

import { projectMembersRepo } from "@breatic/core";
import { studioMembersRepo } from "@breatic/domain";
import type {
  DecisionAction,
  DecisionKind,
  DecisionResult,
  DecisionState,
  DecisionView,
} from "@breatic/shared";
import { ConflictError, ForbiddenError, NotFoundError } from "@breatic/core";
import { t, ROLE_RANK, STUDIO_ROLE_RANK } from "@breatic/shared";
import * as studioInviteService from "@server/modules/studio/studioInvite.service.js";
import * as projectInviteService from "@server/modules/project-invite/projectInvite.service.js";
import * as roleUpgradeService from "@server/modules/role-upgrade-request/roleUpgradeRequest.service.js";
import * as projectTransferService from "@server/modules/project/projectTransfer.service.js";
import * as studioTransferService from "@server/modules/studio/studioTransfer.service.js";
import * as decisionRepo from "@server/modules/decision/decision.repo.js";
import type { RequestDetail } from "@server/modules/decision/decision.repo.js";
import * as studioRepo from "@server/modules/studio/studio.repo.js";
import * as projectRepo from "@server/modules/project/project.repo.js";
import { DAY_MS } from "@server/config/limits.js";


/** Terminal status words meaning the recipient said yes. */
const ACCEPTED = new Set(["accepted", "approved"]);
/** Terminal status words meaning the recipient said no. */
const DECLINED = new Set(["declined", "rejected"]);
/** Terminal status words meaning the initiator took it back. */
const WITHDRAWN = new Set(["revoked", "cancelled"]);

/**
 * The answering window this request actually had, in whole days.
 *
 * Derived from the row (`expires_at - created_at`) rather than read from the
 * yaml knob at view time: the knob can be turned, and a request's window is a
 * fact about its row — reading today's config made every historical expired
 * card change its story with the ops setting.
 * @param createdAt - When the request was filed.
 * @param expiresAt - When its window closes.
 * @returns The window length in days, at least 1.
 */
function windowDaysOf(createdAt: Date, expiresAt: Date): number {
  return Math.max(1, Math.round((expiresAt.getTime() - createdAt.getTime()) / DAY_MS));
}

/** The two flows where the recipient is, by definition, not a member yet. */
const INVITE_KINDS = new Set<DecisionKind>(["studio_invite", "project_invite"]);


/**
 * Decides which of the four dead ends, or none of them, this request is in.
 *
 * Order is load-bearing. Deleted wins over everything, because a request that
 * went away with its project is gone whatever its status column still says.
 * Then the terminal statuses, then the two expiry checks; already-a-member
 * comes LAST, so it can only ever downgrade a request that would otherwise be
 * answerable — an accepted or expired invite reports its own state, not the
 * membership. And it applies ONLY to invites: the other three flows require
 * the recipient to be a member already, so asking "are you in?" there would
 * leave them permanently unanswerable.
 * @param input - What is known about the request.
 * @param input.kind - Which flow it belongs to.
 * @param input.status - Its own table's status word.
 * @param input.deleted - Whether the row was soft-deleted with its container.
 * @param input.expiresAt - When the answering window closes.
 * @param input.recipientAlreadyIn - Whether the recipient already belongs to
 *   the container; only meaningful for the two invite flows.
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

  const detail = await decisionRepo.readDetail(found.kind, found.id);
  if (!detail) return null;

  // The membership question only exists for the two invite flows — the other
  // three REQUIRE a member (a transfer's recipient, the upgrade's owner), so
  // asking would burn a DB roundtrip on an answer nothing reads.
  const [containerName, actorName, recipientAlreadyIn] = await Promise.all([
    readContainerName(detail.container),
    readDisplayName(detail.actorUserId),
    INVITE_KINDS.has(found.kind)
      ? alreadyHasOffer(detail.container, detail.recipientUserId, detail.role)
      : Promise.resolve(false),
  ]);

  const state = decideState({
    kind: found.kind,
    status: found.status,
    deleted: found.deleted,
    expiresAt: found.expiresAt,
    recipientAlreadyIn,
  });

  const isRecipient = detail.recipientUserId === viewerUserId;

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
    isRecipient,
    windowDays: windowDaysOf(found.createdAt, found.expiresAt),
    // The one state with somewhere to send you, and only to the person whose
    // own membership is what put it in that state.
    destination:
      state === "already_member" && isRecipient
        ? await redirectFor(detail.container)
        : null,
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
 * Whether an invitation has anything left to give its recipient.
 *
 * Holding a row is not the question — holding AT LEAST what is on offer is.
 * Opening a `studio`-visible project from the studio list materializes a
 * baseline `viewer` row (`project.service.ts:loadForViewer`), so a recipient who
 * merely looked at the project before answering would otherwise have their
 * pending EDITOR invite ruled moot: they never got what was offered, they
 * cannot answer, and re-inviting is refused as already-a-member. Accepting
 * upserts the row (`projectInvite.service.ts:251`), so a lower-ranked member
 * answering yes is exactly the upgrade the invite was for.
 * @param container - Which studio or project.
 * @param userId - The recipient.
 * @param offeredRole - The role the invite would grant.
 * @returns True when their current role already matches or outranks the offer.
 */
async function alreadyHasOffer(
  container: RequestDetail["container"],
  userId: string,
  offeredRole: string | null,
): Promise<boolean> {
  if (userId === "") return false;
  const held =
    container.kind === "studio"
      ? await studioMembersRepo.getRole(container.id, userId)
      : await projectMembersRepo.getRole(container.id, userId);
  if (held === null) return false;
  // An invite with no role on it offers plain membership, which any row covers.
  if (offeredRole === null) return true;
  const ranks: Record<string, number | undefined> =
    container.kind === "studio" ? STUDIO_ROLE_RANK : ROLE_RANK;
  const heldRank = ranks[held];
  const offeredRank = ranks[offeredRole];
  // An unrecognized role on either side is not something to reason about; treat
  // the row as covering it rather than inventing an order.
  if (heldRank === undefined || offeredRank === undefined) return true;
  return heldRank >= offeredRank;
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

  const detail = await decisionRepo.readDetail(found.kind, found.id);
  if (!detail) throw new NotFoundError(t("server.error.not_found"));

  // Membership is asked about the request's OWN recipient, not the caller, so
  // it can be resolved before we know who is calling. Only the invite flows
  // have the question at all.
  const recipientAlreadyIn = INVITE_KINDS.has(found.kind)
    ? await alreadyHasOffer(detail.container, detail.recipientUserId, detail.role)
    : false;
  const state = decideState({
    kind: found.kind,
    status: found.status,
    deleted: found.deleted,
    expiresAt: found.expiresAt,
    recipientAlreadyIn,
  });

  // A deleted container closes the request for everybody, so it answers before
  // we ask who is calling — and it must, because the role upgrade's recipient
  // is the project's CURRENT owner, unresolvable once the project is deleted.
  // Checking the recipient first would answer the person who actually was
  // asked with "you are not the recipient", which is false. The landing page
  // puts its `gone` card ahead of the audience check for the same reason.
  if (state === "gone") {
    throw new ConflictError(t("server.error.conflict"));
  }

  if (detail.recipientUserId !== viewerUserId) {
    throw new ForbiddenError(t("server.error.forbidden"));
  }

  if (state !== "answerable") {
    throw new ConflictError(t("server.error.conflict"));
  }

  await settle(found.kind, found.id, viewerUserId, action);

  return {
    state: action === "confirm" ? "accepted" : "declined",
    redirectTo: action === "confirm" ? await redirectFor(detail.container) : null,
  };
}
