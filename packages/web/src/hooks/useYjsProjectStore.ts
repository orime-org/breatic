/**
 * `useYjsStore(options)` — top-level Yjs orchestrator for the
 * project page (v10 multi-doc).
 *
 * Replaces the pre-v10 single-doc store. Owns:
 *
 *   1. The shared websocket (`useHocuspocusSocket`) — one ws per
 *      `(projectId, token)` tuple, regardless of how many Space
 *      docs are open.
 *   2. The project meta doc (`useProjectMeta`) — Tab Bar source +
 *      stateless invalidate channel.
 *   3. The canvas Space LRU pool (`useSpaceManagerPool`) — opens
 *      `project-{pid}/canvas-{spaceId}` docs on demand.
 *   4. Bootstrap: when the project has no canvas Space yet, the
 *      hook calls `POST /api/v1/projects/:pid/spaces` once to
 *      create a default `"Untitled"` Canvas. The new tab arrives
 *      via Yjs sync from Collab's `members-sync` subscriber.
 *   5. The active spaceId — first canvas Space in `meta.spaces`
 *      until the Tab Bar (PR-E) wires user-driven switches via
 *      `useTabState`.
 *
 * The hook returns a single `manager: CanvasSpaceManager | null`
 * suitable for handing straight to `CanvasDataProvider`. Pre-v10
 * extras (createSnapshot / undo at this layer / awareness edge
 * selections) had no callers and are dropped.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CanvasSpaceManager } from '@/utils/yjsCanvasSpaceManager';
import { useHocuspocusSocket } from './useHocuspocusSocket';
import { useProjectMeta } from './useProjectMeta';
import { useSpaceManagerPool } from './useSpaceManagerPool';
import * as projectSpacesApi from '@/apis/projectSpaces';

export interface UseYjsStoreOptions {
  /** Project UUID from the URL. Empty/undefined disables the hook. */
  id: string;
  /** Session token (Bearer). Empty disables the hook. */
  token: string;
  /** Optional ws URL override (tests / explicit prod overrides). */
  wsUrl?: string;
  enabled?: boolean;
  /**
   * Called when Hocuspocus rejects the token. Caller is expected to
   * clear local session + redirect to /login.
   */
  onAuthFailed?: (reason: string) => void;
}

export interface UseYjsStoreResult {
  /** Active canvas Space manager — null while bootstrapping or between switches. */
  manager: CanvasSpaceManager | null;
  /** True between mount and first canvas Space being ready. */
  yjsLoading: boolean;
  /** Read-only flag mirroring the input — kept for upstream wiring. */
  yjsEnabled: boolean;
}

const DEFAULT_SPACE_NAME = 'Untitled';

export const useYjsStore = (options: UseYjsStoreOptions): UseYjsStoreResult => {
  const { id, token, wsUrl, enabled = true, onAuthFailed } = options;

  const projectId = enabled && id && token ? id : null;

  // 1. Shared ws (single per project).
  const socket = useHocuspocusSocket(projectId, token, { enabled, wsUrl });

  // 2. Meta doc — drives the Tab Bar + stateless invalidate channel.
  const { manager: metaManager, spaces, loading: metaLoading } = useProjectMeta(
    projectId,
    token,
    {
      enabled,
      websocketProvider: socket ?? undefined,
      wsUrl,
      onAuthFailed,
    },
  );

  // 3. LRU canvas Space pool, sharing the ws.
  const { getCanvasSpace } = useSpaceManagerPool(projectId, token, {
    websocketProvider: socket ?? undefined,
    wsUrl,
    onAuthFailed,
  });

  // 4. Default-Space bootstrap. Runs at most once per (projectId,
  // metaManager) — guarded by a ref so a brief Yjs round-trip
  // doesn't trigger a second POST.
  const bootstrappedRef = useRef<string | null>(null);
  const [bootstrapping, setBootstrapping] = useState(false);

  useEffect(() => {
    if (!projectId || !metaManager || metaLoading) return;
    if (bootstrappedRef.current === projectId) return;
    if (spaces.length > 0) {
      // Already has at least one Space — no bootstrap needed.
      bootstrappedRef.current = projectId;
      return;
    }

    bootstrappedRef.current = projectId;
    setBootstrapping(true);
    projectSpacesApi
      .create(projectId, { type: 'canvas', name: DEFAULT_SPACE_NAME })
      .catch(() => {
        // Failure is recoverable: clear the guard so the next render
        // (e.g. after a network blip resolves) tries again.
        bootstrappedRef.current = null;
      })
      .finally(() => setBootstrapping(false));
  }, [projectId, metaManager, metaLoading, spaces]);

  // 5. Pick the first Canvas Space as the active one. Tab Bar UI
  // (PR-E) will replace this with `useTabState`-driven selection.
  const activeSpaceId = useMemo<string | null>(() => {
    const firstCanvas = spaces.find((s) => s.type === 'canvas');
    return firstCanvas?.id ?? null;
  }, [spaces]);

  const [activeManager, setActiveManager] = useState<CanvasSpaceManager | null>(null);

  useEffect(() => {
    if (!activeSpaceId || !projectId) {
      setActiveManager(null);
      return;
    }
    setActiveManager(getCanvasSpace(activeSpaceId));
    // The pool itself owns lifecycle / LRU eviction; we never destroy
    // here.
  }, [projectId, activeSpaceId, getCanvasSpace]);

  // Reset bootstrap guard when project rotates so re-entry on a new
  // project starts clean.
  useEffect(() => {
    bootstrappedRef.current = null;
  }, [projectId]);

  // The cleanup callback below is a placeholder — the inner hooks
  // own their own teardown. The variable suppresses an unused-import
  // warning when this file is later expanded with side effects.
  const _noop = useCallback(() => undefined, []);
  void _noop;

  const yjsLoading =
    !!projectId && (metaLoading || bootstrapping || activeManager === null);

  return {
    manager: activeManager,
    yjsLoading,
    yjsEnabled: !!projectId,
  };
};
