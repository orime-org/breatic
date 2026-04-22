import { useCallback, useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import '@xyflow/react/dist/style.css';
import { Group, Panel, Separator } from 'react-resizable-panels';
import { Icon } from '@/components/base/icon';
import Tooltip from '@/components/base/tooltip';
import { useCanvasData, CanvasDataProvider } from '@/contexts/CanvasDataContext';
import { MixedEditorDataProvider, useMixedEditorData } from '@/contexts/MixedEditorDataContext';
import { useCanvasActions } from '@/hooks/useCanvasActions';
import { useCanvasUI } from '@/hooks/useCanvasUI';
import { useMixedEditorActions } from '@/hooks/useMixedEditorActions';
import { useYjsStore } from '@/hooks/useYjsProjectStore';
import { useYjsNodeEditor } from '@/hooks/useYjsNodeEditor';
import { useUserCenterStore } from '@/hooks/useUserCenterStore';
import { removeToken } from '@/utils/token';
import ImageEditor from './components/mixedEditor';
import TextEditor from './components/textEditor';
import ResizableLeftPanel from './components/canvas/ui/ResizableLeftPanel';
import AiChatRecordPanel from './components/agent/AiChatRecordPanel';
import ProjectCanvas from './components/canvas';
import { ProjectWorkspaceRegionContext, type CanvasWorkflowNodeData } from './components/canvas/types';
import type { ImageFlowNodeData } from './components/mixedEditor/types';

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
      // eslint-disable-next-line no-console
      console.warn('[yjs] Authentication failed:', reason);
      removeToken();
      navigate('/login', { replace: true });
    }, [navigate]),
  });

  return (
    <CanvasDataProvider manager={yjs.manager ?? null}>
      <ProjectContentShell yjs={yjs} />
    </CanvasDataProvider>
  );
};

/**
 * Inside the CanvasDataProvider but OUTSIDE the MixedEditorDataProvider
 * — this shell reads the canvas node list to decide which host node
 * (if any) the mixed editor panel is currently bound to, constructs
 * the per-node Yjs editor manager for that node, and installs the
 * MixedEditorDataProvider so the rest of the page (including the
 * agent chat on the left) can read mixed editor state from context.
 *
 * Provider placement mirrors the main canvas: everything that might
 * read mixed editor nodes lives below both providers, so there is no
 * need for a parallel Redux slice or a module-level "active manager"
 * escape hatch — a single source of truth flows through React context.
 */
const ProjectContentShell: React.FC<{ yjs: ReturnType<typeof useYjsStore> }> = ({ yjs }) => {
  const { workflowId } = useCanvasUI();
  const { nodes: canvasNodes } = useCanvasData();
  const { rightPanel } = useCanvasUI();

  const panelNode = rightPanel.nodeId ? canvasNodes.find((n) => n.id === rightPanel.nodeId) : undefined;
  const panelNodeType = String(panelNode?.type ?? '');
  const isMixedEditorNode =
    panelNodeType === '1002' || panelNodeType === '1003' || panelNodeType === '1004';
  const mixedEditorOpen = rightPanel.open && rightPanel.panelType === 'editor' && isMixedEditorNode;

  // The mixed editor manager is per-node — exists only while the panel
  // is open on a mixed-type node. Pass `undefined` (not empty string)
  // so `useYjsNodeEditor`'s guard refuses to start the manager when
  // the panel is closed, and so manager swaps cleanly to the new node
  // when the user opens the panel on a different host.
  const mixedEditorYjs = useYjsNodeEditor({
    projectId: workflowId,
    nodeId: mixedEditorOpen ? rightPanel.nodeId : undefined,
    enabled: mixedEditorOpen,
  });

  return (
    <MixedEditorDataProvider
      manager={mixedEditorYjs.manager}
      hostNodeId={mixedEditorOpen ? rightPanel.nodeId : undefined}
    >
      <ProjectContentBody yjs={yjs} panelNode={panelNode} />
    </MixedEditorDataProvider>
  );
};

/**
 * The actual project content — inside both data providers, consumes
 * canvas + mixed-editor data through their respective hooks.
 */
const ProjectContentBody: React.FC<{
  yjs: ReturnType<typeof useYjsStore>;
  panelNode: ReturnType<typeof useCanvasData>['nodes'][number] | undefined;
}> = ({ yjs, panelNode }) => {
  const { nodes } = useCanvasData();
  const { updateNode } = useCanvasActions();
  const { rightPanel, openRightPanel, closeRightPanel } = useCanvasUI();
  const { nodes: mixedNodes, hasPendingTasks, pendingTaskCount } = useMixedEditorData();
  const { updateNode: updateMixedEditorNode } = useMixedEditorActions();
  const [workflowName, setWorkflowName] = useState<string>('');
  const [chatPanelVisible, setChatPanelVisible] = useState(true);
  const [canvasPanelVisible, setCanvasPanelVisible] = useState(true);
  const [selectedWorkspaceRegion, setSelectedWorkspaceRegion] = useState<'canvas' | 'rightEditor' | null>('canvas');
  const [isResizingRightEditor, setIsResizingRightEditor] = useState(false);

  const exitCanvasPickMode = useCallback(() => {
    // pickState is UI-only (not in Yjs). Once pickState is migrated to
    // local state (P3), this helper will read from that state instead.
    // For now it's a no-op since Yjs-based nodes don't carry pickState.
    for (const n of nodes) {
      const ps = (n.data as Partial<CanvasWorkflowNodeData> | undefined)?.pickState;
      if (ps?.fromCanvas || ps?.resultBoxes?.length) {
        updateNode(n.id, { data: { pickState: null } }, { history: 'skip' });
      }
    }
  }, [nodes, updateNode]);

  const exitImageEditorPickMode = useCallback(() => {
    // pickState for mixed-editor nodes lives in the provider's local
    // overlay (UI-only, never in Yjs). `updateMixedEditorNode` with
    // `data.pickState` is routed to `setNodeLocalData` by the actions
    // hook — so this still correctly clears the overlay entry.
    const hasPickMode = mixedNodes.some(
      (n) => (n.data as Partial<ImageFlowNodeData> | undefined)?.pickState?.fromCanvas === true,
    );
    if (!hasPickMode) return;
    for (const n of mixedNodes) {
      const ps = (n.data as Partial<ImageFlowNodeData> | undefined)?.pickState;
      if (ps?.fromCanvas || ps?.resultBoxes?.length) {
        updateMixedEditorNode(n.id, { data: { pickState: null } }, { history: 'skip' });
      }
    }
  }, [mixedNodes, updateMixedEditorNode]);

  const handleToggleChatPanel = () => {
    setChatPanelVisible((prev) => !prev);
  };

  const handleToggleEditorPanel = () => {
    if (rightPanel.open) {
      // If the mixed editor has in-flight browser-local tasks
      // (ffmpeg.wasm etc — the X pattern), closing the panel
      // unmounts the React tree, which terminates the Web Workers
      // and loses the results. Warn the user first.
      if (hasPendingTasks) {
        const msg = pendingTaskCount === 1
          ? 'A task is still running. Closing the editor will cancel it and the result will be lost. Continue?'
          : `${pendingTaskCount} tasks are still running. Closing the editor will cancel them and the results will be lost. Continue?`;
        if (!window.confirm(msg)) return;
      }
      exitImageEditorPickMode();
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

  const panelNodeType = String(panelNode?.type ?? '');
  const isTextNode = panelNodeType === '1001';
  const isMixedEditorNode = panelNodeType === '1002' || panelNodeType === '1003' || panelNodeType === '1004';
  const isImageNode = panelNodeType === '1002';
  const isRightEditorOpen = rightPanel.open && rightPanel.panelType === 'editor';
  const showChatSeparator = chatPanelVisible && (canvasPanelVisible || isRightEditorOpen);
  const showRightSeparator = isRightEditorOpen && canvasPanelVisible;
  let rightEditorBorderClass = 'border-transparent';
  if (isResizingRightEditor) {
    rightEditorBorderClass = 'border-border-utilities-selected';
  } else if (selectedWorkspaceRegion === 'rightEditor') {
    rightEditorBorderClass = 'border-[#949494]';
  }

  // Keep selectedWorkspaceRegion in sync with the right editor panel state.
  // When the right editor opens (programmatically or via button), treat it as
  // the active region so AgentComposerTabs targets the correct panel.
  useEffect(() => {
    if (isRightEditorOpen) {
      exitCanvasPickMode();
      setSelectedWorkspaceRegion('rightEditor');
    } else {
      exitImageEditorPickMode();
      setSelectedWorkspaceRegion((prev) => (prev === 'rightEditor' ? null : prev));
    }
    // exitCanvasPickMode / exitImageEditorPickMode read from the latest
    // nodes snapshot via their memoised deps; no need to list them here.
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
                    rightPanelIsImageNode={isImageNode}
                  />
                </div>
              </Panel>
              {showChatSeparator ? <Separator id='resize-chat-canvas' className='cursor-col-resize shrink-0' /> : null}
            </>
          )}
          {canvasPanelVisible && (
            <Panel
              id='canvas'
              minSize={0}
              className={`border ${selectedWorkspaceRegion === 'canvas' ? 'border-[#949494]' : 'border-transparent'}`}
              onMouseDownCapture={() => {
                exitImageEditorPickMode();
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
          {isRightEditorOpen && (
            <>
              {showRightSeparator ? (
                <Separator
                  id='resize-canvas-right'
                  className='cursor-col-resize shrink-0'
                  onMouseDownCapture={() => {
                    exitCanvasPickMode();
                    setSelectedWorkspaceRegion('rightEditor');
                    setIsResizingRightEditor(true);
                  }}
                />
              ) : null}
              <Panel
                id='resizable-left'
                defaultSize={700}
                minSize={700}
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
                  ) : isMixedEditorNode && panelNode ? (
                    <ImageEditor nodeId={panelNode.id} hotkeysDisabled={selectedWorkspaceRegion !== 'rightEditor'} />
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
            </>
          )}
        </Group>
      </div>
    </ProjectWorkspaceRegionContext.Provider>
  );
};

const Project: React.FC = () => <ProjectPage />;

export default Project;
