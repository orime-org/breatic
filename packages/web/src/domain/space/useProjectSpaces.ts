/**
 * `useProjectSpaces(options)` — top-level Yjs orchestrator for the
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
import type { ProjectMetaManager } from '@/data/yjs/project-meta';
import { useHocuspocusSocket } from '@/data/yjs/use-socket';
import { useProjectMeta } from './useProjectMeta';
import { useSpaceManagerPool } from './useSpaceManagerPool';

import type { Space } from '@breatic/shared';

export interface UseProjectSpacesOptions {
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
  /**
   * Tab Bar (`spaces/_shell`) drives this. When provided, the hook
   * opens that Space's manager via the LRU pool; when undefined, the
   * fallback "first canvas Space in `meta.spaces`" applies (legacy
   * pre-Tab-Bar behavior).
   *
   * If the id refers to a non-canvas kind (document/timeline), the
   * `manager` field stays null — only canvas Spaces have a runtime
   * implementation today; the shell renders a placeholder for the
   * other kinds.
   */
  activeSpaceId?: string | null;
}

export interface UseProjectSpacesResult {
  /**
   * Manager for the **active canvas Space**. Null when:
   *   - the hook is loading
   *   - the active space is non-canvas (document/timeline) — render a placeholder
   *   - there are no canvas spaces yet
   */
  manager: CanvasSpaceManager | null;
  /**
   * Project meta-doc manager — used by features that listen to the
   * `members:changed` stateless invalidate signal (e.g. project members
   * cache). Null while the meta-doc is being constructed.
   */
  metaManager: ProjectMetaManager | null;
  /** All spaces in this project — Tab Bar source of truth. */
  spaces: Space[];
  /** Currently active spaceId — derived from `activeSpaceId` or first canvas. */
  activeSpaceId: string | null;
  /** Currently active space row (for kind / name lookup). */
  activeSpace: Space | null;
  /** True between mount and first canvas Space being ready. */
  yjsLoading: boolean;
  /** Read-only flag mirroring the input — kept for upstream wiring. */
  yjsEnabled: boolean;
  /** Project UUID, normalized — null when the hook is disabled. */
  projectId: string | null;
}

export const useProjectSpaces = (options: UseProjectSpacesOptions): UseProjectSpacesResult => {
  const { id, token, wsUrl, enabled = true, onAuthFailed, activeSpaceId: activeSpaceIdInput } = options;

  const projectId = enabled && id && token ? id : null;

  // 1. Shared ws (single per project, available on first render).
  const socket = useHocuspocusSocket(projectId, token, { enabled, wsUrl });

  // 2. Meta doc — drives the Tab Bar + stateless invalidate channel.
  const { manager: metaManager, spaces, loading: metaLoading } = useProjectMeta(projectId, token, {
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

  // 4. Resolve active spaceId.
  //    - When the Tab Bar (`spaces/_shell`) passes an explicit
  //      `activeSpaceId`, honor it (validate against meta.spaces so a
  //      stale id from `meta.userStates` doesn't try to open a deleted
  //      space).
  //    - Otherwise fall back to the first canvas Space in `meta.spaces`
  //      (legacy single-Space behaviour, kept for callers that haven't
  //      adopted the shell yet).
  const activeSpaceId = useMemo<string | null>(() => {
    if (activeSpaceIdInput) {
      const exists = spaces.some((s) => s.id === activeSpaceIdInput);
      if (exists) return activeSpaceIdInput;
      // Fall through to first-canvas fallback when the id is stale.
    }
    const firstCanvas = spaces.find((s) => s.type === 'canvas');
    return firstCanvas?.id ?? null;
  }, [activeSpaceIdInput, spaces]);

  const activeSpace = useMemo<Space | null>(() => {
    if (!activeSpaceId) return null;
    return spaces.find((s) => s.id === activeSpaceId) ?? null;
  }, [activeSpaceId, spaces]);

  const [activeManager, setActiveManager] = useState<CanvasSpaceManager | null>(null);

  useEffect(() => {
    // Only canvas Spaces have a runtime manager today. Document /
    // timeline are listed in `meta.spaces` (Tab Bar shows them) but
    // they don't have a Yjs document type wired up yet — the shell
    // renders a placeholder for those kinds.
    if (!activeSpaceId || !projectId || activeSpace?.type !== 'canvas') {
      setActiveManager(null);
      return;
    }
    setActiveManager(getCanvasSpace(activeSpaceId));
    // The pool itself owns lifecycle / LRU eviction; we never destroy here.
  }, [projectId, activeSpaceId, activeSpace?.type, getCanvasSpace]);

  const yjsLoading =
    !!projectId && (metaLoading || (activeSpace?.type === 'canvas' && activeManager === null));

  return {
    manager: activeManager,
    metaManager,
    spaces,
    activeSpaceId,
    activeSpace,
    yjsLoading,
    yjsEnabled: !!projectId,
    projectId,
  };
};
