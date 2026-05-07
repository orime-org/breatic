/**
 * `useUsers(userIds)` — batch user-display lookup with a 1-hour cache.
 *
 * Pairs with `useProjectMembers` to render member rows: members
 * gives `userId + role`, this gives `username + email + avatar`.
 *
 * Cache lives in module scope and is keyed by `userId`. Repeat calls
 * for ids already cached return immediately; only missing ids are
 * fetched, batched into a single REST call.
 *
 * The 1-hour TTL is set in spec §7.2.6 — display fields change
 * rarely; the freshness cost of stale cache is a slightly outdated
 * avatar URL, which is acceptable.
 */

import { useEffect, useState } from 'react';
import { batchGet, type UserDisplay } from '@/data/api/users';

const TTL_MS = 60 * 60 * 1000; // 1 hour

interface CacheEntry {
  data: UserDisplay;
  fetchedAt: number;
}

const cache = new Map<string, CacheEntry>();

function getCachedUser(userId: string): UserDisplay | null {
  const entry = cache.get(userId);
  if (!entry) return null;
  if (Date.now() - entry.fetchedAt > TTL_MS) {
    cache.delete(userId);
    return null;
  }
  return entry.data;
}

async function fetchMissing(userIds: string[]): Promise<void> {
  if (userIds.length === 0) return;
  const res = await batchGet(userIds);
  // Coerce through `unknown` for the same reason as in
  // useProjectMembers — the runtime body is `{ data: UserDisplay[] }`
  // but the static type carries the AxiosResponse wrapper.
  const rows: UserDisplay[] =
    (res as unknown as { data?: UserDisplay[] })?.data ?? [];
  const now = Date.now();
  for (const row of rows) {
    cache.set(row.id, { data: row, fetchedAt: now });
  }
}

export interface UseUsersResult {
  /** Map keyed by userId. Missing entries indicate the user is still loading or doesn't exist. */
  users: Record<string, UserDisplay>;
  loading: boolean;
}

export function useUsers(userIds: readonly string[]): UseUsersResult {
  // Stable serialization for the dep array — sorted unique ids.
  const dedupedSorted = Array.from(new Set(userIds)).filter(Boolean).sort();
  const idsKey = dedupedSorted.join(',');

  const [users, setUsers] = useState<Record<string, UserDisplay>>(() => {
    const initial: Record<string, UserDisplay> = {};
    for (const id of dedupedSorted) {
      const cached = getCachedUser(id);
      if (cached) initial[id] = cached;
    }
    return initial;
  });
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (dedupedSorted.length === 0) {
      setUsers({});
      setLoading(false);
      return;
    }

    let cancelled = false;
    const cached: Record<string, UserDisplay> = {};
    const missing: string[] = [];
    for (const id of dedupedSorted) {
      const hit = getCachedUser(id);
      if (hit) cached[id] = hit;
      else missing.push(id);
    }
    setUsers(cached);

    if (missing.length === 0) {
      setLoading(false);
      return;
    }

    setLoading(true);
    fetchMissing(missing)
      .then(() => {
        if (cancelled) return;
        const next: Record<string, UserDisplay> = {};
        for (const id of dedupedSorted) {
          const hit = getCachedUser(id);
          if (hit) next[id] = hit;
        }
        setUsers(next);
        setLoading(false);
      })
      .catch(() => {
        if (cancelled) return;
        // Partial failure: keep whatever cache delivered, drop loading flag.
        setLoading(false);
      });

    return () => {
      cancelled = true;
    };
    // dedupedSorted is recomputed each render; the serialized key
    // is the actual identity that matters for re-fetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idsKey]);

  return { users, loading };
}

/** Test boundary helper: clear the module-scope user cache. */
export function __clearUsersCache(): void {
  cache.clear();
}
