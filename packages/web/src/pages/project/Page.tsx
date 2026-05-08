import { useCallback, useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import '@xyflow/react/dist/style.css';
import { Group, Panel, Separator } from 'react-resizable-panels';
import { Icon } from '@/ui/icon';
import Tooltip from '@/ui/tooltip';
import { useCanvasData, CanvasDataProvider } from '@/spaces/canvas/contexts/CanvasDataContext';
import { LocalPendingProvider } from '@/spaces/canvas/contexts/LocalPendingProvider';
import { ActiveCanvasSpaceProvider } from '@/domain/space/ActiveCanvasSpaceContext';
import { useCanvasActions } from '@/spaces/canvas/hooks/useCanvasActions';
import { ProjectLayoutProvider, useProjectLayout } from '@/app/contexts/ProjectLayoutContext';
import { useProjectSpaces } from '@/domain/space/useProjectSpaces';
import { useUserRole } from '@/domain/user/useUserRole';
import { useUserCenterStore } from '@/app/hooks/useUserCenterStore';
import { removeToken } from '@/data/api/token';
import * as authApi from '@/data/api/auth';
import { TopBar } from '@/features/top-bar';
import EditorComingSoonPlaceholder from '@/app/shell/EditorComingSoonPlaceholder';
import TextEditor from '@/spaces/document';
import ResizableLeftPanel from '@/spaces/canvas/view/ResizableLeftPanel';
import AiChatRecordPanel from "@/features/chat/components/AiChatRecordPanel";
import { SpaceShell } from '@/spaces/_shell';
import { ProjectWorkspaceRegionContext, type CanvasWorkflowNodeData } from '@/spaces/canvas/types';

/** Outer shell — owns Yjs manager + wraps children in CanvasDataProvider. */
const ProjectPage: React.FC = () => {
  const { projectId: routeProjectId } = useParams<{ projectId: string }>();

  const { authInfo } = useUserCenterStore();
  const navigate = useNavigate();
  const sessionToken = authInfo?.state?.token ?? '';

  const yjs = useProjectSpaces({
    id: routeProjectId ?? '',
    token: sessionToken,
    enabled: !!routeProjectId && !!sessionToken,
    onAuthFailed: useCallback((reason: string) => {
      // Session expired or token rejected — clear client state and
      // redirect to login. Without this, HocuspocusProvider would
      // reconnect forever against an invalid token.
      console.warn('[yjs] Authentication failed:', reason);
      removeToken();
      navigate('/login', { replace: true });
    }, [navigate]),
  });

  return (
    <ProjectLayoutProvider>
      <ActiveCanvasSpaceProvider manager={yjs.manager ?? null}>
        <CanvasDataProvider manager={yjs.manager ?? null}>
          <LocalPendingProvider>
            <ProjectContentBody yjs={yjs} />
          </LocalPendingProvider>
        </CanvasDataProvider>
      </ActiveCanvasSpaceProvider>
    </ProjectLayoutProvider>
  );
};

/**
 * The actual project content — inside CanvasDataProvider, consumes
 * canvas data through the canvas hooks.
 */
const ProjectContentBody: React.FC<{ yjs: ReturnType<typeof useProjectSpaces> }> = ({ yjs }) => {
  const { nodes } = useCanvasData();
  const { updateNode } = useCanvasActions();
  const { rightPanel, openRightPanel, closeRightPanel } = useProjectLayout();
  const [workflowName, setWorkflowName] = useState<string>('');
  const [chatPanelVisible, setChatPanelVisible] = useState(true);
  const [canvasPanelVisible, setCanvasPanelVisible] = useState(true);
  const [selectedWorkspaceRegion, setSelectedWorkspaceRegion] = useState<'canvas' | 'rightEditor' | null>('canvas');
  const [isResizingRightEditor, setIsResizingRightEditor] = useState(false);
  // PR-Y2: members + credits no longer floats as an overlay; the
  // full-width `TopBar` (features/top-bar) houses them now.
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);

  // Resolve the caller's userId once on mount (the redux user-info
  // slice doesn't store `id` today). useUserRole below depends on it.
  // Backend returns `ApiResponse<UserEntity>` and the axios interceptor
  // unwraps the envelope to `{ data: UserEntity }` — see
  // `data/api/request.ts`.
  useEffect(() => {
    let cancelled = false;
    authApi
      .getMe()
      .then((res) => {
        if (cancelled) return;
        const id = (res as unknown as { data?: { id?: string } })?.data?.id ?? null;
        setCurrentUserId(id);
      })
      .catch(() => {
        // Auth interceptor handles 401; on transient failures we
        // simply don't get a userId and gating defaults to "view".
      });
    return () => { cancelled = true; };
  }, []);

  const metaProvider = yjs.metaManager?.provider ?? null;
  const { role: myRole } = useUserRole(yjs.projectId, currentUserId, metaProvider);

  const panelNode = rightPanel.nodeId ? nodes.find((n) => n.id === rightPanel.nodeId) : undefined;
  const panelNodeType = String(panelNode?.type ?? '');
  const isTextNode = panelNodeType === '1001';
  const isImageNode = panelNodeType === '1002';
  const isVideoOrAudioNode = panelNodeType === '1003' || panelNodeType === '1004';
  const isRightEditorOpen = rightPanel.open && rightPanel.panelType === 'editor';

  const exitCanvasPickMode = useCallback(() => {
    for (const n of nodes) {
      const ps = (n.data as Partial<CanvasWorkflowNodeData> | undefined)?.pickState;
      if (ps?.fromCanvas || ps?.resultBoxes?.length) {
        updateNode(n.id, { data: { pickState: null } }, { history: 'skip' });
      }
    }
  }, [nodes, updateNode]);

  const handleToggleChatPanel = () => {
    setChatPanelVisible((prev) => !prev);
  };

  const handleToggleEditorPanel = () => {
    if (rightPanel.open) {
      exitCanvasPickMode();
      closeRightPanel();
      setSelectedWorkspaceRegion((prev) => (prev === 'rightEditor' ? null : prev));
      return;
    }
    exitCanvasPickMode();
    openRightPanel('editor', rightPanel.nodeId);
    setSelectedWorkspaceRegion('rightEditor');
  };

  const handleToggleCanvasToolbar = () => {
    setCanvasPanelVisible((prev) => {
      const next = !prev;
      if (!next) {
        exitCanvasPickMode();
        setSelectedWorkspaceRegion((current) => (current === 'canvas' ? null : current));
      }
      return next;
    });
  };

  const showChatSeparator = chatPanelVisible && (canvasPanelVisible || isRightEditorOpen);
  const showRightSeparator = isRightEditorOpen && canvasPanelVisible;
  let rightEditorBorderClass = 'border-transparent';
  if (isResizingRightEditor) {
    rightEditorBorderClass = 'border-border-utilities-selected';
  } else if (selectedWorkspaceRegion === 'rightEditor') {
    rightEditorBorderClass = 'border-[#949494]';
  }

  useEffect(() => {
    if (isRightEditorOpen) {
      exitCanvasPickMode();
      setSelectedWorkspaceRegion('rightEditor');
    } else {
      setSelectedWorkspaceRegion((prev) => (prev === 'rightEditor' ? null : prev));
    }
    // exitCanvasPickMode reads from the latest nodes snapshot via its memoised deps
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isRightEditorOpen]);

  useEffect(() => {
    if (!isResizingRightEditor) return;
    const handleMouseUp = () => setIsResizingRightEditor(false);
    window.addEventListener('mouseup', handleMouseUp);
    return () => window.removeEventListener('mouseup', handleMouseUp);
  }, [isResizingRightEditor]);

  return (
    <ProjectWorkspaceRegionContext.Provider value={selectedWorkspaceRegion}>
      <div className='flex flex-col w-screen h-screen overflow-hidden'>
        <TopBar
          projectId={yjs.projectId}
          metaProvider={metaProvider}
          myRole={myRole}
          projectName={workflowName}
          onProjectNameCommit={setWorkflowName}
        />
        <Group orientation='horizontal' className='flex-1 min-h-0 flex'>
          {chatPanelVisible && (
            <>
              <Panel
                id='chat'
                defaultSize={450}
                maxSize={450}
                minSize={450}
                className='bg-background-default-secondary flex flex-col min-w-0 shrink-0'
              >
                <div className='h-full min-h-0 flex flex-col border-r border-border-default-base'>
                  <AiChatRecordPanel
                    projectName={workflowName}
                    onProjectNameCommit={setWorkflowName}
                    selectedWorkspaceRegion={selectedWorkspaceRegion}
                  />
                </div>
              </Panel>
              {showChatSeparator ? (
                <Separator
                  id='resize-chat-canvas'
                  className='w-px bg-gray-300 hover:bg-blue-400 data-[resize-handle-state=drag]:bg-blue-500 cursor-col-resize shrink-0 transition-colors focus-visible:outline-none'
                />
              ) : null}
            </>
          )}
          {isRightEditorOpen && (
            <Panel
              id='resizable-left'
              className={`bg-background-default-secondary flex flex-col shrink-0 border box-border ${rightEditorBorderClass}`}
              onMouseDownCapture={() => {
                exitCanvasPickMode();
                setSelectedWorkspaceRegion('rightEditor');
              }}
            >
              <div className='relative h-full min-h-0 w-full overflow-visible'>
                <Tooltip
                  title={canvasPanelVisible ? 'Collapse canvas' : 'Expand canvas'}
                  placement='right'
                  triggerClassName='absolute left-3 top-3 z-10'
                >
                  <button
                    type='button'
                    onClick={handleToggleCanvasToolbar}
                    className='flex h-8 w-8 items-center justify-center rounded-md bg-background-default-secondary text-icon-secondary transition-colors hover:bg-background-default-base-hover'
                  >
                    <Icon
                      name={canvasPanelVisible ? 'project-canvas-chat-toggle-icon' : 'project-canvas-chat-close-icon'}
                      width={16}
                      height={16}
                      color='var(--color-icon-base)'
                    />
                  </button>
                </Tooltip>
                {isTextNode && panelNode ? (
                  <TextEditor nodeId={panelNode.id} />
                ) : (isImageNode || isVideoOrAudioNode) && panelNode ? (
                  <EditorComingSoonPlaceholder nodeId={panelNode.id} />
                ) : (
                  <ResizableLeftPanel />
                )}
                <div
                  id='chat-left-panel-portal'
                  className='absolute right-0 top-0 bottom-0 w-0 pointer-events-none'
                  aria-hidden
                />
              </div>
            </Panel>
          )}
          {showRightSeparator ? (
            <Separator
              id='resize-canvas-right'
              className='w-px bg-gray-300 hover:bg-blue-400 data-[resize-handle-state=drag]:bg-blue-500 cursor-col-resize shrink-0 transition-colors focus-visible:outline-none'
              onMouseDownCapture={() => {
                exitCanvasPickMode();
                setSelectedWorkspaceRegion('rightEditor');
                setIsResizingRightEditor(true);
              }}
            />
          ) : null}
          {canvasPanelVisible && (
            <Panel
              id='canvas'
              defaultSize={700}
              minSize={700}
              className={`border ${selectedWorkspaceRegion === 'canvas' ? 'border-[#949494]' : 'border-transparent'}`}
              onMouseDownCapture={() => {
                setSelectedWorkspaceRegion('canvas');
              }}
            >
              <div className='relative h-full w-full'>
                <div className='absolute left-3 top-3 z-10'>
                  <Tooltip
                    title={chatPanelVisible ? 'Collapse chat panel' : 'Expand chat panel'}
                    placement='right'
                    triggerClassName='absolute left-0 top-0 z-10'
                  >
                    <button
                      type='button'
                      onClick={handleToggleChatPanel}
                      className='flex h-8 w-8 items-center justify-center rounded-md bg-background-default-secondary text-icon-secondary transition-colors hover:bg-background-default-base-hover'
                    >
                      <Icon
                        name={chatPanelVisible ? 'project-canvas-chat-toggle-icon' : 'project-canvas-chat-close-icon'}
                        width={16}
                        height={16}
                        color='var(--color-icon-base)'
                      />
                    </button>
                  </Tooltip>
                </div>
                <div className='absolute right-3 top-3 z-10'>
                  <Tooltip
                    title={rightPanel.open ? 'Collapse editor' : 'Expand editor'}
                    placement='left'
                    triggerClassName='absolute right-0 top-0 z-10'
                  >
                    <button
                      type='button'
                      onClick={handleToggleEditorPanel}
                      className='flex h-8 w-8 items-center justify-center rounded-md bg-background-default-secondary text-icon-secondary transition-colors hover:bg-background-default-base-hover'
                    >
                      <Icon
                        name={rightPanel.open ? 'project-canvas-chat-toggle-icon' : 'project-canvas-chat-close-icon'}
                        width={16}
                        height={16}
                        color='var(--color-icon-base)'
                      />
                    </button>
                  </Tooltip>
                </div>
                <SpaceShell
                  yjs={yjs}
                  userId={currentUserId}
                  hotkeysDisabled={selectedWorkspaceRegion === 'rightEditor'}
                />
              </div>
            </Panel>
          )}
        </Group>
      </div>
    </ProjectWorkspaceRegionContext.Provider>
  );
};

const Project: React.FC = () => <ProjectPage />;

export default Project;
