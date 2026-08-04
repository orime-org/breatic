// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Finding the one request a share token names.
 *
 * The five flows keep their own tables, and each keeps its own status
 * vocabulary and its own foreign keys — nothing here tries to merge them. What
 * this module does is narrower: it answers "which table, which row" so the
 * layers above can stop caring where a request came from.
 *
 * The lookup deliberately does NOT filter soft-deleted rows. When a project is
 * deleted its pending requests are soft-deleted with it, and the person holding
 * the emailed link still deserves to be told the thing is gone rather than that
 * their link was never real. Callers get `deleted` and decide what to say.
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
import type { DecisionKind } from "@breatic/shared";

/** Bare identity of the request a token resolved to. */
export interface ResolvedRequest {
  kind: DecisionKind;
  id: string;
  /** The row's own status word, in that table's vocabulary. */
  status: string;
  /** Whether the row was soft-deleted, normally along with its container. */
  deleted: boolean;
  /** When the request was filed — with `expiresAt`, it derives the window. */
  createdAt: Date;
  /** When the answering window closes. */
  expiresAt: Date;
}

/**
 * Every table a token could be in, paired with the kind it means.
 *
 * Kept as data rather than five hand-written branches: a sixth flow is a line
 * here, and "did we remember to search that table" stops being a question you
 * answer by reading code.
 */
const SOURCES = [
  { kind: "studio_invite", table: studioInvitations },
  { kind: "project_invite", table: projectInvitations },
  { kind: "role_upgrade", table: roleUpgradeRequests },
  { kind: "project_transfer", table: projectTransfers },
  { kind: "studio_transfer", table: studioTransfers },
] as const satisfies ReadonlyArray<{ kind: DecisionKind; table: unknown }>;

/**
 * Resolves a share token to the request it names.
 *
 * Searches every request table. Tokens are 32 random bytes with a unique index
 * per table, so a collision across two tables is not a case worth handling: the
 * first match wins and there will not be a second.
 * @param token - The `share_token` from a decision link.
 * @returns The request it names, or null when no table has it.
 */
export async function resolveByToken(
  token: string,
): Promise<ResolvedRequest | null> {
  if (token === "") return null;

  for (const source of SOURCES) {
    const rows = await db
      .select({
        id: source.table.id,
        status: source.table.status,
        deletedAt: source.table.deletedAt,
        createdAt: source.table.createdAt,
        expiresAt: source.table.expiresAt,
      })
      .from(source.table)
      .where(eq(source.table.shareToken, token))
      .limit(1);

    const row = rows[0];
    if (!row) continue;

    return {
      kind: source.kind,
      id: row.id,
      status: row.status,
      deleted: row.deletedAt !== null,
      createdAt: row.createdAt,
      expiresAt: row.expiresAt,
    };
  }

  return null;
}

/**
 * The parts of a request that differ by flow, once the flow-specific column
 * names are behind us.
 */
export interface RequestDetail {
  /** The studio or project being decided about. */
  container: { kind: "studio" | "project"; id: string };
  /** Who set it in motion. */
  actorUserId: string;
  /** Who is being asked. */
  recipientUserId: string;
  role: string | null;
  message: string | null;
}

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
export async function readDetail(
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
