import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as React from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { toast } from 'sonner';

import { projectsApi, spacesApi } from '@/data/api';
import {
  appendSpace,
  removeSpace,
  useProjectMeta,
  type ProjectSpace,
} from '@/data/yjs/project-meta';
import { useUIStore } from '@/stores';
import type { SpaceType } from '@/spaces';

import { ChatPanel } from '@/pages/project/chat/ChatPanel';
import { AgentColHeader } from '@/pages/project/chrome/agent-header/AgentColHeader';
import {
  LeftFloatingMenu,
  type LeftMenuTool,
} from '@/pages/project/chrome/left-floating-menu/LeftFloatingMenu';
import { TopBar } from '@/pages/project/chrome/top-bar/TopBar';
import { SpaceTabBar } from '@/pages/project/chrome/tab-bar/SpaceTabBar';
import { ViewportToolbar } from '@/pages/project/chrome/viewport-toolbar/ViewportToolbar';
import { SpaceOutlet } from '@/pages/project/SpaceOutlet';

/**
 * Project page shell — TopBar above two columns:
 *   - left:  Agent column (320 px, collapsible) — ChatPanel
 *   - right: SpaceTabBar + Space body + floating menus
 *
 * Data source (B mode infrastructure):
 *   - Project meta (name + credits + role)        → projects.get REST
 *   - Spaces list (live)                          → Yjs project-meta doc
 *   - Create / delete space                       → spaces.* REST + Yjs append/remove
 *   - Active space id                             → URL `:spaceId` param
 */
export default function ProjectPage() {
  const { projectId = 'demo', spaceId } = useParams<{
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
  // Credits live on the user; placeholder until /auth/me wires.
  const credits = 0;

  /**
   * Rename mutation — optimistic update + sonner toast + invalidate.
   *
   * onMutate snapshots the current cache and writes the new name
   * immediately so the TopBar updates with no network round-trip wait.
   * onError rolls back to the snapshot and surfaces the backend error
   * message via sonner. onSuccess invalidates so the next read pulls
   * the authoritative server copy (in case other fields changed).
   */
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

  // ---- Spaces list (Yjs live) ----
  const { spaces } = useProjectMeta(projectId);
  const activeSpaceId = spaceId ?? spaces[0]?.id ?? '';
  const activeSpace: ProjectSpace | undefined =
    spaces.find((s) => s.id === activeSpaceId) ?? spaces[0];

  // ---- Local UI state ----
  const collapsed = useUIStore((s) => s.chatPanelCollapsed);
  const [tool, setTool] = React.useState<LeftMenuTool>('select');
  const [zoom, setZoom] = React.useState(1);
  const [locked, setLocked] = React.useState(false);
  const [minimapVisible, setMinimapVisible] = React.useState(true);

  // ---- Handlers ----
  const onActivate = (id: string) =>
    navigate(`/project/${projectId}/space/${id}`);

  const onCreateSpace = async (type: SpaceType, name: string) => {
    // REST first (authoritative id from backend), then Yjs append so all
    // collaborators see the new space immediately.
    const created = await spacesApi.create(projectId, { name, type });
    appendSpace(projectId, {
      id: created.id,
      name: created.name,
      type: created.type,
    });
    navigate(`/project/${projectId}/space/${created.id}`);
  };

  const onCloseSpace = async (id: string) => {
    // Optimistic Yjs remove, then REST delete. If REST fails the page
    // requery on next render will surface the inconsistency (good enough
    // for v1; full optimistic rollback lands when we add toast).
    removeSpace(projectId, id);
    try {
      await spacesApi.delete(projectId, id);
    } catch {
      // The Yjs binding will eventually re-sync from server-stored state
      // on the next provider connect; nothing to do here.
    }
    // If we just closed the active space, jump to the first remaining one.
    if (id === activeSpaceId) {
      const next = spaces.find((s) => s.id !== id);
      if (next) navigate(`/project/${projectId}/space/${next.id}`);
      else navigate(`/project/${projectId}`);
    }
  };

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
              onRenameConversation={() => {
                /* wired when conversation API lands */
              }}
            />
            <ChatPanel projectId={projectId} />
          </aside>
        )}
        <section className='flex min-w-0 flex-1 flex-col'>
          <SpaceTabBar
            spaces={spaces}
            activeSpaceId={activeSpaceId}
            onActivate={onActivate}
            onCreate={onCreateSpace}
            onClose={onCloseSpace}
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
                No spaces yet — click + to create one.
              </div>
            )}
            {activeSpace?.type === 'canvas' ? (
              <>
                <LeftFloatingMenu active={tool} onPick={setTool} />
                <ViewportToolbar
                  zoom={zoom}
                  locked={locked}
                  minimapVisible={minimapVisible}
                  onZoomIn={() => setZoom((z) => Math.min(z + 0.1, 4))}
                  onZoomOut={() => setZoom((z) => Math.max(z - 0.1, 0.1))}
                  onFit={() => setZoom(1)}
                  onToggleLock={() => setLocked((l) => !l)}
                  onToggleMinimap={() => setMinimapVisible((v) => !v)}
                />
              </>
            ) : null}
          </div>
        </section>
      </div>
    </div>
  );
}
