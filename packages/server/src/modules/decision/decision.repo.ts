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
      expiresAt: row.expiresAt,
    };
  }

  return null;
}
