// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { useQuery } from '@tanstack/react-query';
import * as React from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { toast } from '@web/lib/toast';

import { newId, type SpaceRpcResponse } from '@breatic/shared';
import { projectsApi } from '@web/data/api';
import { useProjectMembers } from '@web/data/use-project-members';
import { useExclusiveOverlay } from '@web/lib/use-exclusive-overlay';
import { projectUuidFromRouteParam } from '@web/lib/project-route';
import { sendSpaceRpc } from '@web/data/yjs/space-rpc-client';
import { CollabSocketProvider } from '@web/data/yjs/collab-socket';
import { docName } from '@web/data/yjs/manager';
import {
  evictCanvasUndoManager,
  evictUndoForVanishedSpaces,
} from '@web/data/yjs/canvas-space';
import { useTranslation } from '@web/i18n/use-translation';
import {
  closeSpaceTab,
  openSpaceTab,
  planVanishedSpaceReconcile,
  useProjectMeta,
  type ProjectSpace,
} from '@web/data/yjs/project-meta';
import { resolveEffectiveActiveSpace } from '@web/pages/project/active-space';
import { useCanvasStore, useCurrentUserStore, useUIStore } from '@web/stores';
import { resetProjectUiStores } from '@web/stores/reset-project-ui';
import { useSpaceOperationsStore } from '@web/stores/space-operations';
import type { SpaceType } from '@web/spaces';

import { ChatPanel } from '@web/pages/project/chat/ChatPanel';
import { AgentColHeader } from '@web/pages/project/chrome/agent-header/AgentColHeader';
import { LoadingOverlay } from '@web/pages/project/chrome/LoadingOverlay';
import { LoadingScreen } from '@web/pages/project/chrome/LoadingScreen';
import { ConnectionBanner } from '@web/pages/project/chrome/ConnectionBanner';
import {
  LeftFloatingMenu,
} from '@web/pages/project/chrome/left-floating-menu/LeftFloatingMenu';
import { SpaceReadOnlySheet } from '@web/pages/project/chrome/tab-bar/SpaceReadOnlySheet';
import { TopBar } from '@web/pages/project/chrome/top-bar/TopBar';
import { useRenameProject } from '@web/pages/project/use-rename-project';
import { useRecordProjectOpen } from '@web/pages/project/use-record-project-open';
import { SpaceTabBar } from '@web/pages/project/chrome/tab-bar/SpaceTabBar';
import { ViewportToolbar } from '@web/pages/project/chrome/viewport-toolbar/ViewportToolbar';
import { SpaceOutlet } from '@web/pages/project/SpaceOutlet';
import { SpaceDocSync } from '@web/pages/project/SpaceDocSync';

/**
 * Project page shell - TopBar above two columns:
 *   - left:  Agent column (320 px, collapsible) - ChatPanel
 *   - right: SpaceTabBar + Space body + floating menus
 *
 * State model (2026-05-21 redesign):
 *   - Shared `spaces` list  → Yjs project-meta `Y.Array('spaces')`
 *   - Per-user `openTabIds` → Yjs project-meta `perUser[userId].openTabIds`
 *   - Active tab → LOCAL page state (user 2026-07-11): it used to live in
 *     the shared per-user subtree, but two machines on the same account
 *     both subscribe to it — machine A's tab click flipped machine B's
 *     active tab and remounted B's running space body. Opening a project
 *     defaults to the first open tab.
 *
 * Collab-only write flow (ADR 2026-05-23 yjs-collab-only-write-authz):
 *   - Create / delete / lock / restore + projectMessages clear all go
 *     through `sendSpaceRpc` (stateless RPC over the live Hocuspocus
 *     connection on the meta doc). Collab authorizes the caller's role,
 *     performs the privileged Yjs write, and broadcasts back. Server
 *     REST routes + Redis pub/sub are gone.
 *   - The client does NOT write `meta.spaces` / `meta.projectMessages`
 *     directly - `beforeHandleMessage` would reject it. A global
 *     loading overlay covers the 50-200ms round trip; a 10-second
 *     timeout guards against a wedged collab.
 */
const SPACE_OP_TIMEOUT_MS = 10_000;

/**
 * Project page shell — resolves the project uuid from the route and gates the
 * shared collab socket on userId, then renders the workspace inside it so every
 * Yjs document hook attaches onto ONE shared WebSocket (#1378 / #1381).
 * @returns The collab-socket-wrapped project workspace.
 */
export default function ProjectPage(): React.JSX.Element {
  const { projectId: routeParam = 'demo' } = useParams<{
    projectId: string;
  }>();
  // The route is `/project/{slug}-{uuid}` (URL design §5.7); the slug is
  // decorative and the backend keys on the bare uuid, so resolve it once here
  // and use it for every API call + the Yjs document name downstream.
  const projectId = projectUuidFromRouteParam(routeParam);
  // Gate the shared collab socket on userId — the #1381 boot-race fix: don't
  // dial until AuthBootstrap has resolved a session, or the first connect
  // races the cookie and sticks on authFailed forever (regressed in v14 reset).
  const userId = useCurrentUserStore((s) => s.user?.id);
  return (
    <CollabSocketProvider userId={userId}>
      <ProjectWorkspace projectId={projectId} />
    </CollabSocketProvider>
  );
}

/**
 * Project workspace rendering the TopBar, the per-user Agent chat column, and
 * the Space tab bar with the active Space body. Every Yjs document hook here
 * attaches onto the shared collab socket from the parent
 * {@link CollabSocketProvider}.
 * @param root0 - Workspace props.
 * @param root0.projectId - Resolved project uuid (slug already stripped).
 * @returns The project workspace, or a loading screen while the socket connects.
 */
function ProjectWorkspace({
  projectId,
}: {
  projectId: string;
}): React.JSX.Element {
  const t = useTranslation();
  const navigate = useNavigate();

  // ---- Project meta (name / credits / role) ----
  const projectQuery = useQuery({
    queryKey: ['project', projectId],
    queryFn: () => projectsApi.get(projectId),
    enabled: projectId !== 'demo',
    // 403 = caller is NOT_MEMBER of this project - bail to the
    // access request page instead of looping a useless retry. The
    // 404 path also short-circuits (project may have been deleted).
    retry: (failureCount, err) => {
      if (err instanceof Error && 'status' in err) {
        const status = (err as { status?: number }).status;
        if (status === 403 || status === 404) return false;
      }
      return failureCount < 2;
    },
  });

  // NOT_MEMBER redirect - caller bounced off a project they can't
  // see → route them to the access request page so they can ask the
  // owner for permission (PR-d NOT_MEMBER path 1).
  React.useEffect(() => {
    if (!projectQuery.error) return;
    const err = projectQuery.error as Error & { status?: number };
    if (err.status === 403) {
      navigate(`/project/${projectId}/access`, { replace: true });
    }
  }, [projectQuery.error, projectId, navigate]);

  // Record the open once the project has loaded — floats it to the top of the
  // cross-studio Recent landing. StrictMode-safe + best-effort (see the hook).
  useRecordProjectOpen(projectId, projectQuery.isSuccess);

  // Reset the per-project UI stores when LEAVING or SWITCHING a project (#1771):
  // the canvas / chrome UI stores are module singletons that survive React
  // unmount, so a Studio round-trip — or an A→B project switch, where this route
  // pattern is unchanged and the component is NOT remounted — would otherwise
  // carry the open Generate panel, pick mode, selection, chat draft, etc. into
  // the next entry. Keyed on projectId so the cleanup fires on BOTH a full
  // unmount and a project-id change; runs on leave only (a fresh entry stays
  // untouched). A `key={projectId}` remount would not help — module singletons
  // don't reset with component-local state.
  React.useEffect(() => () => resetProjectUiStores(), [projectId]);

  const projectName = projectQuery.data?.name ?? 'Untitled project';
  // Fail-safe default: if `myRole` is missing (glitch / pre-load race),
  // treat the caller as the most-restrictive 'viewer' so chrome affordances
  // stay hidden rather than leaking owner/editor actions (user 2026-06-18).
  const role = projectQuery.data?.myRole ?? 'viewer';
  // Viewer affordance model (access-permission § 6.2, option B): the canvas
  // left creation menu stays visible + disabled (LeftFloatingMenu) and the
  // canvas body is read-only (SpaceOutlet); everything else a viewer cannot
  // do is HIDDEN (Agent column, share, manage, new-space, title edit). The
  // upgrade entry lives on the top-bar RoleTag.
  const isViewer = role === 'viewer';
  const credits = 0;

  // Rename mutation (optimistic header update + studio-list refresh). Extracted
  // to `useRenameProject` so the cross-query invalidation (#1068) is unit-tested
  // in isolation rather than buried in this heavy page component.
  const renameMutation = useRenameProject(projectId);

  // ---- Project members (TopBar MembersStack) ----
  // Real member list backing the top-bar avatar stack + popover. The roster
  // is split across two endpoints (role relation + profiles) and merged into
  // the `Member` shape by `useProjectMembers`. The backend
  // `GET /projects/:id/members` is membership-gated; viewers can still read
  // the roster (the gating is on *mutations*, not the list).
  const { members } = useProjectMembers(projectId);

  // ---- Current user + Yjs meta + project messages ----
  const userId = useCurrentUserStore((s) => s.user?.id);
  // Chrome → canvas mailbox: the node-library dropdown posts the picked type
  // here; the canvas resolves the viewport-centre drop point (see CanvasSpace).
  const requestNodeCreate = useCanvasStore((s) => s.requestNodeCreate);
  // Upload-button path: chrome owns the hidden file picker (it must open
  // synchronously inside the button click to keep the browser's user-
  // activation) and posts the picked files to the canvas via this mailbox.
  const requestUpload = useCanvasStore((s) => s.requestUpload);
  // A running reference pick slides the floating chrome out of the way
  // (batch-2 item 13): the canvas is a selection surface for that session and
  // the menus would only distract / steal clicks. Boolean selector so chrome
  // re-renders on pick enter/exit only, not on every picked-node change.
  // Any canvas pick (reference or style) turns the canvas into a selection
  // surface, so chrome menus are concealed for the duration of either.
  const picking = useCanvasStore((s) => s.pickSession !== null);
  const uploadInputRef = React.useRef<HTMLInputElement>(null);
  const {
    spaces,
    openTabIds,
    provider,
    status: connectionStatus,
  } = useProjectMeta(projectId, userId);
  // The active tab is LOCAL window state — deliberately NOT in the synced
  // meta doc (see module doc). null = no local choice yet → the effective
  // active falls back to the first open tab.
  const [activeSpaceId, setActiveSpaceId] = React.useState<string | null>(
    null,
  );

  // Tabs shown in the tab bar = each open tab id resolved against the
  // shared spaces list (drop missing ids - happens if another user
  // deleted a Space while we had it open).
  const openTabs: ReadonlyArray<ProjectSpace> = React.useMemo(
    () =>
      openTabIds
        .map((id) => spaces.find((s) => s.id === id))
        .filter((s): s is ProjectSpace => Boolean(s)),
    [openTabIds, spaces],
  );

  const activeSpace: ProjectSpace | undefined = resolveEffectiveActiveSpace(
    openTabs,
    activeSpaceId,
  );

  // Clear the undo history of spaces that have VANISHED (deleted locally or by
  // a collaborator) while still in this user's openTabIds. Such a tab drops out
  // of `openTabs` above without going through `onCloseTab`, so its cached undo
  // manager would otherwise leak — and a restore under the same id would bring
  // back the stale pre-delete stack. This makes "the space left → undo cleared"
  // hold for the deletion path too, not just explicit tab close.
  React.useEffect(() => {
    evictUndoForVanishedSpaces(
      projectId,
      openTabIds,
      new Set(spaces.map((s) => s.id)),
    );
  }, [projectId, openTabIds, spaces]);

  // Reconcile this user's per-user tab state when spaces vanish (deleted
  // locally or by a collaborator). Delete goes through the `space:delete` RPC,
  // NOT `onCloseTab`, so without this the active space could be a now-deleted
  // id: the canvas renders the `?? openTabs[0]` fallback but no tab is
  // highlighted (activeSpaceId still points at the gone space). This prunes the
  // vanished tab ids and, if the active one vanished, activates the first
  // still-visible tab (or the empty state when none remain). Per-user + runs on
  // every client, so the deleter AND collaborators each converge their own
  // state. Local Yjs writes apply even on a viewer's read-only connection
  // (they just don't persist), so the UI stays consistent for everyone.
  React.useEffect(() => {
    if (!userId) return;
    const liveIds = new Set(spaces.map((s) => s.id));
    const { tabsToClose, reactivateTo } = planVanishedSpaceReconcile(
      openTabIds,
      liveIds,
      activeSpaceId,
    );
    for (const id of tabsToClose) closeSpaceTab(projectId, userId, id);
    if (reactivateTo !== undefined) {
      setActiveSpaceId(reactivateTo);
    }
  }, [userId, projectId, openTabIds, spaces, activeSpaceId]);

  // Note: NO URL ↔ active-space reconcile. Per user decision
  // `[[feedback_space_type_vs_route]]`, Space is a type/template, not
  // a route segment; the open-tab LIST is per-user Yjs state (syncs
  // across the same user's machines), while the ACTIVE tab is local
  // window state only. URL stays `/project/:id`.

  // ---- Loading overlay tracking ----
  const spaceOpInProgress = useUIStore((s) => s.spaceOpInProgress);
  const setSpaceOpInProgress = useUIStore((s) => s.setSpaceOpInProgress);
  const readOnlyViewSpaceId = useUIStore((s) => s.readOnlyViewSpaceId);
  const setReadOnlyViewSpaceId = useUIStore((s) => s.setReadOnlyViewSpaceId);
  const [roSheetOpen, setRoSheetOpen] = useExclusiveOverlay(
    'space-readonly-sheet',
  );

  const pendingCreateIdRef = React.useRef<string | null>(null);

  // Auto-dismiss the create loading overlay when the new space id
  // appears in the live Yjs spaces map. Delete intentionally has no
  // overlay (fast op, the tab vanishing is the user-visible signal).
  React.useEffect(() => {
    if (spaceOpInProgress === 'creating' && pendingCreateIdRef.current) {
      const id = pendingCreateIdRef.current;
      if (spaces.some((s) => s.id === id)) {
        pendingCreateIdRef.current = null;
        setSpaceOpInProgress(null);
        if (userId) {
          openSpaceTab(projectId, userId, id);
          setActiveSpaceId(id);
        }
      }
    }
    // Delete no longer uses spaceOpInProgress - see onDeleteSpace.
  }, [spaces, spaceOpInProgress, projectId, userId, setSpaceOpInProgress]);

  // Safety timeout - if the collab broadcast never lands, free the UI
  // and surface a toast so the user can retry rather than stare at a
  // wedged spinner.
  React.useEffect(() => {
    if (spaceOpInProgress === null) return;
    const handle = setTimeout(() => {
      setSpaceOpInProgress(null);
      pendingCreateIdRef.current = null;
      toast.error(t('project.space.timeout.create'), {
        description: t('project.space.timeout.retry'),
      });
    }, SPACE_OP_TIMEOUT_MS);
    return () => clearTimeout(handle);
  }, [spaceOpInProgress, setSpaceOpInProgress, t]);

  // Warn before a browser tab / window close while any space has an in-flight
  // front-end operation (#1617). Unlike a space-tab close (which we block), the
  // browser only allows a generic, non-customizable prompt — it cannot be
  // blocked — so this is a best-effort guard against losing an upload whose
  // local Yjs write-back has not synced yet. Reads the registry at event time so
  // the listener never needs re-attaching.
  React.useEffect(() => {
    /**
     * beforeunload handler: trigger the browser's generic close prompt while any
     * space has an in-flight front-end operation (#1617).
     * @param event - The beforeunload event.
     */
    const onBeforeUnload = (event: BeforeUnloadEvent): void => {
      if (!useSpaceOperationsStore.getState().hasAnyOperations()) return;
      event.preventDefault();
      // Legacy browsers require a returnValue to trigger the prompt; modern ones
      // show their own generic message and ignore the string.
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, []);

  // ---- Local view UI state ----
  const collapsed = useUIStore((s) => s.chatPanelCollapsed);
  // Zoom is owned by the canvas (the ReactFlow viewport): the canvas mirrors the
  // live zoom into the store for this read-out, and the toolbar posts zoom
  // commands back through the store mailbox (consumed inside the canvas).
  const zoom = useCanvasStore((s) => s.zoom);
  const requestViewportCommand = useCanvasStore(
    (s) => s.requestViewportCommand,
  );
  // Undo/redo availability is mirrored by the canvas (which owns the per-space
  // undo manager); the toolbar posts commands back through the store mailbox.
  const canUndo = useCanvasStore((s) => s.canUndo);
  const canRedo = useCanvasStore((s) => s.canRedo);
  const requestHistoryCommand = useCanvasStore(
    (s) => s.requestHistoryCommand,
  );
  // Minimap visibility + snap-to-grid live in the canvas store (single source,
  // #1548): the toolbar toggles them here, the canvas reads them off the store
  // (the previous local useState for snap never reached the canvas — dead toggle).
  const minimapVisible = useCanvasStore((s) => s.minimapVisible);
  const toggleMinimap = useCanvasStore((s) => s.toggleMinimap);
  const snapToGrid = useCanvasStore((s) => s.snapToGrid);
  const toggleSnapToGrid = useCanvasStore((s) => s.toggleSnapToGrid);

  // ---- Handlers ----

  /**
   * Activate a Space - open the tab if not open + mark active.
   * @param id - The Space id to open and mark active.
   */
  const onActivate = (id: string): void => {
    if (!userId) return; // pre-auth no-op (per-user UI state needs userId)
    openSpaceTab(projectId, userId, id);
    setActiveSpaceId(id);
  };

  /**
   * Close a Space tab - does NOT delete the Space; just removes from
   *  this user's tab bar.
   * @param id - The Space id to remove from this user's open tabs.
   */
  const onCloseTab = (id: string): void => {
    if (!userId) return;
    // Block closing a space tab while it has an in-flight FRONT-END operation
    // (e.g. an upload). Closing a tab detaches that space's Yjs doc; if the user
    // never reopens the space, the operation's local write-back never syncs =
    // lost work (#1617). Backend AIGC is unaffected — it writes back through the
    // server-side collab doc, independent of the tab — so it is deliberately not
    // tracked in this registry (only front-end operations register).
    if (useSpaceOperationsStore.getState().hasOperations(id)) {
      toast.warning(t('canvas.close.operationInProgress'));
      return;
    }
    closeSpaceTab(projectId, userId, id);
    // Closing a tab clears that space's undo / redo history: evict its cached
    // undo manager so reopening the space starts empty (no-op for non-canvas
    // spaces, which have no manager). The space's Y.Doc stays cached for an
    // instant reopen — only the undo stack is discarded.
    evictCanvasUndoManager(docName.canvasSpace(projectId, id));
    if (id === activeSpace?.id) {
      const next = openTabs.find((s) => s.id !== id);
      setActiveSpaceId(next?.id ?? null);
    }
  };

  /**
   * Send a Space-lifecycle RPC over the live meta-doc Hocuspocus
   * connection. Throws if the provider isn't mounted yet (the UI gates
   * actions behind `synced`) or the server reports a non-ok response.
   */
  const callRpc = React.useCallback(
    async (
      req: Parameters<typeof sendSpaceRpc>[1],
      errorToastKey: string,
    ): Promise<SpaceRpcResponse> => {
      if (!provider) {
        // Surface a toast on the "no provider yet" path too - without this
        // the catch block in callers received a silent `Error('notSynced')`
        // and (because `err.message.length > 0`) the fallback toast was
        // skipped, leaving the user staring at a dismissed dialog and no
        // explanation (2026-05-25 P0 silent-fail).
        const msg = t('project.space.error.notSynced');
        toast.error(t(errorToastKey), { description: msg });
        throw new Error(msg);
      }
      const res = await sendSpaceRpc(provider, req);
      if (!res.ok) {
        toast.error(t(errorToastKey), { description: res.error.message });
        throw new Error(res.error.message);
      }
      return res;
    },
    [provider, t],
  );

  /**
   * Create a Space - client-side uuid id (ADR B1.1) + `space:create`
   * RPC. The collab process applies the write under the system user;
   * the effect above auto-opens the new tab and dismisses the overlay
   * when the doc broadcast lands.
   * @param type - The Space template type to instantiate.
   * @param name - The display name for the new Space.
   */
  const onCreateSpace = async (
    type: SpaceType,
    name: string,
  ): Promise<void> => {
    setSpaceOpInProgress('creating');
    const spaceId = newId();
    // Pin the pending id BEFORE the RPC await - Yjs sync from collab
    // can race ahead of the RPC ack (collab broadcasts the meta-doc
    // mutation as soon as space-rpc transact runs, which often beats
    // the broadcastStateless response by a few ms). If we only set
    // pendingCreateIdRef after `await callRpc`, the spaces-watching
    // effect re-runs on the Yjs update with the ref still null,
    // misses the match, and the safety timeout (SPACE_OP_TIMEOUT_MS)
    // fires even though everything succeeded.
    pendingCreateIdRef.current = spaceId;
    try {
      await callRpc(
        {
          type: 'space:create',
          payload: { spaceId, type, name },
        },
        'project.space.error.create',
      );
    } catch (err) {
      setSpaceOpInProgress(null);
      pendingCreateIdRef.current = null;
      // toast already raised inside callRpc when the RPC reports !ok
      if (!(err instanceof Error) || !err.message.length) {
        toast.error(t('project.space.error.create'));
      }
      throw err;
    }
  };

  /** Soft-delete a Space - `space:delete` RPC. */
  /**
   * Delete is fast (~50-200ms) and already self-evident in the UI -
   * the deleted tab vanishes the moment Yjs sync lands. Showing the
   * full-screen LoadingOverlay for that window just flashes a black
   * backdrop in and out, which the user reads as flicker rather than
   * progress. The SpaceDrawer row keeps its own inline `deleteBusy`
   * spinner to prevent double-click within the same row.
   *
   * Errors still surface - callRpc raises a toast on RPC failure.
   * @param spaceId - The id of the Space to soft-delete.
   */
  const onDeleteSpace = async (spaceId: string): Promise<void> => {
    await callRpc(
      { type: 'space:delete', payload: { spaceId } },
      'spaces.drawer.action.deleteFail',
    );
  };

  /**
   * Toggle Space lock - `space:lock` RPC (lock + unlock same handler).
   * @param spaceId - The id of the Space to lock or unlock.
   * @param locked - The desired lock state (true to lock, false to unlock).
   */
  const onSetSpaceLocked = async (
    spaceId: string,
    locked: boolean,
  ): Promise<void> => {
    await callRpc(
      { type: 'space:lock', payload: { spaceId, locked } },
      locked
        ? 'spaces.drawer.action.lockFail'
        : 'spaces.drawer.action.unlockFail',
    );
  };

  /**
   * Rename a Space's name - `space:rename` RPC. Caller role ≥ edit.
   * Locked Spaces refuse rename on the server side and the failure
   * toast surfaces via callRpc. The 80-char cap mirrors the project
   * title - enforced both on the client (`SPACE_NAME_MAX_LEN`) and
   * on the server (`SpaceRenamePayloadSchema`).
   * @param spaceId - The id of the Space to rename.
   * @param name - The new Space name (capped at 80 chars).
   */
  const onRenameSpace = async (
    spaceId: string,
    name: string,
  ): Promise<void> => {
    await callRpc(
      { type: 'space:rename', payload: { spaceId, name } },
      'spaces.rename.error.failed',
    );
  };

  /**
   * Owner-only: restore a soft-deleted Space - `space:restore` RPC.
   * @param spaceId - The id of the soft-deleted Space to restore.
   */
  const onRestoreSpace = async (spaceId: string): Promise<void> => {
    await callRpc(
      { type: 'space:restore', payload: { spaceId } },
      'project.space.error.create',
    );
  };

  /**
   * Open the read-only preview sheet for a Space.
   * @param id - The id of the Space to preview read-only.
   */
  const onViewSpace = (id: string): void => {
    setReadOnlyViewSpaceId(id);
    setRoSheetOpen(true);
  };

  // Resolve the currently-previewed Space (if any) for the read-only
  // sheet. Bail to null if it's missing (race with deletion).
  const readOnlySpace = React.useMemo(() => {
    if (!readOnlyViewSpaceId) return null;
    return spaces.find((s) => s.id === readOnlyViewSpaceId) ?? null;
  }, [readOnlyViewSpaceId, spaces]);

  // Defer project page mount until the websocket has reached a final
  // state (connected / authFailed / disconnected). Without this gate,
  // `connecting` (the initial state from useSocket) makes the banner +
  // overlay return null on first paint - the user sees a clean project
  // page for a few hundred ms, then banner + overlay pop in on the next
  // frame when auth fails (visible "page → flash banner+overlay"
  // jitter, 2026-05-26 user spec). Showing LoadingScreen during
  // `connecting` lets the final-state DOM mount atomically.
  if (connectionStatus === 'connecting') {
    return <LoadingScreen />;
  }

  // When the WS auth has failed, the workspace below the banner is
  // unusable - any mutation (create space, send chat, edit node) will
  // silently fail because the same expired token is sent to the API +
  // collab. Cover it with a full-area `bg-black/80` overlay that
  // (a) matches the LoadingOverlay / Dialog backdrop dim pattern used
  //     elsewhere in the app (single visual vocabulary for "blocked"),
  // (b) intercepts clicks via `onClick` + `preventDefault` so users
  //     can't trigger half-broken flows like "creating Space..." that
  //     never resolves (2026-05-26 user smoke report),
  // (c) surfaces the OS-level "not-allowed" cursor on hover so users
  //     get an instant, language-agnostic affordance that this region
  //     is intentionally inert.
  // Banner itself sits OUTSIDE the wrapper so its "re-login" / "refresh"
  // actions stay clickable.
  const workspaceDisabled = connectionStatus === 'authFailed';

  return (
    <div className='flex h-screen w-screen flex-col bg-background text-foreground'>
      {/* Keep every OPEN Space tab's Yjs doc attached to the shared collab
          socket. Attach follows tab open / close — NOT the active tab — so
          background tabs stay live and re-activating one is instant (user
          requirement 2026-06-18). Renders nothing. */}
      {openTabs.map((tab) => (
        <SpaceDocSync
          key={tab.id}
          projectId={projectId}
          spaceId={tab.id}
          type={tab.type}
        />
      ))}
      <ConnectionBanner
        status={connectionStatus}
        onReload={() => window.location.reload()}
        onReLogin={() => {
          // Carry the current path as `?next=` so the login page can
          // bounce back to the project after a successful re-auth.
          navigate(
            `/login?next=${encodeURIComponent(window.location.pathname)}`,
          );
        }}
      />
      <div
        className='relative flex min-h-0 flex-1 flex-col'
        aria-hidden={workspaceDisabled || undefined}
        data-workspace-disabled={workspaceDisabled || undefined}
      >
        <TopBar
          projectId={projectId}
          projectName={projectName}
          role={role}
          credits={credits}
          onRename={(next) => renameMutation.mutate(next)}
          members={members}
          currentUserId={userId}
        />
        <div className='flex min-h-0 flex-1'>
          {/* Agent column is hidden for viewers (B model — not rendered,
              not just disabled) AND when the user has collapsed it. The
              backend gates agent chat on role; this hide is UX only. */}
          {collapsed || isViewer ? null : (
            <aside
              data-testid='agent-column'
              className='flex w-[320px] shrink-0 flex-col border-r border-border bg-card'
            >
              <AgentColHeader
                conversationName='New conversation'
                messageCount={0}
                onOpenHistory={() => {
                /* wired in ChatPanel B-mode round */
                }}
                onNewConversation={() => {
                /* wired in ChatPanel B-mode round */
                }}
                onRenameConversation={() => {
                /* wired when conversation API lands */
                }}
              />
              <ChatPanel projectId={projectId} disabled={isViewer} />
            </aside>
          )}
          <section className='flex min-w-0 flex-1 flex-col'>
            <SpaceTabBar
              spaces={openTabs}
              allSpaces={spaces}
              openTabIds={openTabIds}
              activeSpaceId={activeSpace?.id ?? ''}
              projectId={projectId}
              onActivate={onActivate}
              onCreate={onCreateSpace}
              onClose={onCloseTab}
              onViewSpace={onViewSpace}
              onDeleteSpace={onDeleteSpace}
              onSetSpaceLocked={onSetSpaceLocked}
              onRenameSpace={onRenameSpace}
              metaProvider={provider}
              currentUserRole={role}
              onRestoreSpace={onRestoreSpace}
            />
            {/* overflow-hidden: the pick-mode chrome slide-out (batch-2 item
                13) must exit THROUGH this section's edges — without the clip
                the left menu slides on top of the chat sidebar instead of
                disappearing (caught by the real-browser screenshot). Floating
                UI that must escape the box (menus / tooltips) portals to
                document.body and is unaffected. */}
            <div className='relative flex-1 overflow-hidden'>
              {activeSpace ? (
                // key on the Space id so switching tabs REMOUNTS the body —
                // ReactFlow re-runs fitView so the camera frames the new
                // Space's nodes (#1378). Cheap now: remount only re-binds the
                // already-attached doc, it does not rebuild a WebSocket.
                <SpaceOutlet
                  key={activeSpace.id}
                  projectId={projectId}
                  spaceId={activeSpace.id}
                  type={activeSpace.type}
                  readOnly={isViewer}
                />
              ) : (
                <div
                  data-testid='no-active-space'
                  className='flex h-full w-full items-center justify-center text-sm text-muted-foreground'
                >
                  {t('project.space.noActive')}
                </div>
              )}
              {activeSpace?.type === 'canvas' ? (
                <>
                  <input
                    ref={uploadInputRef}
                    type='file'
                    multiple
                    accept='image/*,video/*,audio/*,text/*'
                    hidden
                    data-testid='canvas-upload-input'
                    onChange={(e) => {
                      const files = e.target.files;
                      if (files && files.length > 0) {
                        requestUpload([...files]);
                      }
                      // Reset so picking the same file again re-fires change.
                      e.target.value = '';
                    }}
                  />
                  <LeftFloatingMenu
                    disabled={isViewer}
                    concealed={picking}
                    onCreateNode={requestNodeCreate}
                    onPick={(tool) => {
                      // Open the file picker synchronously inside the click so
                      // the browser keeps user-activation; the canvas fulfils
                      // the picked files via the upload mailbox.
                      if (tool === 'upload') uploadInputRef.current?.click();
                      // comment    - enter annotation mode (later slice)
                      // collection - placeholder (M1+)
                      // help       - placeholder (M1+)
                      // feedback   - placeholder (M1+)
                      // Buttons never store a "selected" state - fire and forget.
                      // The node-library (`nodes`) button owns its own dropdown.
                    }}
                  />
                  <ViewportToolbar
                    zoom={zoom}
                    concealed={picking}
                    minimapVisible={minimapVisible}
                    snapToGrid={snapToGrid}
                    canUndo={canUndo}
                    canRedo={canRedo}
                    onZoomIn={() => requestViewportCommand('zoomIn')}
                    onZoomOut={() => requestViewportCommand('zoomOut')}
                    onZoomChange={(z) => requestViewportCommand({ zoomTo: z })}
                    onFit={() => requestViewportCommand('fit')}
                    onToggleSnap={toggleSnapToGrid}
                    onToggleMinimap={toggleMinimap}
                    onUndo={() => requestHistoryCommand('undo')}
                    onRedo={() => requestHistoryCommand('redo')}
                  />
                </>
              ) : null}
            </div>
          </section>
        </div>
        {workspaceDisabled ? (
          <div
            className='absolute inset-0 z-40 cursor-not-allowed bg-black/80'
            onClick={(e) => e.preventDefault()}
            onMouseDown={(e) => e.preventDefault()}
            aria-hidden
            data-testid='workspace-disabled-overlay'
          />
        ) : null}
      </div>
      <SpaceReadOnlySheet
        open={roSheetOpen}
        space={readOnlySpace}
        onClose={() => {
          setRoSheetOpen(false);
          setReadOnlyViewSpaceId(null);
        }}
      />
      {spaceOpInProgress === 'creating' ? (
        <LoadingOverlay
          message={t('project.space.loading.create')}
          testId='creating-space-overlay'
        />
      ) : null}
    </div>
  );
}
