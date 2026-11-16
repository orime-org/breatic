// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * External-agent access (#1488): whether a credential or connection is still
 * usable, the connections a user sees, personal access tokens, and revoking.
 *
 * Collab and server both ask here, so the answer is the same everywhere. Every
 * check compares expiry against the caller's `now`, which defaults to the
 * current time. A grant is usable while its record is live and it holds at
 * least one live token (an unconsumed refresh token, or an access token for a
 * client that never asked for refresh tokens); a connection row, once deleted,
 * ends every credential under it.
 */

import crypto from "node:crypto";
import type { AgentConnectionEntity, AgentConnectionKind } from "@breatic/shared";
import { lockAccountRow } from "@core/auth/membership.repo.js";
import { getMcpConfig } from "@core/config/mcp.js";
import { db } from "@core/db/client.js";
import * as connectionsRepo from "@core/agent-access/agent-connections.repo.js";
import * as oauthRecordsRepo from "@core/agent-access/oauth-records.repo.js";
import * as tokensRepo from "@core/agent-access/personal-access-tokens.repo.js";

/** A credential an external agent presents. */
export type AgentCredential = { type: "oauth"; grantId: string } | { type: "pat"; tokenId: string };

/** One row of a user's connected agents, as the settings page lists it. */
export interface AgentConnectionView {
  id: string;
  kind: AgentConnectionKind;
  displayName: string;
  createdAt: Date;
  lastUsedAt: Date | null;
  /** Expired: no usable grant (OAuth) or the token passed its expiry (pat). */
  status: "active" | "expired";
  /** Personal access tokens only. */
  tokenPrefix?: string;
  /** Personal access tokens only; null never expires. */
  expiresAt?: Date | null;
}

/** The answer to creating a personal access token; the plaintext is never readable again. */
export type CreatePersonalAccessTokenResult =
  | { ok: true; token: string; tokenId: string; connectionId: string }
  | { ok: false; reason: "limit_reached" };

/** Marks a plaintext as a breatic personal access token. */
const TOKEN_MARKER = "brt_";

/** How many plaintext characters are kept to tell tokens apart. */
const TOKEN_PREFIX_LENGTH = 8;

/**
 * SHA-256 hex of a plaintext token.
 * @param token - The plaintext.
 * @returns The hex digest.
 */
function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

/**
 * Whether a credential still works: an OAuth grant is usable and its
 * connection row is live; a personal access token is active and its row is live.
 * @param credential - The grant or token.
 * @param now - The caller's clock.
 * @returns True while it may be used.
 * @throws {Error} When the database read fails.
 */
export async function isCredentialUsable(credential: AgentCredential, now: Date = new Date()): Promise<boolean> {
  if (credential.type === "pat") {
    if (!(await tokensRepo.isActive(credential.tokenId, now))) return false;
    return (await connectionsRepo.findLivePat(credential.tokenId)) !== undefined;
  }
  return (await findUsableOAuthConnection(credential.grantId, now)) !== null;
}

/**
 * The live connection row of a usable OAuth grant.
 * @param grantId - The grant.
 * @param now - The caller's clock.
 * @returns The row, or null unless the grant is usable and its row live.
 * @throws {Error} When the database read fails.
 */
export async function findUsableOAuthConnection(grantId: string, now: Date = new Date()): Promise<AgentConnectionEntity | null> {
  const [grant] = await oauthRecordsRepo.usableGrants({ grantId }, now);
  if (!grant?.accountId || !grant.clientId) return null;
  return (await connectionsRepo.findLiveOAuth(grant.accountId, grant.clientId)) ?? null;
}

/**
 * Whether a connection row still works: it is live, and its token is active
 * (pat) or at least one grant of its user and client is usable (OAuth).
 * @param connectionId - The row id.
 * @param now - The caller's clock.
 * @returns True while the agent behind it may act.
 * @throws {Error} When the database read fails.
 */
export async function isConnectionUsable(connectionId: string, now: Date = new Date()): Promise<boolean> {
  const row = await connectionsRepo.findLive(connectionId);
  if (!row) return false;
  return rowIsUsable(row, now);
}

/**
 * The usability of a live row, by its kind.
 * @param row - The live row.
 * @param now - The caller's clock.
 * @returns True while usable.
 * @throws {Error} When the database read fails.
 */
async function rowIsUsable(row: AgentConnectionEntity, now: Date): Promise<boolean> {
  if (row.kind === "pat") return tokensRepo.isActive(row.clientKey, now);
  return (await oauthRecordsRepo.usableGrants({ accountId: row.userId, clientId: row.clientKey }, now)).length > 0;
}

/**
 * The live row for a user's OAuth client, made on first authorization. Two
 * authorizations arriving together get the same row: the partial unique index
 * lets one insert win and the other reads it back.
 * @param input - The user, client kind, client id and the name to show.
 * @param input.userId - The user who authorized.
 * @param input.kind - How the client registered.
 * @param input.clientKey - The OAuth client id.
 * @param input.displayName - The name the user sees.
 * @returns The live row.
 * @throws {Error} When the database fails, or the row vanished between insert and read.
 */
export async function ensureOAuthConnection(input: {
  userId: string;
  kind: "cimd" | "dcr";
  clientKey: string;
  displayName: string;
}): Promise<AgentConnectionEntity> {
  const existing = await connectionsRepo.findLiveOAuth(input.userId, input.clientKey);
  if (existing) return existing;
  const inserted = await connectionsRepo.insert(input);
  if (inserted) return inserted;
  const winner = await connectionsRepo.findLiveOAuth(input.userId, input.clientKey);
  if (!winner) throw new Error(`agent connection for client ${input.clientKey} vanished after a conflicting insert`);
  return winner;
}

/**
 * A user's live connections with their status; deleted rows are never listed.
 * @param userId - The user.
 * @param now - The caller's clock.
 * @returns The rows, newest first.
 * @throws {Error} When the database read fails.
 */
export async function listConnections(userId: string, now: Date = new Date()): Promise<AgentConnectionView[]> {
  const rows = await connectionsRepo.listLive(userId);
  const usableClients = new Set((await oauthRecordsRepo.usableGrants({ accountId: userId }, now)).map((g) => g.clientId));
  const tokens = new Map(
    (await tokensRepo.findByIds(rows.filter((r) => r.kind === "pat").map((r) => r.clientKey))).map((t) => [t.id, t]),
  );
  return rows.map((row) => {
    const base = { id: row.id, kind: row.kind, displayName: row.displayName, createdAt: row.createdAt, lastUsedAt: row.lastUsedAt };
    if (row.kind !== "pat") return { ...base, status: usableClients.has(row.clientKey) ? "active" : "expired" };
    const token = tokens.get(row.clientKey);
    const active = token !== undefined && token.deletedAt === null && (token.expiresAt === null || token.expiresAt > now);
    return { ...base, status: active ? "active" : "expired", tokenPrefix: token?.tokenPrefix ?? "", expiresAt: token?.expiresAt ?? null };
  });
}

/**
 * Renames one of the user's own live rows. The name is stored as given; the
 * route validates it.
 * @param connectionId - The row id.
 * @param userId - The user asking.
 * @param name - The new name.
 * @returns False unless it is the user's own live row.
 * @throws {Error} When the database write fails.
 */
export async function rename(connectionId: string, userId: string, name: string): Promise<boolean> {
  return connectionsRepo.rename(connectionId, userId, name);
}

/**
 * Names of rows, deleted ones included, so history can still say who acted.
 * @param ids - The row ids.
 * @returns One entry per row found; unknown ids are left out.
 * @throws {Error} When the database read fails.
 */
export async function connectionNames(ids: readonly string[]): Promise<Array<{ id: string; name: string }>> {
  return connectionsRepo.names(ids);
}

/**
 * Records a use on the row, and on its token for a personal access token.
 * @param connectionId - The row id.
 * @param at - When it was used.
 * @throws {Error} When the database write fails.
 */
export async function recordUse(connectionId: string, at: Date): Promise<void> {
  const row = await connectionsRepo.touch(connectionId, at);
  if (row?.kind === "pat") await tokensRepo.touch(row.clientKey, at);
}

/**
 * Creates a personal access token and its own connection row. The plaintext
 * is returned once; only its SHA-256 and first 8 characters are stored. At
 * most `pat.max_active_per_user` tokens are active per user: the count runs
 * under the user's row lock, so concurrent creates cannot both take the last slot.
 * @param input - The user, the token's name and its expiry (null never expires).
 * @param input.userId - The user.
 * @param input.name - The token's name, also its row's name.
 * @param input.expiresAt - When it expires; null never.
 * @param now - The caller's clock.
 * @returns The token, or `limit_reached` at the cap.
 * @throws {Error} When the user is gone or the database fails.
 */
export async function createPersonalAccessToken(
  input: { userId: string; name: string; expiresAt: Date | null },
  now: Date = new Date(),
): Promise<CreatePersonalAccessTokenResult> {
  const cap = getMcpConfig().pat.max_active_per_user;
  return db.transaction(async (tx) => {
    await lockAccountRow(input.userId, tx);
    if ((await tokensRepo.countActive(input.userId, now)) >= cap) return { ok: false, reason: "limit_reached" };
    const token = `${TOKEN_MARKER}${crypto.randomBytes(32).toString("base64url")}`;
    const stored = await tokensRepo.insert({
      userId: input.userId,
      name: input.name,
      tokenHash: hashToken(token),
      tokenPrefix: token.slice(0, TOKEN_PREFIX_LENGTH),
      expiresAt: input.expiresAt,
    });
    const row = await connectionsRepo.insert({ userId: input.userId, kind: "pat", clientKey: stored.id, displayName: input.name });
    if (!row) throw new Error(`connection row for token ${stored.id} was not inserted`);
    return { ok: true, token, tokenId: stored.id, connectionId: row.id };
  });
}

/**
 * Finds the active token a plaintext names.
 * @param plaintext - What the agent presented.
 * @param now - The caller's clock.
 * @returns The token, its user and its row, or null unless the token and its row are both live.
 * @throws {Error} When the database read fails.
 */
export async function findPersonalAccessToken(
  plaintext: string,
  now: Date = new Date(),
): Promise<{ tokenId: string; userId: string; connectionId: string } | null> {
  const token = await tokensRepo.findActiveByHash(hashToken(plaintext), now);
  if (!token) return null;
  const row = await connectionsRepo.findLivePat(token.id);
  return row ? { tokenId: token.id, userId: token.userId, connectionId: row.id } : null;
}

/**
 * Disconnects one of the user's own live rows: ends every grant under it
 * (OAuth) or its token (pat), then deletes the row, in one transaction.
 * @param connectionId - The row id.
 * @param userId - The user asking.
 * @returns The credentials ended, for the caller to cut off live sessions; null unless it is the user's own live row.
 * @throws {Error} When the database write fails.
 */
export async function disconnect(connectionId: string, userId: string): Promise<{ revoked: AgentCredential[] } | null> {
  return db.transaction(async () => {
    const row = await connectionsRepo.findLive(connectionId, userId, true);
    if (!row) return null;
    const revoked: AgentCredential[] = [];
    if (row.kind === "pat") {
      await tokensRepo.softDelete(row.clientKey);
      revoked.push({ type: "pat", tokenId: row.clientKey });
    } else {
      for (const grantId of await oauthRecordsRepo.grantIdsOf(row.userId, row.clientKey)) {
        await oauthRecordsRepo.destroy("Grant", grantId);
        await oauthRecordsRepo.revokeByGrantId(grantId);
        revoked.push({ type: "oauth", grantId });
      }
    }
    await connectionsRepo.softDelete(row.id);
    return { revoked };
  });
}

/**
 * Ends one grant and its tokens. A client revoking its own grant deletes the
 * row once no usable grant is left on it; a refresh token reuse caught at the
 * token endpoint never deletes the row, which then reads expired until the
 * user authorizes again.
 * @param grantId - The grant.
 * @param source - Who ended it.
 * @param now - The caller's clock.
 * @returns The grant's row, and whether it was deleted; no row for an unknown grant.
 * @throws {Error} When the database write fails.
 */
export async function revokeGrant(
  grantId: string,
  source: "client_revoked" | "reuse_detected",
  now: Date = new Date(),
): Promise<{ connectionId: string | null; connectionDeleted: boolean }> {
  return db.transaction(async () => {
    const owner = await oauthRecordsRepo.grantOwner(grantId);
    if (!owner) return { connectionId: null, connectionDeleted: false };
    const row = owner.accountId && owner.clientId
      ? await connectionsRepo.findLiveOAuth(owner.accountId, owner.clientId, true)
      : undefined;
    await oauthRecordsRepo.destroy("Grant", grantId);
    await oauthRecordsRepo.revokeByGrantId(grantId);
    if (!row) return { connectionId: null, connectionDeleted: false };
    if (source === "reuse_detected" || (await rowIsUsable(row, now))) return { connectionId: row.id, connectionDeleted: false };
    await connectionsRepo.softDelete(row.id);
    return { connectionId: row.id, connectionDeleted: true };
  });
}
