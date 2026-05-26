import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { nanoid } from 'nanoid';
import * as React from 'react';
import { useParams } from 'react-router-dom';
import { toast } from 'sonner';

import type { SpaceRpcResponse } from '@breatic/shared';
import { projectsApi } from '@/data/api';
import { cn } from '@/lib/utils';
import { useExclusiveOverlay } from '@/lib/use-exclusive-overlay';
import { sendSpaceRpc } from '@/data/yjs/space-rpc-client';
import { useTranslation } from '@/i18n/use-translation';
import {
  closeSpaceTab,
  openSpaceTab,
  setActiveSpace,
  useProjectMeta,
  useProjectMessages,
  type ProjectSpace,
} from '@/data/yjs/project-meta';
import { useCurrentUserStore, useUIStore } from '@/stores';
import type { SpaceType } from '@/spaces';

import { ChatPanel } from '@/pages/project/chat/ChatPanel';
import { AgentColHeader } from '@/pages/project/chrome/agent-header/AgentColHeader';
import { LoadingOverlay } from '@/pages/project/chrome/LoadingOverlay';
import { ConnectionBanner } from '@/pages/project/chrome/ConnectionBanner';
import {
  LeftFloatingMenu,
} from '@/pages/project/chrome/left-floating-menu/LeftFloatingMenu';
import { SpaceReadOnlySheet } from '@/pages/project/chrome/tab-bar/SpaceReadOnlySheet';
import { TopBar } from '@/pages/project/chrome/top-bar/TopBar';
import { SpaceTabBar } from '@/pages/project/chrome/tab-bar/SpaceTabBar';
import { ViewportToolbar } from '@/pages/project/chrome/viewport-toolbar/ViewportToolbar';
import { SpaceOutlet } from '@/pages/project/SpaceOutlet';

/**
 * Project page shell — TopBar above two columns:
 *   - left:  Agent column (320 px, collapsible) — ChatPanel
 *   - right: SpaceTabBar + Space body + floating menus
 *
 * State model (2026-05-21 redesign):
 *   - Shared `spaces` list  → Yjs project-meta `Y.Array('spaces')`
 *   - Per-user `openTabIds` → Yjs project-meta `perUser[userId].openTabIds`
 *   - Per-user `activeSpaceId` → same subtree, same key
 *   - URL `:spaceId` param is treated as a *navigation request* — when
 *     present it triggers `setActiveSpace` (and `openSpaceTab` if needed)
 *     so deep links work, but the source of truth lives in Yjs so the
 *     tab bar + active tab can be restored across machines.
 *
 * Collab-only write flow (ADR 2026-05-23 yjs-collab-only-write-authz):
 *   - Create / delete / lock / restore + projectMessages clear all go
 *     through `sendSpaceRpc` (stateless RPC over the live Hocuspocus
 *     connection on the meta doc). Collab authorizes the caller's role,
 *     performs the privileged Yjs write, and broadcasts back. Server
 *     REST routes + Redis pub/sub are gone.
 *   - The client does NOT write `meta.spaces` / `meta.projectMessages`
 *     directly — `beforeHandleMessage` would reject it. A global
 *     loading overlay covers the 50-200ms round trip; a 10-second
 *     timeout guards against a wedged collab.
 */
const SPACE_OP_TIMEOUT_MS = 10_000;

export default function ProjectPage() {
  const t = useTranslation();
  const { projectId = 'demo' } = useParams<{
    projectId: string;
  }>();

  // ---- Project meta (name / credits / role) ----
  const queryClient = useQueryClient();
  const projectQuery = useQuery({
    queryKey: ['project', projectId],
    queryFn: () => projectsApi.get(projectId),
    enabled: projectId !== 'demo',
  });
  const projectName = projectQuery.data?.name ?? 'Untitled project';
  const role = projectQuery.data?.myRole ?? 'owner';
  const credits = 0;

  const renameMutation = useMutation({
    mutationFn: (name: string) => projectsApi.rename(projectId, name),
    onMutate: async (next: string) => {
      await queryClient.cancelQueries({ queryKey: ['project', projectId] });
      const previous = queryClient.getQueryData(['project', projectId]);
      queryClient.setQueryData(
        ['project', projectId],
        (old: { name: string } | undefined) =>
          old ? { ...old, name: next } : old,
      );
      return { previous };
    },
    onError: (err, _next, ctx) => {
      if (ctx && 'previous' in ctx) {
        queryClient.setQueryData(['project', projectId], ctx.previous);
      }
      const message = err instanceof Error ? err.message : 'Rename failed';
      toast.error('Project rename failed', { description: message });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['project', projectId] });
    },
  });

  // ---- Current user + Yjs meta + project messages ----
  const userId = useCurrentUserStore((s) => s.user?.id);
  const {
    spaces,
    openTabIds,
    activeSpaceId,
    provider,
    status: connectionStatus,
  } = useProjectMeta(projectId, userId);
  const { messages: projectMessages } = useProjectMessages(projectId);

  // Tabs shown in the tab bar = each open tab id resolved against the
  // shared spaces list (drop missing ids — happens if another user
  // deleted a Space while we had it open).
  const openTabs: ReadonlyArray<ProjectSpace> = React.useMemo(
    () =>
      openTabIds
        .map((id) => spaces.find((s) => s.id === id))
        .filter((s): s is ProjectSpace => Boolean(s)),
    [openTabIds, spaces],
  );

  const activeSpace: ProjectSpace | undefined =
    spaces.find((s) => s.id === activeSpaceId) ?? openTabs[0];

  // Note: NO URL ↔ active-space reconcile. Per user decision
  // `[[feedback_space_type_vs_route]]`, Space is a type/template, not
  // a route segment; the active tab + open-tab list are per-user UI
  // state living in Yjs `meta.perUser[userId]`, which already syncs
  // across the same user's machines. URL stays `/project/:id`.

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
          setActiveSpace(projectId, userId, id);
        }
      }
    }
    // Delete no longer uses spaceOpInProgress — see onDeleteSpace.
  }, [spaces, spaceOpInProgress, projectId, userId, setSpaceOpInProgress]);

  // Safety timeout — if the collab broadcast never lands, free the UI
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

  // ---- Local view UI state ----
  const collapsed = useUIStore((s) => s.chatPanelCollapsed);
  const [zoom, setZoom] = React.useState(1);
  const [minimapVisible, setMinimapVisible] = React.useState(true);
  const [snapToGrid, setSnapToGrid] = React.useState(false);

  // ---- Handlers ----

  /** Activate a Space — open the tab if not open + mark active. */
  const onActivate = (id: string) => {
    if (!userId) return; // pre-auth no-op (per-user UI state needs userId)
    openSpaceTab(projectId, userId, id);
    setActiveSpace(projectId, userId, id);
  };

  /** Close a Space tab — does NOT delete the Space; just removes from
   *  this user's tab bar. */
  const onCloseTab = (id: string) => {
    if (!userId) return;
    closeSpaceTab(projectId, userId, id);
    if (id === activeSpaceId) {
      const next = openTabs.find((s) => s.id !== id);
      setActiveSpace(projectId, userId, next?.id ?? null);
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
        // Surface a toast on the "no provider yet" path too — without this
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
   * Create a Space — client-side nanoid id (ADR B1.1) + `space:create`
   * RPC. The collab process applies the write under the system user;
   * the effect above auto-opens the new tab and dismisses the overlay
   * when the doc broadcast lands.
   */
  const onCreateSpace = async (type: SpaceType, name: string) => {
    setSpaceOpInProgress('creating');
    const spaceId = nanoid();
    // Pin the pending id BEFORE the RPC await — Yjs sync from collab
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

  /** Soft-delete a Space — `space:delete` RPC. */
  /**
   * Delete is fast (~50-200ms) and already self-evident in the UI —
   * the deleted tab vanishes the moment Yjs sync lands. Showing the
   * full-screen LoadingOverlay for that window just flashes a black
   * backdrop in and out, which the user reads as flicker rather than
   * progress. The SpaceDrawer row keeps its own inline `deleteBusy`
   * spinner to prevent double-click within the same row.
   *
   * Errors still surface — callRpc raises a toast on RPC failure.
   */
  const onDeleteSpace = async (spaceId: string) => {
    await callRpc(
      { type: 'space:delete', payload: { spaceId } },
      'spaces.drawer.action.deleteFail',
    );
  };

  /** Toggle Space lock — `space:lock` RPC (lock + unlock same handler). */
  const onSetSpaceLocked = async (spaceId: string, locked: boolean) => {
    await callRpc(
      { type: 'space:lock', payload: { spaceId, locked } },
      locked
        ? 'spaces.drawer.action.lockFail'
        : 'spaces.drawer.action.unlockFail',
    );
  };

  /**
   * Rename a Space's name — `space:rename` RPC. Caller role ≥ edit.
   * Locked Spaces refuse rename on the server side and the failure
   * toast surfaces via callRpc. The 80-char cap mirrors the project
   * title — enforced both on the client (`SPACE_NAME_MAX_LEN`) and
   * on the server (`SpaceRenamePayloadSchema`).
   */
  const onRenameSpace = async (spaceId: string, name: string) => {
    await callRpc(
      { type: 'space:rename', payload: { spaceId, name } },
      'spaces.rename.error.failed',
    );
  };

  /** Owner-only: restore a soft-deleted Space — `space:restore` RPC. */
  const onRestoreSpace = async (spaceId: string) => {
    await callRpc(
      { type: 'space:restore', payload: { spaceId } },
      'project.space.error.create',
    );
  };

  /** Owner-only: clear all entries in `meta.projectMessages`. */
  const onClearMessages = async () => {
    await callRpc(
      { type: 'messages:clear', payload: { all: true } },
      'project.space.error.create',
    );
  };

  /** Open the read-only preview sheet for a Space. */
  const onViewSpace = (id: string) => {
    setReadOnlyViewSpaceId(id);
    setRoSheetOpen(true);
  };

  // Resolve the currently-previewed Space (if any) for the read-only
  // sheet. Bail to null if it's missing (race with deletion).
  const readOnlySpace = React.useMemo(() => {
    if (!readOnlyViewSpaceId) return null;
    return spaces.find((s) => s.id === readOnlyViewSpaceId) ?? null;
  }, [readOnlyViewSpaceId, spaces]);

  // When the WS auth has failed, the workspace below the banner is
  // unusable — any mutation (create space, send chat, edit node) will
  // silently fail because the same expired token is sent to the API +
  // collab. Visually wash it out and intercept pointer events so users
  // can't trigger half-broken flows like "正在创建 Space..." that
  // never resolves (2026-05-26 user smoke report). The banner itself
  // sits OUTSIDE this wrapper, so its "重新登录" / "刷新" actions stay
  // clickable.
  const workspaceDisabled = connectionStatus === 'authFailed';

  return (
    <div className='flex h-screen w-screen flex-col bg-background text-foreground'>
      <ConnectionBanner
        status={connectionStatus}
        onReload={() => window.location.reload()}
        onReLogin={() => {
          // Real auth flow lands later; for now reload kicks the
          // dev-user injection + token re-application path.
          window.location.reload();
        }}
      />
      <div
        className={cn(
          'flex min-h-0 flex-1 flex-col',
          workspaceDisabled && 'pointer-events-none opacity-50',
        )}
        aria-hidden={workspaceDisabled || undefined}
        data-workspace-disabled={workspaceDisabled || undefined}
      >
        <TopBar
          projectId={projectId}
          projectName={projectName}
          role={role}
          credits={credits}
          onRename={(next) => renameMutation.mutate(next)}
        />
        <div className='flex min-h-0 flex-1'>
          {collapsed ? null : (
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
              <ChatPanel projectId={projectId} />
            </aside>
          )}
          <section className='flex min-w-0 flex-1 flex-col'>
            <SpaceTabBar
              spaces={openTabs}
              allSpaces={spaces}
              openTabIds={openTabIds}
              activeSpaceId={activeSpaceId ?? ''}
              projectId={projectId}
              onActivate={onActivate}
              onCreate={onCreateSpace}
              onClose={onCloseTab}
              onViewSpace={onViewSpace}
              onDeleteSpace={onDeleteSpace}
              onSetSpaceLocked={onSetSpaceLocked}
              onRenameSpace={onRenameSpace}
              projectMessages={projectMessages}
              currentUserRole={role}
              onRestoreSpace={onRestoreSpace}
              onClearMessages={onClearMessages}
            />
            <div className='relative flex-1'>
              {activeSpace ? (
                <SpaceOutlet
                  projectId={projectId}
                  spaceId={activeSpace.id}
                  type={activeSpace.type}
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
                  <LeftFloatingMenu
                    onPick={(_tool) => {
                    // TODO: dispatch per-button actions
                    //   nodes        — open node-library popover
                    //   upload       — open file picker (presigned URL upload)
                    //   comment      — enter annotation mode
                    //   asset-group  — placeholder (M1+)
                    //   help         — placeholder (M1+)
                    //   feedback     — placeholder (M1+)
                    // Buttons never store a "selected" state — they fire and forget.
                    }}
                  />
                  <ViewportToolbar
                    zoom={zoom}
                    minimapVisible={minimapVisible}
                    snapToGrid={snapToGrid}
                    onZoomIn={() => setZoom((z) => Math.min(z + 0.1, 4))}
                    onZoomOut={() => setZoom((z) => Math.max(z - 0.1, 0.1))}
                    onZoomChange={(z) => setZoom(z)}
                    onFit={() => setZoom(1)}
                    onToggleSnap={() => setSnapToGrid((v) => !v)}
                    onToggleMinimap={() => setMinimapVisible((v) => !v)}
                  // Undo/redo render disabled until the canvas history
                  // engine lands; canUndo/canRedo default to false.
                  />
                </>
              ) : null}
            </div>
          </section>
        </div>
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
