import * as React from 'react';
import { useNavigate, useParams } from 'react-router-dom';

import { useUIStore } from '@/stores';
import type { SpaceType } from '@/spaces';

import { AgentColHeader } from './chrome/agent-header/AgentColHeader';
import { LeftFloatingMenu, type LeftMenuTool } from './chrome/left-floating-menu/LeftFloatingMenu';
import { TopBar } from './chrome/top-bar/TopBar';
import {
  SpaceTabBar,
  type SpaceTabSummary,
} from './chrome/tab-bar/SpaceTabBar';
import { ViewportToolbar } from './chrome/viewport-toolbar/ViewportToolbar';
import { SpaceOutlet } from './SpaceOutlet';

const DEMO_SPACES: SpaceTabSummary[] = [
  { id: 'demo-canvas', name: 'Main canvas', type: 'canvas' },
];

/**
 * Project page shell — TopBar above two columns:
 *   - left:  Agent column (320 px, collapsible)
 *   - right: TabBar + Space body + floating menus
 *
 * Real project + space data fetching, Yjs binding, and the demo seed
 * land in later PRs. PR 4 wires the chrome layer + space outlet so the
 * structural contract is exercised end-to-end.
 */
export default function ProjectPage() {
  const { projectId = 'demo', spaceId } = useParams<{
    projectId: string;
    spaceId?: string;
  }>();
  const navigate = useNavigate();

  const [projectName, setProjectName] = React.useState('Untitled project');
  const [spaces, setSpaces] = React.useState<SpaceTabSummary[]>(DEMO_SPACES);
  const activeSpaceId = spaceId ?? spaces[0]?.id ?? 'demo-canvas';
  const activeSpace =
    spaces.find((s) => s.id === activeSpaceId) ?? spaces[0] ?? DEMO_SPACES[0];

  const collapsed = useUIStore((s) => s.chatPanelCollapsed);
  const [tool, setTool] = React.useState<LeftMenuTool>('select');
  const [zoom, setZoom] = React.useState(1);
  const [locked, setLocked] = React.useState(false);
  const [minimapVisible, setMinimapVisible] = React.useState(true);

  const onActivate = (id: string) =>
    navigate(`/project/${projectId}/space/${id}`);

  const onCreateSpace = (type: SpaceType, name: string) => {
    const id = `${type}-${Date.now().toString(36)}`;
    setSpaces((prev) => [...prev, { id, name, type }]);
    navigate(`/project/${projectId}/space/${id}`);
  };

  return (
    <div className='flex h-screen w-screen flex-col bg-background text-foreground'>
      <TopBar
        projectId={projectId}
        projectName={projectName}
        role='owner'
        credits={1024}
        onRename={setProjectName}
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
                /* history sheet wires in chat PR */
              }}
              onNewConversation={() => {
                /* new conversation handler wires in chat PR */
              }}
            />
            <div className='flex flex-1 items-center justify-center text-xs text-muted-foreground'>
              Chat panel (PR for chat)
            </div>
          </aside>
        )}
        <section className='flex min-w-0 flex-1 flex-col'>
          <SpaceTabBar
            spaces={spaces}
            activeSpaceId={activeSpaceId}
            onActivate={onActivate}
            onCreate={onCreateSpace}
          />
          <div className='relative flex-1'>
            <SpaceOutlet
              projectId={projectId}
              spaceId={activeSpace.id}
              type={activeSpace.type}
            />
            {activeSpace.type === 'canvas' ? (
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
