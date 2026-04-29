import { useCallback, useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import '@xyflow/react/dist/style.css';
import { Group, Panel, Separator } from 'react-resizable-panels';
import { Icon } from '@/components/base/icon';
import Tooltip from '@/components/base/tooltip';
import { useCanvasData, CanvasDataProvider } from '@/contexts/CanvasDataContext';
import { useCanvasActions } from '@/hooks/useCanvasActions';
import { useCanvasUI } from '@/hooks/useCanvasUI';
import { useYjsStore } from '@/hooks/useYjsProjectStore';
import { useUserCenterStore } from '@/hooks/useUserCenterStore';
import { removeToken } from '@/utils/token';
import EditorComingSoonPlaceholder from '@/components/EditorComingSoonPlaceholder';
import ImageEditorPage from '../imageEditor';
import VideoEditorNodePage from '../videoEditorNode';
import TextEditor from './components/textEditor';
import ResizableLeftPanel from './components/canvas/ui/ResizableLeftPanel';
import AiChatRecordPanel from './components/agent/AiChatRecordPanel';
import ProjectCanvas from './components/canvas';
import { ProjectWorkspaceRegionContext, type CanvasWorkflowNodeData } from './components/canvas/types';

/** Local node library metadata (replaces `/api/workflow/node/query` for palette). */
const builtInNodeTemplateData = [
  { template_type: '1001', template_name: 'Text' },
  { template_type: '1002', template_name: 'Image' },
  { template_type: '1003', template_name: 'Video' },
  { template_type: '1004', template_name: 'Audio' },
  { template_type: '6001', template_name: 'Video editor' },
] as const;

/** Outer shell — owns Yjs manager + wraps children in CanvasDataProvider. */
const ProjectPage: React.FC = () => {
  const { projectId: projectIdParam } = useParams<{ projectId: string }>();
  const routeProjectId = projectIdParam ?? undefined;
  const { workflowId, setWorkflowId, setNodeTemplateData } = useCanvasUI();

  useEffect(() => {
    if (routeProjectId && routeProjectId !== workflowId) {
      setWorkflowId(routeProjectId);
    }
  }, [routeProjectId, workflowId, setWorkflowId]);

  useEffect(() => {
    if (!workflowId) return;
    setNodeTemplateData([...builtInNodeTemplateData]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workflowId]);

  const { authInfo } = useUserCenterStore();
  const navigate = useNavigate();
  const sessionToken = authInfo?.state?.token ?? '';

  const yjs = useYjsStore({
    id: workflowId ?? '',
    token: sessionToken,
    enabled: !!workflowId && !!sessionToken,
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
    <CanvasDataProvider manager={yjs.manager ?? null}>
      <ProjectContentBody yjs={yjs} />
    </CanvasDataProvider>
  );
};

/**
 * The actual project content — inside CanvasDataProvider, consumes
 * canvas data through the canvas hooks.
 */
const ProjectContentBody: React.FC<{ yjs: ReturnType<typeof useYjsStore> }> = ({ yjs }) => {
  const { nodes } = useCanvasData();
  const { updateNode } = useCanvasActions();
  const { rightPanel, openRightPanel, closeRightPanel } = useCanvasUI();
  const [workflowName, setWorkflowName] = useState<string>('');
  const [chatPanelVisible, setChatPanelVisible] = useState(true);
  const [canvasPanelVisible, setCanvasPanelVisible] = useState(true);
  const [selectedWorkspaceRegion, setSelectedWorkspaceRegion] = useState<'canvas' | 'rightEditor' | null>('canvas');
  const [isResizingRightEditor, setIsResizingRightEditor] = useState(false);

  const panelNode = rightPanel.nodeId ? nodes.find((n) => n.id === rightPanel.nodeId) : undefined;
  const panelNodeType = String(panelNode?.type ?? '');
  const isTextNode = panelNodeType === '1001';
  const isImageNode = panelNodeType === '1002';
  const isVideoNode = panelNodeType === '1003';
  const isAudioNode = panelNodeType === '1004';
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
    openRightPanel('editor', rightPanel.nodeId, undefined, true);
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
                ) : isImageNode && panelNode ? (
                  <div className='flex h-full min-h-0 w-full flex-col overflow-hidden'>
                    <ImageEditorPage nodeId={panelNode.id} />
                  </div>
                ) : isVideoNode && panelNode ? (
                  <div className='flex h-full min-h-0 w-full flex-col overflow-hidden'>
                    <VideoEditorNodePage nodeId={panelNode.id} />
                  </div>
                ) : isAudioNode && panelNode ? (
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
                <ProjectCanvas yjs={yjs} hotkeysDisabled={selectedWorkspaceRegion === 'rightEditor'} />
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
