// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { useQuery } from '@tanstack/react-query';

import { fetchProjectCredits } from '@web/data/api/credits';
import * as React from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { toast } from '@web/lib/toast';

import { newId, type SpaceRpcResponse } from '@breatic/shared';
import { projectsApi } from '@web/data/api';
import {
  useProjectMembers,
  useRosterRefreshOnJoin,
} from '@web/data/use-project-members';
import { CollaboratorNamesProvider } from '@web/features/collab-editor/collaborator-names-context';
import { useCollaboratorNamesFrom } from '@web/features/collab-editor/use-collaborator-names';
import { useExclusiveOverlay } from '@web/lib/use-exclusive-overlay';
import { projectUuidFromRouteParam } from '@web/lib/project-route';
import { useBlockSelectAll } from '@web/lib/use-block-select-all';
import { useTrackActiveRegion } from '@web/lib/use-track-active-region';
import { sendSpaceRpc } from '@web/data/yjs/space-rpc-client';
import { CollabSocketProvider } from '@web/data/yjs/collab-socket';
import { docName } from '@web/data/yjs/manager';
import {
  evictCanvasUndoManager,
  evictUndoForVanishedSpaces,
} from '@web/data/yjs/canvas-space';
import { useTranslation } from '@web/i18n/use-translation';
import { evictDocumentEditor } from '@web/spaces/document/document-editor-cache';
import {
  useProjectMeta,
  type ProjectSpace,
} from '@web/data/yjs/project-meta';
import {
  resolveEffectiveActiveSpace,
  reviseTabChoice,
} from '@web/pages/project/active-space';
import { useCanvasStore, useCurrentUserStore, useUIStore } from '@web/stores';
import { resetProjectUiStores } from '@web/stores/reset-project-ui';
import { LeaveProjectGuard } from '@web/pages/project/LeaveProjectGuard';
import { useSpaceOperationsStore } from '@web/stores/space-operations';
import type { SpaceType } from '@web/spaces';

import { AgentColumn } from '@web/pages/project/chrome/AgentColumn';
import { LoadingOverlay } from '@web/pages/project/chrome/LoadingOverlay';
import { LoadingScreen } from '@web/pages/project/chrome/LoadingScreen';
import { ConnectionBanner } from '@web/pages/project/chrome/ConnectionBanner';
import {
  LeftFloatingMenu,
} from '@web/pages/project/chrome/left-floating-menu/LeftFloatingMenu';
import { SpaceReadOnlySheet } from '@web/pages/project/chrome/tab-bar/SpaceReadOnlySheet';
import { TopBar, toCreditsReadout } from '@web/pages/project/chrome/top-bar/TopBar';
import { useRenameProject } from '@web/pages/project/use-rename-project';
import { useTabReorder } from '@web/pages/project/use-tab-reorder';
import { useRecordProjectOpen } from '@web/pages/project/use-record-project-open';
import { SpaceTabBar } from '@web/pages/project/chrome/tab-bar/SpaceTabBar';
import { ViewportToolbar } from '@web/pages/project/chrome/viewport-toolbar/ViewportToolbar';
import { SpaceOutlet } from '@web/pages/project/SpaceOutlet';
import { SpaceDocSync } from '@web/pages/project/SpaceDocSync';
import {
  Group,
  Panel,
  Separator as ResizeSeparator,
} from 'react-resizable-panels';
import { ScrollArea } from '@web/components/ui/scroll-area';
import {
  AGENT_COLUMN_MAX_WIDTH,
  AGENT_COLUMN_MIN_WIDTH,
  AGENT_PANEL_ID,
  PAGE_MIN_WIDTH,
  RESIZE_HANDLE_WIDTH,
  SPACE_MIN_WIDTH,
} from '@web/pages/project/agent-column-width';
import { useAgentColumnWidth } from '@web/pages/project/use-agent-column-width';

/**
 * Undoes the library's inner wrapper, which is a block box with
 * `overflow: auto` hard-coded. Both columns lay their children out with flex
 * and own their scrolling, so the wrapper has to hand both back.
 */
const PANEL_STYLE = { display: 'flex', overflow: 'visible' } as const;

/**
 * Project page shell - TopBar above two columns:
 *   - left:  Agent column (320..640 px, drag to resize, collapsible) - AgentColumn
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
 * Collab-only write flow:
 *   - Create / delete / lock / rename / restore, and each person's own
 *     tab bar, all go through `sendSpaceRpc` (stateless RPC over the live
 *     Hocuspocus connection on the meta doc). Collab checks the caller's
 *     role, makes the privileged Yjs write, and broadcasts back. Server
 *     REST routes + Redis pub/sub are gone.
 *   - The client writes NOTHING in the meta doc. Its connection to that
 *     doc is read-only at the framework level, so a direct write does not
 *     fail loudly — it simply never lands. A global loading overlay
 *     covers the 50-200ms round trip; a 10-second timeout guards against
 *     a wedged collab.
 *   - Creating a Space returns an id the client did not choose, so the
 *     machine that asked recognises it by the claim token it sent, which
 *     comes back on the entry.
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

  // Follow the user between the two regions, so the canvas keyboard and
  // clipboard gates and the active-state colours read the same value.
  useTrackActiveRegion();

  // Mounted here rather than app-wide, so select-all on the studio routes and
  // the login page stays as it was.
  useBlockSelectAll();

  // Reset the per-project UI stores when LEAVING or SWITCHING a project (#1771):
  // the canvas / chrome UI stores are module singletons that survive React
  // unmount, so a Studio round-trip — or an A→B project switch, where this route
  // pattern is unchanged and the component is NOT remounted — would otherwise
  // carry the open Generate panel, pick mode, selection, chat draft, etc. into
  // the next entry. Keyed on projectId so the cleanup fires on BOTH a full
  // unmount and a project-id change; runs on leave only (a fresh entry stays
  // untouched). A `key={projectId}` remount would not help — module singletons
  // don't reset with component-local state.
  React.useEffect(() => () => resetProjectUiStores(projectId), [projectId]);

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
  // Its own query, so a generation can refresh what the pool has left without
  // refetching the project's name and role, which do not change with it.
  const creditsQuery = useQuery({
    queryKey: ['project', projectId, 'credits'],
    queryFn: () => fetchProjectCredits(projectId),
    enabled: projectId !== 'demo',
  });
  const credits = toCreditsReadout(creditsQuery);

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
  // The same roster names the collaborators whose carets show up inside the
  // space bodies (#1882). Derived here rather than fetched again down there:
  // one query, one answer, and space bodies stay free of a data dependency.
  const collaboratorNames = useCollaboratorNamesFrom(members);

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
    users,
    status: connectionStatus,
  } = useProjectMeta(projectId, userId);
  // Somebody's `online` turning true is the one moment we know a name might be
  // new to us, so it is the one trigger for re-reading the roster (#1882).
  // Unconditional on purpose: no filtering on whether we already know the id,
  // which would have quietly kept showing the old name for everyone listed.
  useRosterRefreshOnJoin(projectId, users);
  // The active tab is LOCAL window state — deliberately NOT in the synced
  // meta doc (see module doc). null = no local choice yet → the effective
  // active falls back to the first open tab.
  const [activeSpaceId, setActiveSpaceId] = React.useState<string | null>(
    null,
  );

  /**
   * Send a Space-lifecycle RPC over the live meta-doc Hocuspocus
   * connection. Always throws on failure, and always shows a toast first —
   * every caller relies on that, ending in an empty `.catch()` because the
   * user has already been told. There are three ways to fail and all three
   * go through here: the provider is not mounted yet (the UI gates actions
   * behind `synced`), the request never came back (`sendSpaceRpc` rejects on
   * its 10s timeout, or the transport throws), or the server answered no.
   */
  const callRpc = React.useCallback(
    async (
      req: Parameters<typeof sendSpaceRpc>[1],
      errorToastKey: string,
      unansweredToastKey?: string,
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
      let res: SpaceRpcResponse;
      try {
        res = await sendSpaceRpc(provider, req);
      } catch (err) {
        // A rejection means the request never got an answer — the 10s
        // timeout, or the socket refusing to carry it. Without this the
        // rejection travelled straight out of the await, past both toasts
        // below, into a caller's empty catch: with the network down a user
        // could close a tab and never hear anything back (real-browser
        // smoke, 2026-08-03). The thrown message is a developer string, so
        // the user gets a written one instead.
        //
        // A caller that keeps showing what the user did while the answer is
        // missing passes its own line, because "that failed" would contradict
        // what is on screen and the server may well have done it.
        if (unansweredToastKey !== undefined) {
          toast.error(t(unansweredToastKey));
        } else {
          toast.error(t(errorToastKey), {
            description: t('project.space.error.unreachable'),
          });
        }
        throw err;
      }
      if (!res.ok) {
        toast.error(t(errorToastKey), { description: res.error.message });
        throw new Error(res.error.message);
      }
      return res;
    },
    [provider, t],
  );

  /**
   * Send one tab move and say whether the server wrote anything.
   * @param spaceId - The tab that moved.
   * @param beforeSpaceId - The tab it landed in front of, null for the end.
   * @returns Whether the order on the server changed, so a broadcast is coming.
   * @throws {SpaceRpcUnanswered} When the request went out and drew no answer,
   *   which leaves it open whether the server carried it out.
   * @throws {Error} When the server said no.
   */
  const sendReorder = React.useCallback(
    async (spaceId: string, beforeSpaceId: string | null): Promise<boolean> => {
      const res = await callRpc(
        { type: 'tab:reorder', payload: { spaceId, beforeSpaceId } },
        'project.space.error.reorderTab',
        'project.space.error.reorderTabUnanswered',
      );
      return res.ok && res.result && 'wrote' in res.result
        ? res.result.wrote
        : false;
    },
    [callRpc],
  );

  /**
   * The Space a `tab:open` is out for, or null. Naming a Space and its tab
   * appearing are two round trips, and between them the choice names a Space
   * the strip does not hold — which is also what a tab that LEFT looks like.
   * This says which of the two it is, so pinning can wait for one and settle
   * the other.
   */
  const [openingTab, setOpeningTab] = React.useState<string | null>(null);

  /**
   * Put a Space on this user's strip.
   *
   * Which tabs are OPEN is shared and persisted, so only the server may write
   * it. The failure is reported and nothing is rolled back: the Space itself
   * is untouched.
   * @param spaceId - The Space to open a tab for.
   * @returns Nothing; the request settles on its own.
   */
  const openTab = React.useCallback(
    (spaceId: string): void => {
      setOpeningTab(spaceId);
      void callRpc(
        { type: 'tab:open', payload: { spaceId } },
        'project.space.error.openTab',
      ).catch(() => {
        // callRpc already surfaced a toast. No tab is coming for this one,
        // so stop holding the choice open for it.
        setOpeningTab((cur) => (cur === spaceId ? null : cur));
      });
    },
    [callRpc],
  );

  // What the strip renders: the stored order with a released drag laid over it
  // until the document catches up.
  const { order: tabOrder, reorder } = useTabReorder(openTabIds, sendReorder);

  // Tabs shown in the tab bar = each open tab id resolved against the
  // shared spaces list (drop missing ids - happens if another user
  // deleted a Space while we had it open).
  const openTabs: ReadonlyArray<ProjectSpace> = React.useMemo(
    () =>
      tabOrder
        .map((id) => spaces.find((s) => s.id === id))
        .filter((s): s is ProjectSpace => Boolean(s)),
    [tabOrder, spaces],
  );

  const activeSpace: ProjectSpace | undefined = resolveEffectiveActiveSpace(
    openTabs,
    activeSpaceId,
  );

  // `reviseTabChoice` holds the invariant; this applies what it asks for.
  React.useEffect(() => {
    const revision = reviseTabChoice({
      openTabIds: openTabs.map((s) => s.id),
      activeSpaceId,
      shownId: activeSpace?.id,
      openingTab,
    });
    if (revision.activeSpaceId !== undefined) {
      setActiveSpaceId(revision.activeSpaceId);
    }
    if (revision.clearOpening === true) setOpeningTab(null);
  }, [openTabs, activeSpaceId, activeSpace, openingTab]);

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

  // Discard the in-memory state of a tab once it has actually left this
  // user's list — whether they closed it, another machine on the account
  // closed it, or the Space was deleted out from under it.
  //
  // Driven by the list rather than by the close handler on purpose: the
  // close is a round trip now, and discarding at request time would mean
  // a failed close leaves a tab on screen whose undo history is already
  // gone. Both caches are keyed by doc name and evicting an unknown name
  // is a no-op, so both are called without checking the Space type.
  const previousOpenTabIdsRef = React.useRef<readonly string[]>(openTabIds);
  React.useEffect(() => {
    const departed = previousOpenTabIdsRef.current.filter(
      (id) => !openTabIds.includes(id),
    );
    previousOpenTabIdsRef.current = openTabIds;
    for (const id of departed) {
      evictCanvasUndoManager(docName.canvasSpace(projectId, id));
      evictDocumentEditor(docName.documentSpace(projectId, id));
    }
  }, [projectId, openTabIds]);

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


  const pendingCreateTokenRef = React.useRef<string | null>(null);

  // Claim the Space this machine asked for, and dismiss the create
  // overlay, when it shows up in the live Yjs spaces map.
  //
  // The match is on the claim token, not on the id: the server mints ids
  // now, so this machine never knew the id in advance. The token was
  // generated here per click and travels out with the request and back
  // in the broadcast, so of everyone watching this map, only the machine
  // that asked recognises the entry. Matching on `createdBy` would not
  // do — the same person signed in on three machines matches all three,
  // and all three would open the tab.
  //
  // Delete intentionally has no overlay (fast op, the tab vanishing is
  // the user-visible signal).
  React.useEffect(() => {
    if (spaceOpInProgress !== 'creating' || !pendingCreateTokenRef.current) {
      return;
    }
    const token = pendingCreateTokenRef.current;
    const mine = spaces.find((s) => s.claimToken === token);
    if (!mine) return;
    pendingCreateTokenRef.current = null;
    setSpaceOpInProgress(null);
    if (userId) {
      // Opening the tab is its own round trip: the token says WHICH
      // Space to open, and opening it is a change to shared state that
      // only the server may write.
      //
      // It reports as an OPEN failure, not a create failure. The create
      // already succeeded — the entry is in the list and on screen — so
      // saying it failed would send the user off to make a second Space.
      openTab(mine.id);
      setActiveSpaceId(mine.id);
    }
  }, [spaces, spaceOpInProgress, userId, setSpaceOpInProgress, openTab]);

  // Safety timeout - if the collab broadcast never lands, free the UI
  // and surface a toast so the user can retry rather than stare at a
  // wedged spinner.
  React.useEffect(() => {
    if (spaceOpInProgress === null) return;
    const handle = setTimeout(() => {
      setSpaceOpInProgress(null);
      pendingCreateTokenRef.current = null;
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
  // Called unconditionally: the width outlives the column being collapsed, and
  // a collapsed column is exactly the case where nothing may write it.
  const agentColumnWidth = useAgentColumnWidth();
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
    // Which tab is ACTIVE is local window state and stays local — two
    // machines on one account each keep their own. Which tabs are OPEN
    // is shared and persisted, so ONLY opening one more rides the wire
    // (§6.6.2): a click on a tab that is already open is a pure switch,
    // and a switch is instant and local. Sending the redundant open made
    // every switch raise "failed to open the tab" whenever collab was
    // unreachable, for an action that needed nothing from it.
    if (!openTabIds.includes(id)) openTab(id);
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
    // Ask the server to close it, and stop there — literally nothing else
    // happens here. Both of the follow-ups are driven by the list instead,
    // once the tab has actually left it: the in-memory state this tab
    // accumulated (canvas undo manager, document editor with its undo stack
    // and selection) is discarded by the effect that watches openTabIds, and
    // the pinning effect above moves off it.
    //
    // That split matters now that this is a round trip. Anything done here
    // happens whether or not the request succeeds, and a close CAN fail —
    // offline, or a server that says no. Discarding here would leave a failed
    // close showing a tab whose undo history is already gone; switching the
    // active tab here would leave the tab on screen while the view has moved
    // off it, which is what a real-browser smoke caught. Waiting for the
    // broadcast makes "the tab left", "its state was discarded" and "we moved
    // off it" the same event, and a failed close is simply an event that
    // never arrives.
    void callRpc(
      { type: 'tab:close', payload: { spaceId: id } },
      'project.space.error.closeTab',
    ).catch(() => {
      // callRpc already surfaced a toast; nothing was discarded and nothing
      // moved, so the tab and everything in it stay exactly as they were.
    });
  };

  /**
   * Create a Space - `space:create` RPC carrying a claim token this machine
   * generates. The server mints the id and writes the entry under the system
   * user; the effect above recognises the token in the broadcast, opens the
   * new tab and dismisses the overlay.
   * @param type - The Space template type to instantiate.
   * @param name - The display name for the new Space.
   */
  const onCreateSpace = async (
    type: SpaceType,
    name: string,
  ): Promise<void> => {
    setSpaceOpInProgress('creating');
    // The server mints the id, so this machine has nothing to watch for
    // except the token it is about to send. Only this machine has it.
    // `newId` and not `crypto.randomUUID`: same v4 shape, but it is the
    // generator the rest of the app uses, and it works outside a secure
    // context where `crypto.randomUUID` is undefined.
    const claimToken = newId();
    // Pin the token BEFORE the RPC await - Yjs sync from collab can race
    // ahead of the RPC ack (collab broadcasts the meta-doc mutation as
    // soon as space-rpc transact runs, which often beats the
    // broadcastStateless response by a few ms). If we only set the ref
    // after `await callRpc`, the spaces-watching effect re-runs on the
    // Yjs update with the ref still null, misses the match, and the
    // safety timeout (SPACE_OP_TIMEOUT_MS) fires even though everything
    // succeeded.
    pendingCreateTokenRef.current = claimToken;
    try {
      await callRpc(
        {
          type: 'space:create',
          payload: { type, name, claimToken },
        },
        'project.space.error.create',
      );
    } catch (err) {
      setSpaceOpInProgress(null);
      pendingCreateTokenRef.current = null;
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

  // Whenever the banner is up, the workspace is covered, in both cases for the
  // same reason: what the user does there is not reaching the server right now.
  //
  //   authFailed   - every mutation silently fails; the same expired token
  //                  goes to the API and to collab. Nothing typed here will be
  //                  saved, and no reconnect changes that.
  //   disconnected - the writes queue up locally and go out on reconnect, so
  //                  nothing is lost — but until then the user is alone with
  //                  their edits and nobody else can see them, which is worth
  //                  saying rather than leaving them to discover.
  //
  // Keeping the two conditions identical to the banner's is the point:
  // `ConnectionBanner` states they are a pair that must appear and disappear
  // on the same frame. They were not, and only the banner half showed on a
  // dropped connection.
  //
  // Cover it with a full-area `bg-black/80` overlay that
  // (a) matches the LoadingOverlay / Dialog backdrop dim pattern used
  //     elsewhere in the app (single visual vocabulary for "blocked"),
  // (b) is unmistakable at a glance, which is the entire job: once the user can
  //     see that something is wrong, the requirement is met and there is
  //     nothing left to solve. Being opaque it also takes the pointer, so the
  //     workspace is not clickable while it shows — a side effect of covering
  //     the screen, not a goal, and no work goes into either blocking input
  //     more thoroughly or letting it through (user 2026-08-02),
  // (c) surfaces the OS-level "not-allowed" cursor on hover so users
  //     get an instant, language-agnostic affordance that this region is not
  //     going to reach the server right now.
  // Banner itself sits OUTSIDE the wrapper so its "re-login" / "refresh"
  // actions stay clickable.
  const workspaceDisabled =
    connectionStatus === 'authFailed' || connectionStatus === 'disconnected';

  return (
    // Every editor on this page resolves collaborator names from here. Wrapping
    // the whole page rather than the space body is deliberate: any editor added
    // anywhere below gets it without a single layer in between having to know
    // it exists, which is the property the prop chain could not give us.
    <CollaboratorNamesProvider value={collaboratorNames}>
      {/*
        The floor is what keeps both regions usable: below it neither side may
        be squeezed further, so the page scrolls sideways and the top bar goes
        with it. It is a constant — collapsing the Agent column does not lower
        it, or the scrollbar would appear and disappear every time the column
        is toggled.

        That sideways scrolling happens in our own scroller rather than in the
        document, which is the rule for every visible scroller in the app: the
        bar the browser draws down the bottom of a window looks different in
        every engine. It also keeps `documentElement` from overflowing at all,
        so the page below is sized off the viewport without a horizontal bar
        eating into the bottom of it.
      */}
      <ScrollArea scrollbars='horizontal' className='h-full w-full'>
        {/*
          Sized off the viewport rather than off its parent. Radix wraps the
          children in a `display: table` div, and a table takes its size from
          its content — a percentage height inside it resolves against a height
          the table does not have yet, so the whole `flex-1 min-h-0` chain
          below loses its bound and the page grows to whatever its content
          happens to add up to (measured: 2283px tall in an 800px window).

          `100vw` and `100vh` are exact here because the document itself no
          longer scrolls in either direction: the scroller above owns the
          sideways overflow, so neither a horizontal bar eats into the height
          nor a vertical one into the width.
        */}
        <div
          className='flex h-screen w-screen flex-col bg-background text-foreground'
          style={{ minWidth: `${PAGE_MIN_WIDTH}px` }}
          data-testid='project-page'
        >
          {/* Confirm before an in-app leave (back link / logo / browser back) while
          a front-end operation is still syncing (#1787) — the in-app companion
          to the beforeunload guard. Renders nothing while not blocked. */}
          <LeaveProjectGuard />
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
          {/*
        Nothing reaches INTO this element to disable it when the connection
        drops — no `inert`, no `aria-hidden`, no `disabled`. The first two were
        tried and removed: `inert` stops the whole subtree receiving input,
        which pulls focus out of whatever the user was typing in and kills IME
        composition mid-word. The curtain takes the pointer but not the
        keyboard, so someone already typing can carry on — and telling the user
        something is wrong is the whole requirement, which the curtain meets by
        being on screen. Showing the problem where it is and reaching into
        nothing else is the rule (decision 2026-08-02).

        The curtain rendered below DOES cover this element, so the workspace is
        not clickable while it shows. That is the curtain being opaque, not
        something done to the workspace.

        A dropped connection loses nothing: the provider re-syncs on every
        reconnect, so edits made offline arrive when it comes back. A REFUSED
        one is different — the server drops those updates and there is no
        reconnect that fixes it — which is why the banner tells the user rather
        than leaving them to find out.

        `data-workspace` is a stable hook for tests to find this element in
        BOTH states: `data-workspace-disabled` is conditional and cannot be
        selected on when absent, and a class list would pin the assertion to
        styling.
      */}
          <div
            className='relative flex min-h-0 flex-1 flex-col'
            data-workspace=''
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
            {/* Both panels are given `display: flex` and `overflow: visible`
            because the library's inner wrapper is a block box that hard-codes
            `overflow: auto`: left alone it breaks each side's height chain and
            adds a scroll container we never wrote. */}
            <Group
              orientation='horizontal'
              className='flex min-h-0 flex-1'
              elementRef={agentColumnWidth.groupRef}
              onLayoutChanged={agentColumnWidth.onLayoutChanged}
            >
              {/* Agent column is hidden for viewers (B model — not rendered,
              not just disabled) AND when the user has collapsed it. The
              backend gates agent chat on role; this hide is UX only. The
              handle goes with it: there is nothing to drag against once the
              column is gone, and the space region then has the row to itself. */}
              {collapsed || isViewer ? null : (
                <>
                  <Panel
                    id={AGENT_PANEL_ID}
                    panelRef={agentColumnWidth.panelRef}
                    defaultSize={agentColumnWidth.defaultSize}
                    minSize={`${AGENT_COLUMN_MIN_WIDTH}px`}
                    maxSize={`${AGENT_COLUMN_MAX_WIDTH}px`}
                    groupResizeBehavior='preserve-pixel-size'
                    style={PANEL_STYLE}
                  >
                    <AgentColumn projectId={projectId} />
                  </Panel>
                  {/* The line between the two columns. What answers a pointer
                  around it is wider than the line twice over: the transparent
                  ::before reaches 4px to each side, and the library grows the
                  1px hit rect to a total of `resizeTargetMinimumSize` (10px
                  for a mouse), which is about 4.5px to each side.

                  The `z-10` is what makes the right-hand half of that reach
                  real: the canvas pane is `position:absolute; z-index:1`, so
                  without it the pane paints over the half of the ::before that
                  hangs into the space region, and a press there lands on the
                  canvas in the DOM while the library still reads it as a drag.
                  The canvas then began a box selection, the library took the
                  pointer capture away, and the `pointerup` the canvas was
                  waiting for went to the handle instead — leaving a selection
                  box being drawn under a pointer with no button held.

                  Double-click is off: the library
                  resizes imperatively there, which does not count as a user
                  gesture, so the width would be restored a frame later — the
                  user would see it flick and come back. */}
                  <ResizeSeparator
                    disableDoubleClick
                    aria-label={t('chrome.aria.agentColumnWidth')}
                    style={{ width: RESIZE_HANDLE_WIDTH }}
                    className={
                      'relative z-10 flex-none cursor-col-resize bg-border '
                    + 'transition-colors duration-[var(--duration-fast)] '
                    + 'before:absolute before:inset-y-0 before:-inset-x-1 before:content-[\'\'] '
                    + 'hover:bg-active-border active:bg-active-border '
                    + 'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring'
                    }
                  />
                </>
              )}
              {/* The other of the two regions a keyboard or clipboard event can
              belong to. The tab bar sits inside it, which is what makes the
              tabs part of the space region without a rule of their own. */}
              <Panel
                minSize={`${SPACE_MIN_WIDTH}px`}
                style={PANEL_STYLE}
              >
                <section
                  className='flex min-w-0 flex-1 flex-col'
                  data-region='space'
                >
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
                    onReorder={reorder}
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
              </Panel>
            </Group>
            {/* A visual signal that something is wrong — that is the whole job, and
            once the user can see it the job is done. Being opaque, it does also
            take the pointer, so the workspace is not clickable while it shows.
            That is a side effect of covering the screen, not a goal: nothing
            here works to block input, and nothing here works to let it
            through either. */}
            {workspaceDisabled ? (
              <div
                className='absolute inset-0 z-40 cursor-not-allowed bg-black/80'
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
      </ScrollArea>
    </CollaboratorNamesProvider>
  );
}
