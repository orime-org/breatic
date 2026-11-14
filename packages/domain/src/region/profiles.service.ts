// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Who users are, as any region reads it (inner#1955). Names, handles and
 * avatars live on personal Studio rows in the global directory, addresses
 * and languages on the accounts; outside the global region both come
 * through the global API, and profiles are cached in Redis for
 * `profile_cache_ttl_ms`.
 */

import { env, getRedis, getRegionsConfig, isGlobalRegion } from "@breatic/core";
import { globalApi, type Account } from "@domain/region/global-api.js";
import { getProfiles, type Profile } from "@domain/region/studioDirectory.service.js";

/**
 * The cache key of one user's profile.
 * @param userId - The user.
 * @returns `{env}:profile:{userId}`.
 */
function profileKey(userId: string): string {
  return `${env.ENV}:profile:${userId}`;
}

/**
 * How each of these users is shown.
 * @param userIds - The users.
 * @returns Each known user's profile.
 * @throws {GlobalApiError} When the global region does not answer for users not cached here.
 */
export async function profilesOf(userIds: readonly string[]): Promise<Map<string, Profile>> {
  const ids = [...new Set(userIds)];
  if (ids.length === 0) return new Map();
  if (isGlobalRegion(env)) return new Map(Object.entries(await getProfiles(ids)));
  const redis = getRedis();
  const cached = await redis.mget(...ids.map(profileKey));
  const profiles = new Map<string, Profile>();
  const missing: string[] = [];
  ids.forEach((id, index) => {
    const hit = cached[index];
    if (hit === null || hit === undefined) missing.push(id);
    else profiles.set(id, JSON.parse(hit) as Profile);
  });
  if (missing.length === 0) return profiles;
  const fetched = await globalApi().getProfiles(missing);
  const ttl = getRegionsConfig().profile_cache_ttl_ms;
  const writes = redis.multi();
  for (const [id, profile] of Object.entries(fetched)) {
    profiles.set(id, profile);
    writes.set(profileKey(id), JSON.stringify(profile), "PX", ttl);
  }
  await writes.exec();
  return profiles;
}

/**
 * Each user's personal Studio name and handle, deleted ones flagged; users
 * before onboarding are absent.
 * @param userIds - The users.
 * @returns `userId → { name, slug, deleted }`.
 * @throws {GlobalApiError} When the global region does not answer.
 */
export async function personalProfiles(
  userIds: readonly string[],
): Promise<Map<string, { name: string; slug: string; deleted: boolean }>> {
  const byUser = new Map<string, { name: string; slug: string; deleted: boolean }>();
  for (const [id, profile] of await profilesOf(userIds)) {
    if (profile.name !== null && profile.handle !== null) {
      byUser.set(id, { name: profile.name, slug: profile.handle, deleted: profile.deleted });
    }
  }
  return byUser;
}

/**
 * Each user's live personal Studio name and avatar; users without one are absent.
 * @param userIds - The users.
 * @returns `userId → { name, avatarUrl }`.
 * @throws {GlobalApiError} When the global region does not answer.
 */
export async function personalIdentities(
  userIds: readonly string[],
): Promise<Map<string, { name: string; avatarUrl: string | null }>> {
  const byUser = new Map<string, { name: string; avatarUrl: string | null }>();
  for (const [id, profile] of await profilesOf(userIds)) {
    if (profile.name !== null && !profile.deleted) byUser.set(id, { name: profile.name, avatarUrl: profile.avatarUrl });
  }
  return byUser;
}

/**
 * The accounts behind these ids: address, whether it is verified, and language.
 * @param userIds - The users.
 * @returns `userId → account` for every live account.
 * @throws {GlobalApiError} When the global region does not answer.
 */
export async function accountsOf(userIds: readonly string[]): Promise<Map<string, Account>> {
  const ids = [...new Set(userIds)];
  if (ids.length === 0) return new Map();
  return new Map((await globalApi().getAccounts(ids)).map((account) => [account.id, account]));
}

/**
 * The live account registered under an address, in any casing.
 * @param email - The address.
 * @returns The account, or null.
 * @throws {GlobalApiError} When the global region does not answer.
 */
export async function accountByEmail(email: string): Promise<Account | null> {
  return globalApi().findAccountByEmail(email);
}
