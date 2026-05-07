/**
 * `useProjectMeta(projectId, ...)` — connect to the project's meta
 * Yjs doc (v10 §5.3.1) and surface its observable state to React.
 *
 * The meta doc carries:
 *   - `spaces` Y.Map — Tab Bar source of truth.
 *   - `userStates` Y.Map<userId, ...> — per-user tab state.
 *   - `projectMeta` Y.Map — project-level metadata (name etc.).
 *
 * The hook also keeps the underlying `ProjectMetaManager` exposed so
 * sibling hooks (`useTabState`, `useProjectMembers` for stateless
 * invalidate signal subscriptions) can reach the same connection
 * without re-opening it.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import * as Y from 'yjs';
import type { HocuspocusProviderWebsocket } from '@hocuspocus/provider';
import type { Space, SpaceType } from '@breatic/shared';
import {
  createProjectMetaManager,
  type ProjectMetaManager,
} from '@/utils/yjsProjectMetaManager';

export interface UseProjectMetaOptions {
  enabled?: boolean;
  websocketProvider?: HocuspocusProviderWebsocket;
  wsUrl?: string;
  onAuthFailed?: (reason: string) => void;
}

export interface UseProjectMetaResult {
  /** Underlying Yjs manager — null until the manager is constructed. */
  manager: ProjectMetaManager | null;
  /** Plain-JS view of `meta.spaces`, ordered by `order` ascending. */
  spaces: Space[];
  /** True between manager-construction and first server sync. */
  loading: boolean;
}

/** Read a single Y.Map space entry into the plain-JS Space type. */
function readSpaceEntry(entry: Y.Map<unknown>, fallbackId: string): Space {
  return {
    id: (entry.get('id') as string) ?? fallbackId,
    type: ((entry.get('type') as SpaceType) ?? 'canvas') as SpaceType,
    name: (entry.get('name') as string) ?? '',
    order: (entry.get('order') as number) ?? 0,
    locked: (entry.get('locked') as boolean) ?? false,
    createdAt: (entry.get('createdAt') as number) ?? 0,
  };
}

function readAllSpaces(spacesMap: Y.Map<unknown>): Space[] {
  const result: Space[] = [];
  spacesMap.forEach((value, key) => {
    if (value instanceof Y.Map) {
      result.push(readSpaceEntry(value, key));
    }
  });
  // Stable display order: by `order`, then by createdAt as tiebreaker.
  result.sort((a, b) => a.order - b.order || a.createdAt - b.createdAt);
  return result;
}

export function useProjectMeta(
  projectId: string | null,
  token: string,
  options: UseProjectMetaOptions = {},
): UseProjectMetaResult {
  const { enabled = true, websocketProvider, wsUrl, onAuthFailed } = options;

  const [manager, setManager] = useState<ProjectMetaManager | null>(null);
  const [spaces, setSpaces] = useState<Space[]>([]);
  const [loading, setLoading] = useState<boolean>(false);
  const onAuthFailedRef = useRef(onAuthFailed);
  onAuthFailedRef.current = onAuthFailed;

  useEffect(() => {
    if (!enabled || !projectId || !token) {
      setManager(null);
      setSpaces([]);
      setLoading(false);
      return;
    }

    setLoading(true);

    const mgr = createProjectMetaManager({
      projectId,
      token,
      websocketProvider,
      wsUrl,
      onAuthFailed: (reason) => onAuthFailedRef.current?.(reason),
    });
    setManager(mgr);

    const refreshSpaces = () => {
      setSpaces(readAllSpaces(mgr.spaces));
    };

    const unsubSynced = mgr.onSynced(() => {
      setLoading(false);
      refreshSpaces();
      // observeDeep so additions / per-entry edits both trigger.
      mgr.spaces.observeDeep(refreshSpaces);
    });

    return () => {
      unsubSynced();
      mgr.spaces.unobserveDeep(refreshSpaces);
      mgr.destroy();
      setManager(null);
      setSpaces([]);
      setLoading(false);
    };
    // websocketProvider is part of the deps so that when the shared
    // socket rotates (project change / token rotation produces a new
    // `HocuspocusProviderWebsocket`), the meta manager is rebuilt to
    // attach to the new socket. With `useHocuspocusSocket` returning
    // a non-null socket on the first render (useMemo), this dep no
    // longer causes a wasteful first-render remount.
  }, [projectId, token, wsUrl, enabled, websocketProvider]);

  return useMemo(() => ({ manager, spaces, loading }), [manager, spaces, loading]);
}
