/**
 * SpaceShell — the chrome around the active Space (Tab Bar + Space
 * content area). This is the v10 `_shell` per-project entry point;
 * `pages/project` mounts it once below the global TopBar.
 *
 * Owns:
 *   - `useTabState`: persists `lastActiveTabId` + `openTabs` to
 *     `meta.userStates[userId]` so cross-device tab state syncs (per
 *     v10 §8). The first time the user opens this project on a new
 *     device, the last-active tab is restored.
 *   - Tab Bar wiring: select / close / new — translates these into
 *     `useTabState` patches + `projectSpacesApi.{create,remove}` calls.
 *   - Space-content dispatch: when active is canvas, render
 *     `ProjectCanvas` with the matching manager from `useProjectSpaces`;
 *     when active is document/timeline, render `PlaceholderSpace`.
 *
 * Out of scope (V1):
 *   - Drag-reorder of tabs
 *   - In-tab rename (right-click context menu in Drawer ships first)
 *   - Drawer (full "all spaces" overflow / lock toggle / delete-with-
 *     confirm) — follow-up enhancement
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTabState } from '@/domain/space/useTabState';
import { useProjectSpaces } from '@/domain/space/useProjectSpaces';
import * as projectSpacesApi from '@/data/api/project-spaces';
import ProjectCanvas from '@/spaces/canvas';
import PlaceholderSpace from '@/spaces/_shell/PlaceholderSpace';
import TabBar from '@/spaces/_shell/TabBar';
import NewSpaceDialog from '@/spaces/_shell/NewSpaceDialog';

export interface SpaceShellProps {
  /** From the page-level `useProjectSpaces` orchestrator. */
  yjs: ReturnType<typeof useProjectSpaces>;
  /** Caller's userId — required to drive `useTabState` (per-user tab state). */
  userId: string | null;
  /** Forwarded to ProjectCanvas — disables canvas hotkeys when the
   *  right-side editor (e.g. text editor) has focus. */
  hotkeysDisabled?: boolean;
}

const SpaceShell: React.FC<SpaceShellProps> = ({ yjs, userId, hotkeysDisabled }) => {
  const { spaces, projectId, metaManager } = yjs;

  // Per-user tab state (v10 §8 / `meta.userStates[userId]`).
  const { state: tabState, setState: setTabState } = useTabState(
    projectId,
    userId,
    metaManager,
  );

  // The shell-driven activeSpaceId. Falls back to "first canvas" until
  // useTabState reads its initial value from meta.userStates. Once the
  // user clicks a tab, our local state takes over and writes back via
  // setTabState (debounced 1 s).
  const [localActiveId, setLocalActiveId] = useState<string | null>(null);

  // Adopt tabState's lastActiveTabId on first load (when local is
  // still null), and whenever the tabState resyncs.
  useEffect(() => {
    if (localActiveId !== null) return;
    if (tabState.lastActiveTabId) setLocalActiveId(tabState.lastActiveTabId);
  }, [tabState.lastActiveTabId, localActiveId]);

  // Active spaceId fed back into useProjectSpaces. Validated against
  // `meta.spaces` so a stale id from `meta.userStates` (Space deleted
  // by another collaborator) doesn't try to render a missing tab.
  const activeIdResolved = useMemo<string | null>(() => {
    const id = localActiveId ?? tabState.lastActiveTabId;
    if (!id) return null;
    return spaces.some((s) => s.id === id) ? id : null;
  }, [localActiveId, tabState.lastActiveTabId, spaces]);

  // The active space row (for kind dispatch + tab UI).
  const activeSpace = useMemo(
    () => spaces.find((s) => s.id === activeIdResolved) ?? spaces.find((s) => s.type === 'canvas') ?? null,
    [spaces, activeIdResolved],
  );
  const effectiveActiveId = activeSpace?.id ?? null;

  const handleSelect = useCallback(
    (spaceId: string) => {
      if (spaceId === effectiveActiveId) return;
      setLocalActiveId(spaceId);
      setTabState({
        lastActiveTabId: spaceId,
        lastVisitedAt: Date.now(),
      });
    },
    [effectiveActiveId, setTabState],
  );

  const handleClose = useCallback(
    async (spaceId: string) => {
      if (!projectId) return;
      // Server soft-deletes the yjs_documents row + publishes
      // `space:deleted` → Collab removes meta.spaces[spaceId]. Our
      // useProjectMeta observer will then update `spaces` reactively.
      try {
        await projectSpacesApi.remove(projectId, spaceId);
      } catch {
        // Silent — toast handling is the global error boundary's job
        // and a 4xx leaves the tab visible (consistent with reality).
      }
    },
    [projectId],
  );

  const [newSpaceOpen, setNewSpaceOpen] = useState(false);

  const handleCreated = useCallback(
    (newSpaceId: string) => {
      // Adopt the new tab as active immediately. The Yjs sync that
      // surfaces meta.spaces[id] will land milliseconds later — by
      // then our local state already points at the right id, so
      // useProjectSpaces resolves it cleanly.
      setLocalActiveId(newSpaceId);
      setTabState({
        lastActiveTabId: newSpaceId,
        lastVisitedAt: Date.now(),
      });
    },
    [setTabState],
  );

  const renderContent = () => {
    if (!activeSpace) {
      // No spaces yet, or still loading the meta doc. The page-level
      // loading overlay (Suspense fallback in the router) covers
      // this; we render nothing locally to avoid double overlays.
      return null;
    }
    if (activeSpace.type === 'canvas') {
      return <ProjectCanvas yjs={yjs} hotkeysDisabled={hotkeysDisabled} />;
    }
    return <PlaceholderSpace kind={activeSpace.type} />;
  };

  return (
    <div className="flex flex-col h-full w-full min-h-0">
      <TabBar
        spaces={spaces}
        activeSpaceId={effectiveActiveId}
        onSelect={handleSelect}
        onClose={handleClose}
        onNewSpace={() => setNewSpaceOpen(true)}
      />
      <div className="flex-1 min-h-0 relative">{renderContent()}</div>
      <NewSpaceDialog
        open={newSpaceOpen}
        onClose={() => setNewSpaceOpen(false)}
        projectId={projectId}
        defaultKind="canvas"
        onCreated={handleCreated}
      />
    </div>
  );
};

export default SpaceShell;
