import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as React from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { toast } from 'sonner';

import { projectsApi, spacesApi } from '@/data/api';
import {
  closeSpaceTab,
  openSpaceTab,
  setActiveSpace,
  useProjectMeta,
  type ProjectSpace,
} from '@/data/yjs/project-meta';
import { useCurrentUserStore, useUIStore } from '@/stores';
import type { SpaceType } from '@/spaces';

import { ChatPanel } from '@/pages/project/chat/ChatPanel';
import { AgentColHeader } from '@/pages/project/chrome/agent-header/AgentColHeader';
import { LoadingOverlay } from '@/pages/project/chrome/LoadingOverlay';
import {
  LeftFloatingMenu,
  type LeftMenuTool,
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
 * Server-driven event flow (K.1 + I.2):
 *   - Create / delete / lock all go through HTTP → server publishes a
 *     Redis pub/sub event → collab service mutates the meta doc → all
 *     clients receive the WS broadcast.
 *   - The client does NOT write `spaces` directly — it just calls HTTP
 *     and waits for the doc to update (a global loading overlay covers
 *     the 50-200ms round trip; a 10-second timeout guards against a
 *     wedged collab).
 */
const SPACE_OP_TIMEOUT_MS = 10_000;

export default function ProjectPage() {
  const { projectId = 'demo', spaceId: urlSpaceId } = useParams<{
    projectId: string;
    spaceId?: string;
  }>();
  const navigate = useNavigate();

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

  // ---- Current user + Yjs meta ----
  const userId = useCurrentUserStore((s) => s.user?.id);
  const { spaces, openTabIds, activeSpaceId } = useProjectMeta(
    projectId,
    userId,
  );

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

  // ---- URL → Yjs reconcile (deep-link support) ----
  // If the URL names a space we're not active on, set it active + open it.
  React.useEffect(() => {
    if (!userId || !urlSpaceId) return;
    if (urlSpaceId === activeSpaceId) return;
    if (!spaces.some((s) => s.id === urlSpaceId)) return;
    openSpaceTab(projectId, userId, urlSpaceId);
    setActiveSpace(projectId, userId, urlSpaceId);
  }, [userId, urlSpaceId, projectId, activeSpaceId, spaces]);

  // Keep the URL in sync with the active tab so refresh / back button
  // land on the same Space. Only navigate if URL diverges.
  React.useEffect(() => {
    if (!activeSpaceId) return;
    if (urlSpaceId === activeSpaceId) return;
    navigate(`/project/${projectId}/space/${activeSpaceId}`, { replace: true });
  }, [activeSpaceId, urlSpaceId, projectId, navigate]);

  // ---- Loading overlay tracking ----
  const spaceOpInProgress = useUIStore((s) => s.spaceOpInProgress);
  const setSpaceOpInProgress = useUIStore((s) => s.setSpaceOpInProgress);
  const readOnlyViewSpaceId = useUIStore((s) => s.readOnlyViewSpaceId);
  const setReadOnlyViewSpaceId = useUIStore((s) => s.setReadOnlyViewSpaceId);

  const pendingCreateIdRef = React.useRef<string | null>(null);
  const pendingDeleteIdRef = React.useRef<string | null>(null);

  // Auto-dismiss loading overlay when the Yjs doc catches up to the
  // pending operation (created id appears / deleted id vanishes).
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
    if (spaceOpInProgress === 'deleting' && pendingDeleteIdRef.current) {
      const id = pendingDeleteIdRef.current;
      if (!spaces.some((s) => s.id === id)) {
        pendingDeleteIdRef.current = null;
        setSpaceOpInProgress(null);
      }
    }
  }, [spaces, spaceOpInProgress, projectId, userId, setSpaceOpInProgress]);

  // Safety timeout — if the collab broadcast never lands, free the UI
  // and surface a toast so the user can retry rather than stare at a
  // wedged spinner.
  React.useEffect(() => {
    if (spaceOpInProgress === null) return;
    const phase = spaceOpInProgress;
    const handle = setTimeout(() => {
      setSpaceOpInProgress(null);
      pendingCreateIdRef.current = null;
      pendingDeleteIdRef.current = null;
      toast.error(
        phase === 'creating' ? 'Space 创建超时' : 'Space 删除超时',
        { description: '请刷新页面重试' },
      );
    }, SPACE_OP_TIMEOUT_MS);
    return () => clearTimeout(handle);
  }, [spaceOpInProgress, setSpaceOpInProgress]);

  // ---- Local view UI state ----
  const collapsed = useUIStore((s) => s.chatPanelCollapsed);
  const [tool, setTool] = React.useState<LeftMenuTool>('nodes');
  const [zoom, setZoom] = React.useState(1);
  const [minimapVisible, setMinimapVisible] = React.useState(true);
  const [snapToGrid, setSnapToGrid] = React.useState(false);
  const [alignActive, setAlignActive] = React.useState(false);

  // ---- Handlers ----

  /** Activate a Space — open the tab if not open + mark active. */
  const onActivate = (id: string) => {
    if (!userId) {
      navigate(`/project/${projectId}/space/${id}`);
      return;
    }
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

  /** Create a Space — HTTP → server publishes event → collab mutates
   *  the doc → effect above auto-opens the new tab and dismisses
   *  the overlay. */
  const onCreateSpace = async (type: SpaceType, name: string) => {
    setSpaceOpInProgress('creating');
    try {
      const created = await spacesApi.create(projectId, { name, type });
      pendingCreateIdRef.current = created.id;
    } catch (err) {
      setSpaceOpInProgress(null);
      pendingCreateIdRef.current = null;
      const message = err instanceof Error ? err.message : 'Space 创建失败';
      toast.error('Space 创建失败', { description: message });
      throw err;
    }
  };

  /** Open the read-only preview sheet for a Space. */
  const onViewSpace = (id: string) => setReadOnlyViewSpaceId(id);

  // Resolve the currently-previewed Space (if any) for the read-only
  // sheet. Bail to null if it's missing (race with deletion).
  const readOnlySpace = React.useMemo(() => {
    if (!readOnlyViewSpaceId) return null;
    return spaces.find((s) => s.id === readOnlyViewSpaceId) ?? null;
  }, [readOnlyViewSpaceId, spaces]);

  return (
    <div className='flex h-screen w-screen flex-col bg-background text-foreground'>
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
                没有打开的工作面 — 点抽屉里的工作面打开,或点 + 新建。
              </div>
            )}
            {activeSpace?.type === 'canvas' ? (
              <>
                <LeftFloatingMenu active={tool} onPick={setTool} />
                <ViewportToolbar
                  zoom={zoom}
                  minimapVisible={minimapVisible}
                  snapToGrid={snapToGrid}
                  alignActive={alignActive}
                  onZoomIn={() => setZoom((z) => Math.min(z + 0.1, 4))}
                  onZoomOut={() => setZoom((z) => Math.max(z - 0.1, 0.1))}
                  onZoomReset={() => setZoom(1)}
                  onFit={() => setZoom(1)}
                  onExpand={() => {
                    /* M0' placeholder; full-screen toggle wired when API lands */
                  }}
                  onToggleSnap={() => setSnapToGrid((v) => !v)}
                  onToggleAlign={() => setAlignActive((v) => !v)}
                  onToggleMinimap={() => setMinimapVisible((v) => !v)}
                />
              </>
            ) : null}
          </div>
        </section>
      </div>
      <SpaceReadOnlySheet
        space={readOnlySpace}
        onClose={() => setReadOnlyViewSpaceId(null)}
      />
      {spaceOpInProgress === 'creating' ? (
        <LoadingOverlay
          message='正在创建 Space…'
          testId='creating-space-overlay'
        />
      ) : null}
      {spaceOpInProgress === 'deleting' ? (
        <LoadingOverlay
          message='正在删除 Space…'
          testId='deleting-space-overlay'
        />
      ) : null}
    </div>
  );
}
