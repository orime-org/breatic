// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { apiGet } from '@web/data/api/request';

export interface UserSummary {
  id: string;
  name: string;
  email: string;
  avatarUrl?: string;
}

/**
 * Raw user row as returned by `GET /users` — the profile fields live on the
 * personal studio, so `username` can be null mid-onboarding and `avatar_url`
 * is snake_case on the wire. The frontend maps this into `UserSummary`.
 */
interface RawUserRow {
  id: string;
  email: string;
  username: string | null;
  avatar_url: string | null;
}

/**
 * Maps a raw user row to the camelCase `UserSummary` the UI consumes. Falls
 * back to the email local-part when `username` is null (a user between the
 * two registration steps has no personal-studio name yet).
 * @param row - The raw user row from the API.
 * @returns The mapped user summary.
 */
function toUserSummary(row: RawUserRow): UserSummary {
  return {
    id: row.id,
    name: row.username ?? row.email.split('@')[0]!,
    email: row.email,
    avatarUrl: row.avatar_url ?? undefined,
  };
}

export const usersApi = {
  search(query: string) {
    return apiGet<{ users: UserSummary[] }>('/users', { params: { q: query } });
  },
  /**
   * Batch-fetch user profiles by id for the project-member roster merge.
   * Returns `[]` without hitting the API when `ids` is empty so callers can
   * pass an empty roster unconditionally.
   * @param ids - The user ids to resolve into profiles.
   * @returns The matching user summaries (empty when `ids` is empty).
   * @throws {ApiException} When the request fails or the server returns an error envelope.
   */
  async getByIds(ids: readonly string[]): Promise<UserSummary[]> {
    if (ids.length === 0) return [];
    const rows = await apiGet<RawUserRow[]>('/users', {
      params: { ids: ids.join(',') },
    });
    return rows.map(toUserSummary);
  },
};
