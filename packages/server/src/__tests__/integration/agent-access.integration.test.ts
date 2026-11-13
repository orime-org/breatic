// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * External-agent access in core (#1488 §5, §15.2, §15.3, §15.7), against a
 * real database.
 *
 * What it pins:
 * - `oauthRecordsRepo`, the store behind server's oidc-provider adapter: one
 *   record per model and id, expiry read against the caller's clock,
 *   consumption recorded once, soft delete by id and by grant.
 * - `agentAccessService.isCredentialUsable`: a grant is usable while it is
 *   live, holds at least one live token (refresh or access) and its
 *   connection row is not deleted; a personal access token while it is
 *   neither revoked nor expired. Collab asks this before running every
 *   command.
 * - connections: one live row per user and OAuth client id, a new row after
 *   it is deleted, status derived from its grants or its token, names kept
 *   for deleted rows, renaming only one's own live rows.
 * - personal access tokens: the plaintext is returned once and only its
 *   SHA-256 is stored, each token is its own connection, and a user holds at
 *   most `pat.max_active_per_user` active ones, also under concurrent creates.
 * - revoking: disconnect ends every grant or the token under a row and
 *   deletes the row; a client's own revocation ends one grant and deletes the
 *   row only when no usable grant is left; a reuse detected at the token
 *   endpoint keeps the row, which then reads expired.
 */

import { describe, it, expect, beforeAll, afterAll, inject } from "vitest";
import crypto from "node:crypto";
import postgres from "postgres";
import { initCore, agentAccessService, oauthRecordsRepo, getMcpConfig } from "@breatic/core";

import { waitUntilBlockedOn } from "./lock-probe.js";

try {
  initCore(process.env);
} catch {
  // already initialised by a sibling suite in this worker — fine.
}

let sql: ReturnType<typeof postgres>;

beforeAll(() => {
  sql = postgres(inject("DATABASE_URL"), { max: 4, prepare: false, connection: { application_name: "agent-access-test" } });
});

afterAll(async () => {
  await sql?.end({ timeout: 1 });
});

let seq = 0;

/**
 * Inserts a user.
 * @returns The user's id.
 */
async function insertUser(): Promise<string> {
  const tag = `agent-access-${Date.now()}-${seq++}`;
  const [user] = await sql<{ id: string }[]>`
    INSERT INTO users (email, email_verified) VALUES (${`${tag}@example.com`}, true) RETURNING id
  `;
  return user!.id;
}

/**
 * A random oidc-provider style record id.
 * @returns The id.
 */
function recordId(): string {
  return crypto.randomBytes(16).toString("base64url");
}

/**
 * Stores what oidc-provider stores when a user authorizes a client: the
 * grant, plus the tokens asked for.
 * @param userId - The user who authorized.
 * @param clientId - The client's id, which is the connection's client key.
 * @param tokens - Which tokens the grant holds, and their lifetimes in seconds.
 * @returns The grant id and the token record ids.
 */
async function authorize(
  userId: string,
  clientId: string,
  tokens: { refresh?: number; access?: number; grant?: number } = { refresh: 3600, access: 3600 },
): Promise<{ grantId: string; refreshId: string | null; accessId: string | null }> {
  const grantId = recordId();
  await oauthRecordsRepo.upsert("Grant", grantId, { kind: "Grant", jti: grantId, accountId: userId, clientId }, tokens.grant ?? 365 * 24 * 3600);
  let refreshId: string | null = null;
  let accessId: string | null = null;
  if (tokens.refresh !== undefined) {
    refreshId = recordId();
    await oauthRecordsRepo.upsert("RefreshToken", refreshId, { kind: "RefreshToken", jti: refreshId, accountId: userId, clientId, grantId }, tokens.refresh);
  }
  if (tokens.access !== undefined) {
    accessId = recordId();
    await oauthRecordsRepo.upsert("AccessToken", accessId, { kind: "AccessToken", jti: accessId, accountId: userId, clientId, grantId }, tokens.access);
  }
  return { grantId, refreshId, accessId };
}

/**
 * Authorizes a client and records its connection row, as the consent step does.
 * @param userId - The user who authorized.
 * @param clientId - The client id.
 * @param tokens - The tokens the grant holds.
 * @returns The connection id and grant.
 */
async function connect(
  userId: string,
  clientId: string,
  tokens?: { refresh?: number; access?: number; grant?: number },
): Promise<{ connectionId: string; grantId: string; refreshId: string | null; accessId: string | null }> {
  const connection = await agentAccessService.ensureOAuthConnection({ userId, kind: "cimd", clientKey: clientId, displayName: "Claude Code" });
  return { connectionId: connection.id, ...(await authorize(userId, clientId, tokens)) };
}

/**
 * The time `seconds` from now.
 * @param seconds - How far ahead.
 * @returns The instant.
 */
function inSeconds(seconds: number): Date {
  return new Date(Date.now() + seconds * 1000);
}

describe("oauthRecordsRepo", () => {
  it("returns what was stored under the model and id, and nothing under another model", async () => {
    const id = recordId();
    await oauthRecordsRepo.upsert("Session", id, { kind: "Session", uid: "u-1", accountId: "acc" }, 600);
    expect((await oauthRecordsRepo.find("Session", id))?.payload).toEqual({ kind: "Session", uid: "u-1", accountId: "acc" });
    expect(await oauthRecordsRepo.find("Interaction", id)).toBeUndefined();
  });

  it("replaces the payload when the same record is stored again", async () => {
    const id = recordId();
    await oauthRecordsRepo.upsert("Interaction", id, { kind: "Interaction", uid: "a" }, 600);
    await oauthRecordsRepo.upsert("Interaction", id, { kind: "Interaction", uid: "b" }, 600);
    expect((await oauthRecordsRepo.find("Interaction", id))?.payload).toEqual({ kind: "Interaction", uid: "b" });
  });

  it("finds a record by its uid", async () => {
    const id = recordId();
    const uid = recordId();
    await oauthRecordsRepo.upsert("Session", id, { kind: "Session", uid }, 600);
    expect((await oauthRecordsRepo.findByUid("Session", uid))?.payload).toMatchObject({ uid });
    expect(await oauthRecordsRepo.findByUid("Session", recordId())).toBeUndefined();
  });

  it("stops returning a record once its lifetime has passed on the caller's clock", async () => {
    const id = recordId();
    await oauthRecordsRepo.upsert("AuthorizationCode", id, { kind: "AuthorizationCode" }, 60);
    expect(await oauthRecordsRepo.find("AuthorizationCode", id, inSeconds(30))).toBeDefined();
    expect(await oauthRecordsRepo.find("AuthorizationCode", id, inSeconds(120))).toBeUndefined();
  });

  it("records the first consumption only, and hands its time back", async () => {
    const id = recordId();
    await oauthRecordsRepo.upsert("RefreshToken", id, { kind: "RefreshToken" }, 600);
    expect((await oauthRecordsRepo.find("RefreshToken", id))?.consumedAt).toBeNull();
    await oauthRecordsRepo.consume("RefreshToken", id);
    const first = (await oauthRecordsRepo.find("RefreshToken", id))?.consumedAt;
    expect(first).toBeInstanceOf(Date);
    await new Promise((r) => setTimeout(r, 20));
    await oauthRecordsRepo.consume("RefreshToken", id);
    expect((await oauthRecordsRepo.find("RefreshToken", id))?.consumedAt?.getTime()).toBe(first!.getTime());
  });

  it("soft-deletes a destroyed record: it is no longer found, the row stays", async () => {
    const id = recordId();
    await oauthRecordsRepo.upsert("Session", id, { kind: "Session" }, 600);
    await oauthRecordsRepo.destroy("Session", id);
    expect(await oauthRecordsRepo.find("Session", id)).toBeUndefined();
    const rows = await sql`SELECT deleted_at FROM oauth_records WHERE model = 'Session' AND record_id = ${id}`;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.deleted_at).not.toBeNull();
  });

  it("revokes every token of one grant and leaves other grants' tokens alone", async () => {
    const user = await insertUser();
    const a = await authorize(user, `client-${recordId()}`);
    const b = await authorize(user, `client-${recordId()}`);
    await oauthRecordsRepo.revokeByGrantId(a.grantId);
    expect(await oauthRecordsRepo.find("RefreshToken", a.refreshId!)).toBeUndefined();
    expect(await oauthRecordsRepo.find("AccessToken", a.accessId!)).toBeUndefined();
    expect(await oauthRecordsRepo.find("RefreshToken", b.refreshId!)).toBeDefined();
    expect(await oauthRecordsRepo.find("AccessToken", b.accessId!)).toBeDefined();
  });
});

describe("isCredentialUsable — OAuth grants", () => {
  it("is usable while the grant holds a live refresh token", async () => {
    const user = await insertUser();
    const { grantId } = await connect(user, `client-${recordId()}`, { refresh: 3600 });
    expect(await agentAccessService.isCredentialUsable({ type: "oauth", grantId })).toBe(true);
  });

  it("is usable while the grant holds only a live access token, for a client that never asked for refresh tokens", async () => {
    const user = await insertUser();
    const { grantId } = await connect(user, `client-${recordId()}`, { access: 3600 });
    expect(await agentAccessService.isCredentialUsable({ type: "oauth", grantId })).toBe(true);
    expect(await agentAccessService.isCredentialUsable({ type: "oauth", grantId }, inSeconds(7200))).toBe(false);
  });

  it("is not usable once every token of the grant has expired", async () => {
    const user = await insertUser();
    const { grantId } = await connect(user, `client-${recordId()}`, { refresh: 60, access: 30 });
    expect(await agentAccessService.isCredentialUsable({ type: "oauth", grantId }, inSeconds(90))).toBe(false);
  });

  it("does not count a refresh token that was consumed by a rotation", async () => {
    const user = await insertUser();
    const { grantId, refreshId } = await connect(user, `client-${recordId()}`, { refresh: 3600 });
    await oauthRecordsRepo.consume("RefreshToken", refreshId!);
    expect(await agentAccessService.isCredentialUsable({ type: "oauth", grantId })).toBe(false);
  });

  it("is not usable once the grant itself has expired, whatever tokens it holds", async () => {
    const user = await insertUser();
    const { grantId } = await connect(user, `client-${recordId()}`, { refresh: 7200, access: 7200, grant: 60 });
    expect(await agentAccessService.isCredentialUsable({ type: "oauth", grantId }, inSeconds(120))).toBe(false);
  });

  it("is not usable once the grant record is destroyed", async () => {
    const user = await insertUser();
    const { grantId } = await connect(user, `client-${recordId()}`);
    await oauthRecordsRepo.destroy("Grant", grantId);
    expect(await agentAccessService.isCredentialUsable({ type: "oauth", grantId })).toBe(false);
  });

  it("is not usable once its connection row is deleted", async () => {
    const user = await insertUser();
    const { grantId, connectionId } = await connect(user, `client-${recordId()}`);
    await agentAccessService.disconnect(connectionId, user);
    expect(await agentAccessService.isCredentialUsable({ type: "oauth", grantId })).toBe(false);
  });

  it("is not usable for a grant id nobody issued", async () => {
    expect(await agentAccessService.isCredentialUsable({ type: "oauth", grantId: recordId() })).toBe(false);
  });
});

describe("connections", () => {
  it("returns the same live row when a user authorizes the same client again", async () => {
    const user = await insertUser();
    const clientKey = `client-${recordId()}`;
    const first = await agentAccessService.ensureOAuthConnection({ userId: user, kind: "cimd", clientKey, displayName: "Claude Code" });
    const second = await agentAccessService.ensureOAuthConnection({ userId: user, kind: "cimd", clientKey, displayName: "Claude Code" });
    expect(second.id).toBe(first.id);
  });

  it("returns one row for two authorizations of the same client arriving together", async () => {
    const user = await insertUser();
    const clientKey = `client-${recordId()}`;
    const [a, b] = await Promise.all([
      agentAccessService.ensureOAuthConnection({ userId: user, kind: "dcr", clientKey, displayName: "Cursor" }),
      agentAccessService.ensureOAuthConnection({ userId: user, kind: "dcr", clientKey, displayName: "Cursor" }),
    ]);
    expect(a.id).toBe(b.id);
    const rows = await sql`SELECT id FROM agent_connections WHERE user_id = ${user} AND deleted_at IS NULL`;
    expect(rows).toHaveLength(1);
  });

  it("keeps two users' rows for the same client apart", async () => {
    const clientKey = `client-${recordId()}`;
    const a = await agentAccessService.ensureOAuthConnection({ userId: await insertUser(), kind: "cimd", clientKey, displayName: "X" });
    const b = await agentAccessService.ensureOAuthConnection({ userId: await insertUser(), kind: "cimd", clientKey, displayName: "X" });
    expect(a.id).not.toBe(b.id);
  });

  it("makes a new row when the client is authorized again after the row was deleted", async () => {
    const user = await insertUser();
    const clientKey = `client-${recordId()}`;
    const first = await connect(user, clientKey);
    await agentAccessService.disconnect(first.connectionId, user);
    const again = await agentAccessService.ensureOAuthConnection({ userId: user, kind: "cimd", clientKey, displayName: "Claude Code" });
    expect(again.id).not.toBe(first.connectionId);
  });

  it("lists a row as active while one of its grants is usable, expired when none is, and never lists a deleted row", async () => {
    const user = await insertUser();
    const live = await connect(user, `client-${recordId()}`, { refresh: 3600 });
    const lapsing = await connect(user, `client-${recordId()}`, { refresh: 60 });
    const gone = await connect(user, `client-${recordId()}`);
    await agentAccessService.disconnect(gone.connectionId, user);

    const rows = await agentAccessService.listConnections(user, inSeconds(120));
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get(live.connectionId)?.status).toBe("active");
    expect(byId.get(lapsing.connectionId)?.status).toBe("expired");
    expect(byId.has(gone.connectionId)).toBe(false);
    expect(byId.get(live.connectionId)).toMatchObject({ kind: "cimd", displayName: "Claude Code" });
  });

  it("brings an expired row back to active when the same client is authorized again", async () => {
    const user = await insertUser();
    const clientKey = `client-${recordId()}`;
    const first = await connect(user, clientKey, { refresh: 60 });
    expect(await agentAccessService.isConnectionUsable(first.connectionId, inSeconds(120))).toBe(false);
    const again = await connect(user, clientKey, { refresh: 3600 });
    expect(again.connectionId).toBe(first.connectionId);
    expect(await agentAccessService.isConnectionUsable(first.connectionId, inSeconds(120))).toBe(true);
  });

  it("renames only the user's own live row", async () => {
    const user = await insertUser();
    const other = await insertUser();
    const { connectionId } = await connect(user, `client-${recordId()}`);
    expect(await agentAccessService.rename(connectionId, other, "Stolen")).toBe(false);
    expect(await agentAccessService.rename(connectionId, user, "Laptop")).toBe(true);
    expect((await agentAccessService.listConnections(user)).find((r) => r.id === connectionId)?.displayName).toBe("Laptop");
    await agentAccessService.disconnect(connectionId, user);
    expect(await agentAccessService.rename(connectionId, user, "Again")).toBe(false);
  });

  it("gives names for the ids asked, deleted rows included, and nothing for unknown ids", async () => {
    const user = await insertUser();
    const live = await connect(user, `client-${recordId()}`);
    const gone = await connect(user, `client-${recordId()}`);
    await agentAccessService.rename(gone.connectionId, user, "Old desktop");
    await agentAccessService.disconnect(gone.connectionId, user);
    const names = await agentAccessService.connectionNames([live.connectionId, gone.connectionId, crypto.randomUUID()]);
    expect(names).toEqual(
      expect.arrayContaining([
        { id: live.connectionId, name: "Claude Code" },
        { id: gone.connectionId, name: "Old desktop" },
      ]),
    );
    expect(names).toHaveLength(2);
  });

  it("records the last use on the row", async () => {
    const user = await insertUser();
    const { connectionId } = await connect(user, `client-${recordId()}`);
    const at = new Date(Date.now() + 5000);
    await agentAccessService.recordUse(connectionId, at);
    expect((await agentAccessService.listConnections(user)).find((r) => r.id === connectionId)?.lastUsedAt?.getTime()).toBe(at.getTime());
  });
});

describe("personal access tokens", () => {
  it("returns the plaintext once, stores only its SHA-256 and its first 8 characters", async () => {
    const user = await insertUser();
    const created = await agentAccessService.createPersonalAccessToken({ userId: user, name: "Harness", expiresAt: inSeconds(3600) });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const hash = crypto.createHash("sha256").update(created.token).digest("hex");
    const rows = await sql`SELECT * FROM personal_access_tokens WHERE id = ${created.tokenId}`;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.token_hash).toBe(hash);
    expect(rows[0]!.token_prefix).toBe(created.token.slice(0, 8));
    expect(JSON.stringify(rows[0])).not.toContain(created.token);
  });

  it("makes each token its own connection, named after the token", async () => {
    const user = await insertUser();
    const a = await agentAccessService.createPersonalAccessToken({ userId: user, name: "Harness A", expiresAt: null });
    const b = await agentAccessService.createPersonalAccessToken({ userId: user, name: "Harness A", expiresAt: null });
    if (!a.ok || !b.ok) throw new Error("expected both tokens to be created");
    expect(a.connectionId).not.toBe(b.connectionId);
    const rows = await agentAccessService.listConnections(user);
    const tokens = rows.filter((r) => r.kind === "pat");
    expect(tokens.map((r) => r.id).sort()).toEqual([a.connectionId, b.connectionId].sort());
    expect(tokens.every((r) => r.displayName === "Harness A")).toBe(true);
  });

  it("finds a token by its plaintext while it is active, and not by a wrong one", async () => {
    const user = await insertUser();
    const created = await agentAccessService.createPersonalAccessToken({ userId: user, name: "Harness", expiresAt: inSeconds(3600) });
    if (!created.ok) throw new Error("expected the token to be created");
    expect(await agentAccessService.findPersonalAccessToken(created.token)).toEqual({
      tokenId: created.tokenId,
      userId: user,
      connectionId: created.connectionId,
    });
    expect(await agentAccessService.findPersonalAccessToken(`${created.token}x`)).toBeNull();
    expect(await agentAccessService.findPersonalAccessToken(created.token, inSeconds(7200))).toBeNull();
  });

  it("is usable until it expires, and a token with no expiry stays usable", async () => {
    const user = await insertUser();
    const expiring = await agentAccessService.createPersonalAccessToken({ userId: user, name: "A", expiresAt: inSeconds(3600) });
    const forever = await agentAccessService.createPersonalAccessToken({ userId: user, name: "B", expiresAt: null });
    if (!expiring.ok || !forever.ok) throw new Error("expected both tokens to be created");
    expect(await agentAccessService.isCredentialUsable({ type: "pat", tokenId: expiring.tokenId })).toBe(true);
    expect(await agentAccessService.isCredentialUsable({ type: "pat", tokenId: expiring.tokenId }, inSeconds(7200))).toBe(false);
    expect(await agentAccessService.isCredentialUsable({ type: "pat", tokenId: forever.tokenId }, inSeconds(10 * 365 * 24 * 3600))).toBe(true);
    const rows = await agentAccessService.listConnections(user, inSeconds(7200));
    expect(rows.find((r) => r.id === expiring.connectionId)?.status).toBe("expired");
    expect(rows.find((r) => r.id === forever.connectionId)?.status).toBe("active");
  });

  it("revokes through disconnect: the token stops working and its row leaves the list", async () => {
    const user = await insertUser();
    const created = await agentAccessService.createPersonalAccessToken({ userId: user, name: "Harness", expiresAt: null });
    if (!created.ok) throw new Error("expected the token to be created");
    const result = await agentAccessService.disconnect(created.connectionId, user);
    expect(result).toEqual({ revoked: [{ type: "pat", tokenId: created.tokenId }] });
    expect(await agentAccessService.isCredentialUsable({ type: "pat", tokenId: created.tokenId })).toBe(false);
    expect(await agentAccessService.findPersonalAccessToken(created.token)).toBeNull();
    expect((await agentAccessService.listConnections(user)).some((r) => r.id === created.connectionId)).toBe(false);
  });

  it("refuses a new token at the active cap, and does not count revoked or expired ones", async () => {
    const user = await insertUser();
    const cap = getMcpConfig().pat.max_active_per_user;
    const expired = await agentAccessService.createPersonalAccessToken({ userId: user, name: "old", expiresAt: inSeconds(1) });
    if (!expired.ok) throw new Error("expected the token to be created");
    await new Promise((r) => setTimeout(r, 1100));
    const revoked = await agentAccessService.createPersonalAccessToken({ userId: user, name: "revoked", expiresAt: null });
    if (!revoked.ok) throw new Error("expected the token to be created");
    await agentAccessService.disconnect(revoked.connectionId, user);
    for (let i = 0; i < cap; i++) {
      expect((await agentAccessService.createPersonalAccessToken({ userId: user, name: `t${i}`, expiresAt: null })).ok).toBe(true);
    }
    expect(await agentAccessService.createPersonalAccessToken({ userId: user, name: "one more", expiresAt: null })).toEqual({
      ok: false,
      reason: "limit_reached",
    });
  });

  it("holds the cap when two creates race for the last slot", async () => {
    const user = await insertUser();
    const cap = getMcpConfig().pat.max_active_per_user;
    for (let i = 0; i < cap - 1; i++) {
      await agentAccessService.createPersonalAccessToken({ userId: user, name: `t${i}`, expiresAt: null });
    }
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let locked!: () => void;
    const ready = new Promise<void>((r) => (locked = r));
    const holding = sql.begin(async (tx) => {
      await tx`SELECT id FROM users WHERE id = ${user} FOR UPDATE`;
      locked();
      await gate;
    });
    // Both creates must start behind the held row, so both park on it.
    await ready;
    const racing = Promise.all([
      agentAccessService.createPersonalAccessToken({ userId: user, name: "a", expiresAt: null }),
      agentAccessService.createPersonalAccessToken({ userId: user, name: "b", expiresAt: null }),
    ]);
    try {
      await waitUntilBlockedOn(sql, ["users", "for update"], 2);
    } finally {
      release();
      await holding;
    }
    const results = await racing;
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok)).toEqual([{ ok: false, reason: "limit_reached" }]);
  });
});

describe("revoking grants", () => {
  it("disconnect ends every grant under the row, returns them, and deletes the row", async () => {
    const user = await insertUser();
    const clientKey = `client-${recordId()}`;
    const first = await connect(user, clientKey);
    const second = await connect(user, clientKey);
    expect(second.connectionId).toBe(first.connectionId);

    const result = await agentAccessService.disconnect(first.connectionId, user);
    expect(result?.revoked).toEqual(
      expect.arrayContaining([
        { type: "oauth", grantId: first.grantId },
        { type: "oauth", grantId: second.grantId },
      ]),
    );
    expect(result?.revoked).toHaveLength(2);
    for (const g of [first, second]) {
      expect(await oauthRecordsRepo.find("Grant", g.grantId)).toBeUndefined();
      expect(await oauthRecordsRepo.find("RefreshToken", g.refreshId!)).toBeUndefined();
    }
    expect(await agentAccessService.isConnectionUsable(first.connectionId)).toBe(false);
  });

  it("disconnect does nothing to another user's row", async () => {
    const owner = await insertUser();
    const { connectionId, grantId } = await connect(owner, `client-${recordId()}`);
    expect(await agentAccessService.disconnect(connectionId, await insertUser())).toBeNull();
    expect(await agentAccessService.isCredentialUsable({ type: "oauth", grantId })).toBe(true);
  });

  it("a client's own revocation ends that grant only while another grant keeps the row", async () => {
    const user = await insertUser();
    const clientKey = `client-${recordId()}`;
    const laptop = await connect(user, clientKey);
    const desktop = await connect(user, clientKey);
    expect(await agentAccessService.revokeGrant(laptop.grantId, "client_revoked")).toEqual({
      connectionId: laptop.connectionId,
      connectionDeleted: false,
    });
    expect(await agentAccessService.isCredentialUsable({ type: "oauth", grantId: laptop.grantId })).toBe(false);
    expect(await agentAccessService.isCredentialUsable({ type: "oauth", grantId: desktop.grantId })).toBe(true);
    expect((await agentAccessService.listConnections(user)).find((r) => r.id === laptop.connectionId)?.status).toBe("active");
  });

  it("a client's own revocation of the last usable grant deletes the row", async () => {
    const user = await insertUser();
    const { connectionId, grantId } = await connect(user, `client-${recordId()}`);
    expect(await agentAccessService.revokeGrant(grantId, "client_revoked")).toEqual({ connectionId, connectionDeleted: true });
    expect((await agentAccessService.listConnections(user)).some((r) => r.id === connectionId)).toBe(false);
  });

  it("a reuse caught at the token endpoint ends the grant but keeps the row, which reads expired", async () => {
    const user = await insertUser();
    const { connectionId, grantId } = await connect(user, `client-${recordId()}`);
    expect(await agentAccessService.revokeGrant(grantId, "reuse_detected")).toEqual({ connectionId, connectionDeleted: false });
    expect((await agentAccessService.listConnections(user)).find((r) => r.id === connectionId)?.status).toBe("expired");
  });

  it("answers no connection for a grant id nobody issued", async () => {
    expect(await agentAccessService.revokeGrant(recordId(), "client_revoked")).toEqual({ connectionId: null, connectionDeleted: false });
  });
});

describe("clock", () => {
  it("defaults every check to the current time", async () => {
    const user = await insertUser();
    const { grantId } = await connect(user, `client-${recordId()}`, { refresh: 2 });
    expect(await agentAccessService.isCredentialUsable({ type: "oauth", grantId })).toBe(true);
    await new Promise((r) => setTimeout(r, 2500));
    expect(await agentAccessService.isCredentialUsable({ type: "oauth", grantId })).toBe(false);
  }, 10_000);
});
