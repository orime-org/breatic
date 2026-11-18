// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Downstream tokens (#1488 §5.1, §5.5): the short-lived token the MCP service
 * calls the API with, in place of the agent's own token, which MCP forbids it
 * to pass through (Security Considerations, "Access Token Privilege
 * Restriction").
 *
 * They live in the session Redis next to sessions, under the same
 * `{ENV}:` prefix scheme. Only the token's SHA-256 is a key; the plaintext
 * exists only in the MCP service's hands. Each credential keeps an index of
 * the tokens traded for it, so revoking the credential ends them all at once;
 * every issue pushes the index's expiry to `downstream_token_ttl_seconds`,
 * the longest any token lives.
 */

import crypto from "node:crypto";
import { z } from "zod";
import { env, getMcpConfig, getRedis, type AgentCredential } from "@breatic/core";

/** Who and what a downstream token stands for. */
export interface DownstreamTokenPayload {
  userId: string;
  credential: AgentCredential;
  connectionId: string;
  clientName: string;
}

const payloadSchema = z.object({
  userId: z.string(),
  credential: z.discriminatedUnion("type", [
    z.object({ type: z.literal("oauth"), grantId: z.string() }),
    z.object({ type: z.literal("pat"), tokenId: z.string() }),
  ]),
  connectionId: z.string(),
  clientName: z.string(),
});

/**
 * SHA-256 hex of a plaintext token.
 * @param token - The plaintext.
 * @returns The digest.
 */
function hashOf(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

/**
 * Key of one token.
 * @param hash - The token's SHA-256.
 * @returns The Redis key.
 */
function tokenKey(hash: string): string {
  return `${env.ENV}:agent-token:${hash}`;
}

/**
 * The id a credential goes by.
 * @param credential - The grant or personal access token.
 * @returns The grant id or token id.
 */
export function credentialId(credential: AgentCredential): string {
  return credential.type === "oauth" ? credential.grantId : credential.tokenId;
}

/**
 * Key of the set of tokens traded for one credential.
 * @param credential - The grant or personal access token.
 * @returns The Redis key.
 */
function indexKey(credential: AgentCredential): string {
  return `${env.ENV}:agent-tokens:${credential.type}:${credentialId(credential)}`;
}

/**
 * Issue a downstream token.
 * @param payload - Who it stands for.
 * @param lifetimeSeconds - How long it lives, at most `downstream_token_ttl_seconds`.
 * @returns The plaintext token; only its hash is stored.
 * @throws {Error} When Redis rejects the write.
 */
export async function issueDownstreamToken(payload: DownstreamTokenPayload, lifetimeSeconds: number): Promise<string> {
  const ttl = getMcpConfig().downstream_token_ttl_seconds;
  const token = crypto.randomBytes(32).toString("base64url");
  const hash = hashOf(token);
  const index = indexKey(payload.credential);
  const results = await getRedis()
    .multi()
    .set(tokenKey(hash), JSON.stringify(payload), "EX", Math.min(lifetimeSeconds, ttl))
    .sadd(index, hash)
    .expire(index, ttl)
    .exec();
  const failed = results?.find(([err]) => err !== null)?.[0];
  if (failed) throw failed;
  return token;
}

/**
 * Read what a downstream token stands for.
 * @param token - The plaintext presented.
 * @returns Its payload, or null when it was never issued, expired or was revoked.
 * @throws {Error} When Redis cannot be read.
 */
export async function findDownstreamToken(token: string): Promise<DownstreamTokenPayload | null> {
  const raw = await getRedis().get(tokenKey(hashOf(token)));
  if (raw === null) return null;
  const parsed = payloadSchema.safeParse(JSON.parse(raw));
  return parsed.success ? parsed.data : null;
}

/**
 * End every downstream token traded for a credential.
 * @param credential - The grant or personal access token just revoked.
 * @throws {Error} When Redis cannot be read or written.
 */
export async function revokeDownstreamTokens(credential: AgentCredential): Promise<void> {
  const index = indexKey(credential);
  const hashes = await getRedis().smembers(index);
  await getRedis().del(index, ...hashes.map(tokenKey));
}
