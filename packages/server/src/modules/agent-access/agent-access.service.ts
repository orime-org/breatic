// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What the settings page and the owner's browser do for external agents
 * (#1488 §5.4, §5.6, §19.1): personal access tokens, renaming and
 * disconnecting connections, and handing a view capture back to the command
 * that asked for it.
 *
 * Whether a credential is usable, and the tables behind it, live in core's
 * `agentAccessService`, which collab asks too; this module adds what only the
 * server does: its downstream tokens, the revocation announcement, and the
 * capture reply.
 */

import { z } from "zod";
import {
  AppError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  agentAccessService,
  env,
  getMcpConfig,
  getMcpRedis,
  oauthRecordsRepo,
  publishSessionsRevoked,
  type AgentCredential,
} from "@breatic/core";
import {
  VIEW_CAPTURE_VIEW_MAX_BYTES,
  mcpCaptureRequestKey,
  mcpDoneChannel,
  mcpReplyKey,
  t,
  type AgentReply,
} from "@breatic/shared";
import { credentialId, revokeDownstreamTokens } from "@server/modules/agent-access/agent-token-store.js";

/**
 * Create a personal access token.
 * @param userId - Whose token.
 * @param name - Its name, already trimmed.
 * @param expiresInDays - Its lifetime in days; null never expires.
 * @returns The plaintext, shown once, and its connection.
 * @throws {ConflictError} When the user already holds `pat.max_active_per_user` live tokens.
 */
export async function createToken(
  userId: string,
  name: string,
  expiresInDays: number | null,
): Promise<{ token: string; connectionId: string }> {
  let expiresAt: Date | null = null;
  if (expiresInDays !== null) {
    expiresAt = new Date();
    expiresAt.setUTCDate(expiresAt.getUTCDate() + expiresInDays);
  }
  const created = await agentAccessService.createPersonalAccessToken({ userId, name, expiresAt });
  if (!created.ok) {
    throw new ConflictError(t("server.agent_access.token_limit_reached", { max: getMcpConfig().pat.max_active_per_user }));
  }
  return { token: created.token, connectionId: created.connectionId };
}

/**
 * Rename one of the user's own connections.
 * @param connectionId - The connection.
 * @param userId - The user asking.
 * @param name - The new name, already trimmed.
 * @throws {NotFoundError} When it is not the user's own live connection.
 */
export async function rename(connectionId: string, userId: string, name: string): Promise<void> {
  if (!(await agentAccessService.rename(connectionId, userId, name))) throw new NotFoundError(t("server.error.not_found"));
}

/** What disconnecting did. */
export interface DisconnectOutcome {
  /** Every credential that ended. */
  revoked: AgentCredential[];
  /**
   * Why announcing them to collab failed, when it did. The credentials and
   * their downstream tokens are ended either way; the caller logs it.
   */
  signalFailure?: unknown;
}

/**
 * Disconnect one of the user's own connections: end every credential under
 * it and every downstream token traded for them, then announce the
 * credentials on `sessions:revoked` so collab marks the agent offline.
 * @param connectionId - The connection.
 * @param userId - The user asking.
 * @returns The credentials ended, and whether announcing them failed.
 * @throws {NotFoundError} When it is not the user's own live connection.
 */
export async function disconnect(connectionId: string, userId: string): Promise<DisconnectOutcome> {
  const outcome = await agentAccessService.disconnect(connectionId, userId);
  if (!outcome) throw new NotFoundError(t("server.error.not_found"));
  for (const credential of outcome.revoked) await revokeDownstreamTokens(credential);
  if (outcome.revoked.length === 0) return { revoked: [] };
  try {
    await publishSessionsRevoked(userId, outcome.revoked.map(credentialId));
    return { revoked: outcome.revoked };
  } catch (err) {
    return { revoked: outcome.revoked, signalFailure: err };
  }
}

/** What ending one OAuth grant did. */
export interface EndGrantOutcome {
  /** Who gave the grant; null when no such grant was left. */
  userId: string | null;
  /** The grant's connection row, when it had one. */
  connectionId: string | null;
  /** Whether that row was deleted. */
  connectionDeleted: boolean;
  /** Why announcing the grant to collab failed, when it did; the caller logs it. */
  signalFailure?: unknown;
}

/**
 * End one OAuth grant the authorization server revoked (#1488 §5.2): its
 * tokens and record, its connection row as `agentAccessService.revokeGrant`
 * decides by `source`, every downstream token traded for it, and then the
 * announcement on `sessions:revoked`, as {@link disconnect} does.
 * @param grantId - The grant.
 * @param source - `client_revoked` from `/oauth/revoke`, `reuse_detected` from the token endpoint.
 * @returns Who it belonged to, what happened to its row, and whether announcing it failed.
 * @throws {Error} When the database or Redis cannot be written.
 */
export async function endGrant(grantId: string, source: "client_revoked" | "reuse_detected"): Promise<EndGrantOutcome> {
  const owner = await oauthRecordsRepo.grantOwner(grantId);
  const { connectionId, connectionDeleted } = await agentAccessService.revokeGrant(grantId, source);
  await revokeDownstreamTokens({ type: "oauth", grantId });
  const userId = owner?.accountId ?? null;
  if (userId === null) return { userId, connectionId, connectionDeleted };
  try {
    await publishSessionsRevoked(userId, [grantId]);
    return { userId, connectionId, connectionDeleted };
  } catch (err) {
    return { userId, connectionId, connectionDeleted, signalFailure: err };
  }
}

/** A capture request as collab registers it. */
const captureRequestSchema = z.object({ userId: z.string(), callId: z.string() });

/** A JSON value, as a reply's result holds it. */
export type JsonValue = Extract<AgentReply, { status: "done" }>["result"];

/** What the owner's browser uploads. */
export interface ViewCaptureUpload {
  /** The capture; absent when no Space is open. */
  image?: File;
  /** Said in place of an image. */
  note?: string;
  /** The on-screen data as sent, and parsed. */
  view: { raw: string; value: JsonValue };
}

/**
 * Write a capture as the reply of the command that asked for it, unless a
 * reply is already there (the timeout's "not watching", or an earlier upload),
 * and tell the MCP service it is ready.
 * @param requestId - The capture request.
 * @param userId - The uploader.
 * @param upload - What was uploaded.
 * @throws {AppError} 410 when the request is unknown or expired; 413 when the image or the on-screen data is over its limit.
 * @throws {ForbiddenError} When the uploader is not the owner the request was sent to.
 * @throws {ConflictError} When the command already has a reply.
 */
export async function submitViewCapture(requestId: string, userId: string, upload: ViewCaptureUpload): Promise<void> {
  const redis = getMcpRedis();
  const prefix = env.REDIS_KEY_PREFIX;
  const raw = await redis.get(mcpCaptureRequestKey(prefix, requestId));
  if (raw === null) throw new AppError(410, t("server.agent_access.capture_expired"));
  const request = captureRequestSchema.parse(JSON.parse(raw));
  if (request.userId !== userId) throw new ForbiddenError(t("server.error.forbidden"));
  const config = getMcpConfig();
  if ((upload.image?.size ?? 0) > config.view_capture.max_bytes || Buffer.byteLength(upload.view.raw) > VIEW_CAPTURE_VIEW_MAX_BYTES) {
    throw new AppError(413, t("server.agent_access.capture_too_large"));
  }
  const result: JsonValue = upload.image
    ? {
      mimeType: upload.image.type,
      imageBase64: Buffer.from(await upload.image.arrayBuffer()).toString("base64"),
      view: upload.view.value,
    }
    : { note: upload.note ?? "" };
  const reply: AgentReply = { callId: request.callId, status: "done", result };
  const written = await redis.set(mcpReplyKey(prefix, request.callId), JSON.stringify(reply), "EX", config.reply_ttl_seconds, "NX");
  if (written === null) throw new ConflictError(t("server.agent_access.capture_answered"));
  await redis.publish(mcpDoneChannel(prefix), request.callId);
}
