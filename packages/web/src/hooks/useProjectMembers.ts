/**
 * `useProjectMembers(projectId, metaProvider)` — keep an in-memory
 * cache of `project_members` rows fresh against the v10 stateless
 * invalidate signal (spec §7.2.6).
 *
 * Data flow:
 *
 *   1. First mount  → REST GET /api/v1/projects/:pid/members.
 *   2. Every render → return the cached list.
 *   3. Collab broadcasts `project-members:changed` stateless message
 *      on the meta doc → invalidate cache + REST refetch.
 *   4. User-perceptible UI lag is bounded by `Redis publish → Collab
 *      broadcastStateless → ws → fetch round-trip` (spec target ≤ 150 ms).
 *
 * The cache is per-`projectId` and lives in module scope so multiple
 * components sharing the same project re-use the same fetch promise
 * (no duplicate REST calls during initial load).
 */

import { useEffect, useState } from 'react';
import type { ProjectMember } from '@breatic/shared';
import type { ProjectMetaManager } from '@/data/yjs/project-meta';
import * as projectMembersApi from '@/data/api/project-members';

interface CacheEntry {
  inFlight: Promise<ProjectMember[]> | null;
  data: ProjectMember[] | null;
}

const cache = new Map<string, CacheEntry>();
const subscribers = new Map<string, Set<(rows: ProjectMember[]) => void>>();

function getEntry(projectId: string): CacheEntry {
  let entry = cache.get(projectId);
  if (!entry) {
    entry = { inFlight: null, data: null };
    cache.set(projectId, entry);
  }
  return entry;
}

function notify(projectId: string, rows: ProjectMember[]): void {
  subscribers.get(projectId)?.forEach((cb) => cb(rows));
}

async function fetchMembers(projectId: string): Promise<ProjectMember[]> {
  const entry = getEntry(projectId);
  if (entry.inFlight) return entry.inFlight;

  // `request.ts`'s response interceptor unwraps `AxiosResponse.data`
  // at runtime, so `await api.list(...)` resolves to `ApiResponse<T>`
  // (i.e. `{ data: T }`). One more `.data` gets us the rows.
  const fetchPromise: Promise<ProjectMember[]> = (async () => {
    try {
      const res = await projectMembersApi.list(projectId);
      // `request.ts`'s response interceptor unwraps `AxiosResponse.data`
      // at runtime, so `res` is the response body shaped
      // `{ data: ProjectMember[] }`. The static `axios` type still
      // believes it's an AxiosResponse, so we coerce through `unknown`
      // to read the array out cleanly. (Same pattern fixes the
      // pre-existing type-mismatch in workspace/RecentProjects.tsx.)
      const rows: ProjectMember[] =
        (res as unknown as { data?: ProjectMember[] })?.data ?? [];
      entry.data = rows;
      notify(projectId, rows);
      return rows;
    } finally {
      entry.inFlight = null;
    }
  })();

  entry.inFlight = fetchPromise;
  return fetchPromise;
}

/** Drop the cache + force a re-fetch for `projectId`. */
function invalidate(projectId: string): void {
  const entry = cache.get(projectId);
  if (entry) {
    entry.data = null;
    entry.inFlight = null;
  }
  // Trigger a fresh fetch; subscribers receive new rows when ready.
  void fetchMembers(projectId).catch(() => {
    // Errors surface to subscribers via the cache lifecycle —
    // logging them here would be noisy on transient network blips.
  });
}

export interface UseProjectMembersResult {
  members: ProjectMember[];
  loading: boolean;
}

/**
 * @param projectId - Project to load members for. `null` disables.
 * @param metaProvider - The meta-doc Hocuspocus provider. The hook
 *   subscribes to its `stateless` event for invalidate signals from
 *   Collab. Pass `null` to skip the subscription (the cache then
 *   relies solely on first-mount fetch + manual invalidation).
 */
export function useProjectMembers(
  projectId: string | null,
  metaProvider: ProjectMetaManager['provider'] | null,
): UseProjectMembersResult {
  const [members, setMembers] = useState<ProjectMember[]>(() => {
    if (!projectId) return [];
    return getEntry(projectId).data ?? [];
  });
  const [loading, setLoading] = useState(false);

  // Cache fetch + subscribe to module-scope cache updates.
  useEffect(() => {
    if (!projectId) {
      setMembers([]);
      setLoading(false);
      return;
    }

    const entry = getEntry(projectId);
    if (entry.data) {
      setMembers(entry.data);
      setLoading(false);
    } else {
      setLoading(true);
      void fetchMembers(projectId).then(
        () => {
          // Notify path will deliver via subscriber registration below.
          setLoading(false);
        },
        () => {
          setLoading(false);
        },
      );
    }

    const subs = subscribers.get(projectId) ?? new Set();
    const onChange = (rows: ProjectMember[]) => setMembers(rows);
    subs.add(onChange);
    subscribers.set(projectId, subs);

    return () => {
      subs.delete(onChange);
      if (subs.size === 0) {
        subscribers.delete(projectId);
      }
    };
  }, [projectId]);

  // Subscribe to stateless invalidate signals from Collab.
  useEffect(() => {
    if (!projectId || !metaProvider) return;

    const handler = (data: { payload: string }) => {
      try {
        const evt = JSON.parse(data.payload) as {
          type?: string;
          projectId?: string;
        };
        if (
          evt.type === 'project-members:changed' &&
          evt.projectId === projectId
        ) {
          invalidate(projectId);
        }
      } catch {
        // Malformed payloads are dropped silently — Collab is the
        // sole sender; if it's emitting garbage we have a deeper bug.
      }
    };

    metaProvider.on('stateless', handler);
    return () => {
      metaProvider.off('stateless', handler);
    };
  }, [projectId, metaProvider]);

  return { members, loading };
}

/**
 * Test / boundary helper: explicitly invalidate the module-scope
 * cache for a project. Production code should rely on the meta-doc
 * stateless signal.
 */
export function __invalidateProjectMembersCache(projectId: string): void {
  invalidate(projectId);
}
