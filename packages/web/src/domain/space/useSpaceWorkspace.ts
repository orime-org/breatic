/**
 * `useSpaceWorkspace(options)` — top-level Yjs orchestrator for the
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
 *   4. The active spaceId — first canvas Space in `meta.spaces`
 *      until the Tab Bar (PR-E) wires user-driven switches via
 *      `useTabState`.
 *
 * No bootstrap effect:
 *   The default Space is seeded by `core/project.service.create`
 *   inside the project-creation transaction (writes the meta doc's
 *   initial Yjs state directly). By the time this hook runs, the
 *   meta doc on Collab already contains at least one Space, so
 *   `meta.spaces` is non-empty on the very first sync. The pre-v10
 *   "if spaces=[] then POST /spaces" effect is gone.
 *
 * The hook returns a single `manager: CanvasSpaceManager | null`
 * suitable for handing straight to `CanvasDataProvider`. The active
 * Space is a Canvas in V1; document/timeline kinds (v10 spec
 * §5.2) are tracked in `meta.spaces` but not yet renderable — the
 * Tab Bar (PR-E) will surface a "kind not yet supported" placeholder
 * and skip them when picking the initial active space.
 */

import { useEffect, useMemo, useState } from 'react';
import type { CanvasSpaceManager } from '@/data/yjs/canvas-space';
import { useHocuspocusSocket } from '@/data/yjs/use-socket';
import { useProjectMeta } from './useProjectMeta';
import { useSpaceManagerPool } from './useSpaceManagerPool';

export interface UseSpaceWorkspaceOptions {
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

export interface UseSpaceWorkspaceResult {
  /** Active canvas Space manager — null while connecting or between switches. */
  manager: CanvasSpaceManager | null;
  /** True between mount and first canvas Space being ready. */
  yjsLoading: boolean;
  /** Read-only flag mirroring the input — kept for upstream wiring. */
  yjsEnabled: boolean;
}

export const useSpaceWorkspace = (options: UseSpaceWorkspaceOptions): UseSpaceWorkspaceResult => {
  const { id, token, wsUrl, enabled = true, onAuthFailed } = options;

  const projectId = enabled && id && token ? id : null;

  // 1. Shared ws (single per project, available on first render).
  const socket = useHocuspocusSocket(projectId, token, { enabled, wsUrl });

  // 2. Meta doc — drives the Tab Bar + stateless invalidate channel.
  const { spaces, loading: metaLoading } = useProjectMeta(projectId, token, {
    enabled,
    websocketProvider: socket ?? undefined,
    wsUrl,
    onAuthFailed,
  });

  // 3. LRU canvas Space pool, sharing the ws.
  const { getCanvasSpace } = useSpaceManagerPool(projectId, token, {
    websocketProvider: socket ?? undefined,
    wsUrl,
    onAuthFailed,
  });

  // 4. Pick the first Canvas Space as the active one. Tab Bar UI
  //    (PR-E) will replace this with `useTabState`-driven selection.
  //    We filter to canvas because that's the only renderable kind
  //    in V1; document/timeline entries in `meta.spaces` are tracked
  //    but skipped until their UI ships.
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
    // The pool itself owns lifecycle / LRU eviction; we never destroy here.
  }, [projectId, activeSpaceId, getCanvasSpace]);

  const yjsLoading =
    !!projectId && (metaLoading || activeManager === null);

  return {
    manager: activeManager,
    yjsLoading,
    yjsEnabled: !!projectId,
  };
};
