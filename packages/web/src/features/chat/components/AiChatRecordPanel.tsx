import React, { memo, useCallback, useEffect, useImperativeHandle, useRef, useState, forwardRef, useMemo } from 'react';
import { nanoid } from 'nanoid';
import dayjs from 'dayjs';
import { type Node } from '@xyflow/react';
import AgentMessage from '@/features/chat/components/AgentMessage';
import AgentInput, {
  type AgentCanvasPickSurfaceRemovalDetail,
  type AgentComposerInputHandle,
  type AgentResourceType,
} from '@/features/chat/components/AgentInput';
import AgentComposerTabs, {
  type AgentComposerUpstreamItem,
  type AgentComposerUploadItem,
} from '@/features/chat/components/AgentComposerTabs';
import AgentSendButton from '@/features/chat/components/AgentSendButton';
import { useCanvasData } from '@/spaces/canvas/contexts/CanvasDataContext';
import { useCanvasActions } from '@/spaces/canvas/hooks/useCanvasActions';
import { useProjectLayout } from '@/app/contexts/ProjectLayoutContext';
import EmptyChatRecordState from './EmptyChatRecordState';
import type { PickResultBox, CanvasWorkflowNodeData } from '@/spaces/canvas/types';
import { Icon } from '@/ui/icon';
// PR-Y2 lifted ProjectHeader (logo / title / import-export) and the
// UserCenter widget (account / credits) into the full-width
// `features/top-bar`. The chat panel header is now reduced to chat-
// specific affordances (New conversation, History).

/** Title bar metadata for the chat record panel layout. */
export const panelTitle = {
  title: 'AI Chat Record',
  icon: 'project-ai-chat-record-icon',
} as const;

export type MessageItem = {
  id: string;
  type: 'user' | 'assistant';
  senderName: string;
  /** Message body: plain text or HTML. */
  content: string;
  loading?: boolean;
  /** Optional image attachments shown in a horizontal row. */
  imageUrls?: string[];
};

/** Placeholder messages until messages are loaded per `nodeId` from the API. */
const initialMessageList: MessageItem[] = [];

const assistantReplyAfterLoading = 'Assistant reply (demo, after 3s delay).';
const defaultRecognizedLabel = '山脉';

/** Canvas node type ids: text, image, video, audio. */
export type CanvasNodeType = '1001' | '1002' | '1003' | '1004';

const nodeTypeToHandle: Record<CanvasNodeType, { handleType: 'Text' | 'Image' | 'Video' | 'Audio' }> = {
  '1001': { handleType: 'Text' },
  '1002': { handleType: 'Image' },
  '1003': { handleType: 'Video' },
  '1004': { handleType: 'Audio' },
};

const canvasNodeTypeDefaultName: Record<CanvasNodeType, string> = {
  '1001': 'text',
  '1002': 'image',
  '1003': 'video',
  '1004': 'audio',
};

/** Imperative handle: composer helpers plus adding resources as canvas nodes. */
export interface AiChatRecordPanelHandle extends Pick<
  AgentComposerInputHandle,
  'addImageFromUrl' | 'addResourceFromUrl'
> {
  /** Legacy alias: create an image node from a URL. */
  addImageToCanvas?: (url: string) => void;
  /** Create a node of the given type (1001–1004) from a URL. */
  addResourceToCanvas?: (url: string, nodeType: CanvasNodeType) => void;
}

type AiChatRecordPanelProps = React.ComponentPropsWithoutRef<'div'> & {
  /** Project name shown in the header. */
  projectName?: string;
  /** Updates project title in parent when the user renames (no HTTP). */
  onProjectNameCommit?: (name: string) => void;
  /** When false, hides the user-center info badge in the narrow sidebar header. */
  showUserCenterInfoBadge?: boolean;

  selectedWorkspaceRegion?: 'canvas' | 'rightEditor' | null;
  /** True when the right editor is currently showing an image node. */
  rightPanelIsImageNode?: boolean;
};

/**
 * Side panel: chat transcript scoped to the active node; messages are stubbed until API wiring.
 */
const AiChatRecordPanelComponent = forwardRef<AiChatRecordPanelHandle, AiChatRecordPanelProps>(
  (
    {
      projectName,
      onProjectNameCommit,
      showUserCenterInfoBadge = false,
      selectedWorkspaceRegion,
      rightPanelIsImageNode = false,
      ...rest
    },
    ref,
  ) => {
    const { nodes, edges } = useCanvasData();
    const { addNode, updateNode, onNodesChange, onEdgesChange, onConnect } = useCanvasActions();
    const { rightPanel, openRightPanel } = useProjectLayout();
    const nodesRef = useRef(nodes);
    /** Active node id from the right panel or current selection; empty string shows an empty thread. */
    const selectedNode = nodes.find((n) => n.selected);
    const [activeNodeId, setActiveNodeId] = useState<string>('');
    const nodeId = activeNodeId;
    const [messageList, setMessageList] = useState<MessageItem[]>(initialMessageList);
    const scrollContainerRef = useRef<HTMLDivElement>(null);
    const inputRef = useRef<AgentComposerInputHandle>(null);
    const [inputEmpty, setInputEmpty] = useState(true);
    const lastProcessedPickInjectRef = useRef<string | null>(null);
    const processedCanvasPickIdsRef = useRef(new Set<string>());
    const processedCanvasMentionPickIdsRef = useRef(new Set<string>());
    const [uploadItems, setUploadItems] = useState<AgentComposerUploadItem[]>([]);
    const uploadItemsRef = useRef<AgentComposerUploadItem[]>([]);
    uploadItemsRef.current = uploadItems;

    const [upstreamItems, setUpstreamItems] = useState<AgentComposerUpstreamItem[]>([]);

    const mapFileToUploadItem = useCallback(async (file: File): Promise<AgentComposerUploadItem> => {
      const id = nanoid();

      if (file.type.startsWith('image/')) {
        return { id, type: 'image', previewUrl: URL.createObjectURL(file), name: file.name };
      }

      if (file.type.startsWith('video/')) {
        return { id, type: 'video', previewUrl: URL.createObjectURL(file), name: file.name };
      }

      if (file.type.startsWith('audio/')) {
        return { id, type: 'audio', previewUrl: URL.createObjectURL(file), name: file.name };
      }

      if (file.type === 'text/plain' || file.name.toLowerCase().endsWith('.txt')) {
        // For text chips, we store the actual content so `AgentInput` can preview it.
        const content = await file.text();
        return { id, type: 'text', previewUrl: content, name: file.name };
      }

      // Generic file: we still provide a stable string in `previewUrl` so clicking can insert.
      return { id, type: 'file', previewUrl: file.name, name: file.name };
    }, []);

    const handleComposerFiles = useCallback(
      (files: File[]) => {
        void (async () => {
          const mapped = await Promise.all(files.map(mapFileToUploadItem));
          setUploadItems((prev) => [...prev, ...mapped]);
        })();
      },
      [mapFileToUploadItem],
    );

    const handleRemoveUpload = useCallback((id: string) => {
      setUploadItems((prev) => {
        const hit = prev.find((u) => u.id === id);
        if (hit?.previewUrl?.startsWith('blob:')) URL.revokeObjectURL(hit.previewUrl);
        return prev.filter((u) => u.id !== id);
      });
    }, []);

    useEffect(
      () => () => {
        uploadItemsRef.current.forEach((u) => {
          if (u.previewUrl?.startsWith('blob:')) URL.revokeObjectURL(u.previewUrl);
        });
      },
      [],
    );

    useEffect(() => {
      nodesRef.current = nodes;
    }, [nodes]);

    useEffect(() => {
      const next = rightPanel.nodeId ?? selectedNode?.id ?? '';
      if (!next) return;
      setActiveNodeId((prev) => (prev === next ? prev : next));
    }, [rightPanel.nodeId, selectedNode?.id]);

    useEffect(() => {
      if (!activeNodeId) return;
      const exists = nodes.some((n) => n.id === activeNodeId);
      if (!exists) setActiveNodeId('');
    }, [activeNodeId, nodes]);

    const handleAddResourceToCanvas = useCallback(
      (url: string, nodeType: CanvasNodeType) => {
        const selected = nodes.find((n) => n.selected);
        const nodeCenterTarget = selected
          ? { x: selected.position.x + 48, y: selected.position.y + 48 }
          : { x: 200, y: 200 };
        const maxZIndex = nodes.reduce((max, node) => {
          const zIndex = (node as Node & { zIndex?: number }).zIndex ?? 0;
          return Math.max(max, zIndex);
        }, 0);
        const timestamp = dayjs().valueOf();
        const randomString = nanoid(5);
        const { handleType } = nodeTypeToHandle[nodeType];
        const newNodeId = `${nodeType}-${timestamp}-${randomString}`;
        const newNode: Node & { zIndex?: number; style?: React.CSSProperties } = {
          id: newNodeId,
          type: nodeType,
          position: nodeCenterTarget,
          selected: true,
          zIndex: maxZIndex + 1,
          style: { opacity: 0 },
          data: {
            name: canvasNodeTypeDefaultName[nodeType],
            content: url,
            state: 'idle',
            handles: {
              target: [{ handleType, number: 1 }],
            },
          },
        };
        addNode(newNode, { select: true });
        const existingNode = nodes.find((n) => n.type === nodeType && n.measured?.height);
        const nodeHeight = existingNode?.measured?.height;
        if (nodeHeight) {
          updateNode(newNodeId, {
            position: {
              x: nodeCenterTarget.x,
              y: nodeCenterTarget.y - nodeHeight / 2,
            },
            style: undefined,
          });
          return;
        }
        const adjustPosition = () => {
          const node = nodesRef.current.find((n) => n.id === newNodeId);
          if (node?.measured?.height) {
            updateNode(newNodeId, {
              position: {
                x: nodeCenterTarget.x,
                y: nodeCenterTarget.y - node.measured.height / 2,
              },
              style: undefined,
            });
            return;
          }
          requestAnimationFrame(adjustPosition);
        };
        requestAnimationFrame(adjustPosition);
      },
      [nodes, addNode, updateNode],
    );

    useImperativeHandle(
      ref,
      () => ({
        addImageFromUrl: (url: string) => inputRef.current?.addImageFromUrl(url),
        addResourceFromUrl: (url: string, name: string, type: AgentResourceType) =>
          inputRef.current?.addResourceFromUrl(url, name, type),
        addImageToCanvas: (url: string) => handleAddResourceToCanvas(url, '1002'),
        addResourceToCanvas: handleAddResourceToCanvas,
      }),
      [handleAddResourceToCanvas],
    );

    useEffect(() => {
      if (nodeId) {
        setMessageList(initialMessageList);
      }
    }, [nodeId]);

    const scrollToBottom = useCallback(() => {
      const el = scrollContainerRef.current;
      if (!el) return;
      el.scrollTop = el.scrollHeight;
    }, []);

    useEffect(() => {
      const timer = window.setTimeout(scrollToBottom, 0);
      return () => window.clearTimeout(timer);
    }, [messageList.length, scrollToBottom]);

    const handleSend = useCallback((content: string) => {
      const userMsg: MessageItem = {
        id: nanoid(),
        type: 'user',
        senderName: 'You',
        content,
      };
      const assistantMsg: MessageItem = {
        id: nanoid(),
        type: 'assistant',
        senderName: 'Assistant',
        content: '',
        loading: true,
      };
      setMessageList((prev) => [...prev, userMsg, assistantMsg]);
      const assistantId = assistantMsg.id;
      window.setTimeout(() => {
        setMessageList((prev) =>
          prev.map((m) => (m.id === assistantId ? { ...m, loading: false, content: assistantReplyAfterLoading } : m)),
        );
      }, 3000);
    }, []);

    const handleSendClick = useCallback(() => {
      const input = inputRef.current;
      if (!input || input.isEmpty()) return;
      const content = input.getHtml();
      handleSend(content);
      input.clear();
    }, [handleSend]);

    const handleUpstreamItemClick = useCallback(
      (item: AgentComposerUpstreamItem) => {
        if (!item.previewUrl) return;
        const type = item.mediaType ?? 'file';
        inputRef.current?.addResourceFromUrl(item.previewUrl, item.name ?? 'File', type);
      },
      [inputRef],
    );

    const handleUploadItemClick = useCallback(
      (item: AgentComposerUploadItem) => {
        if (item.type === 'image' && item.previewUrl) {
          inputRef.current?.addResourceFromUrl(item.previewUrl, item.name ?? 'Image', 'image');
          return;
        }

        if (item.type === 'text') {
          // Empty text still inserts a chip so the user can fill content later.
          inputRef.current?.addResourceFromUrl(item.previewUrl ?? '', item.name ?? 'Text', item.type);
          return;
        }

        if (item.previewUrl) inputRef.current?.addResourceFromUrl(item.previewUrl, item.name ?? 'File', item.type);
      },
      [inputRef],
    );

    const panelNode = nodeId ? nodes.find((n) => n.id === nodeId) : undefined;
    const panelPickData = (panelNode?.data as Partial<CanvasWorkflowNodeData> | undefined)?.pickState;
    const pickInject = panelPickData?.inject;
    const pickSelection = panelPickData?.selection;
    const storedPickConsume = panelPickData?.consumeFrom ?? 'nodeComposer';
    const agentCanvasPickPendingList = useMemo(() => panelPickData?.pendingList ?? [], [panelPickData?.pendingList]);

    /** Canvas pick flow: recognizing placeholder, then chip + result overlay when `consumeFrom` is this panel. */
    useEffect(() => {
      const sourceNodeId = nodeId || undefined;
      if (!sourceNodeId || storedPickConsume !== 'chatRecordPanel' || agentCanvasPickPendingList.length === 0) return;

      for (const pending of agentCanvasPickPendingList) {
        if (processedCanvasPickIdsRef.current.has(pending.placeholderId)) continue;
        processedCanvasPickIdsRef.current.add(pending.placeholderId);

        const { placeholderId, targetNodeId: pickedNodeId, content: pickedContent, name } = pending;
        const recognizedLabel = defaultRecognizedLabel || name;

        inputRef.current?.appendCanvasPickRecognizingPlaceholder(placeholderId);

        window.setTimeout(() => {
          const source = nodes.find((n: Node) => n.id === sourceNodeId);
          const sourcePs = (source?.data as Partial<CanvasWorkflowNodeData> | undefined)?.pickState;
          const currentList = sourcePs?.pendingList ?? [];
          if (!currentList.some((p) => p.placeholderId === placeholderId)) {
            processedCanvasPickIdsRef.current.delete(placeholderId);
            return;
          }

          inputRef.current?.replaceCanvasPickPlaceholderWithImageChip(placeholderId, pickedContent, recognizedLabel);
          const nextList = currentList.filter((p) => p.placeholderId !== placeholderId);
          updateNode(
            sourceNodeId,
            { data: { pickState: { pendingList: nextList.length ? nextList : null } } },
            { history: 'skip' },
          );

          const wPct = 26;
          const hPct = 26;
          const rawCx = pending.overlayAnchor?.xPct ?? 50;
          const rawCy = pending.overlayAnchor?.yPct ?? 50;
          const halfW = wPct / 2;
          const halfH = hPct / 2;
          const cxPct = Math.min(100 - halfW, Math.max(halfW, rawCx));
          const cyPct = Math.min(100 - halfH, Math.max(halfH, rawCy));
          const picked = nodes.find((n: Node) => n.id === pickedNodeId);
          const prev = ((picked?.data as Partial<CanvasWorkflowNodeData> | undefined)?.pickState?.resultBoxes ??
            []) as PickResultBox[];
          const nextBox: PickResultBox = { cxPct, cyPct, wPct, hPct, placeholderId };
          nextBox.sourceNodeId = sourceNodeId;
          nextBox.content = pickedContent;
          nextBox.name = recognizedLabel;
          nextBox.resourceType = pending.resourceType ?? 'image';
          updateNode(
            pickedNodeId,
            {
              data: { pickState: { resultBoxes: [...prev, nextBox] } },
            },
            { history: 'skip' },
          );

          processedCanvasPickIdsRef.current.delete(placeholderId);
        }, 3000);
      }
    }, [nodes, nodeId, agentCanvasPickPendingList, storedPickConsume, updateNode, inputRef]);

    useEffect(() => {
      const currentPendingIds = new Set(agentCanvasPickPendingList.map((p) => p.placeholderId));
      for (const placeholderId of Array.from(processedCanvasPickIdsRef.current)) {
        if (currentPendingIds.has(placeholderId)) continue;
        inputRef.current?.removeCanvasPickPlaceholder(placeholderId);
        processedCanvasPickIdsRef.current.delete(placeholderId);
      }
    }, [agentCanvasPickPendingList]);

    useEffect(() => {
      if (!nodeId) {
        lastProcessedPickInjectRef.current = null;
        return;
      }
      if (!pickInject?.content) {
        lastProcessedPickInjectRef.current = null;
        return;
      }
      const sig = `${pickInject.content}\0${pickInject.name}`;
      if (lastProcessedPickInjectRef.current === sig) return;
      lastProcessedPickInjectRef.current = sig;
      inputRef.current?.addResourceFromUrl(pickInject.content, pickInject.name, pickInject.type);
      updateNode(nodeId, { data: { pickState: { inject: null } } }, { history: 'skip' });
    }, [nodeId, pickInject, updateNode]);

    useEffect(() => {
      if (!nodeId || !pickSelection?.placeholderId || !pickSelection.content) return;
      inputRef.current?.replaceCanvasPickChipById(
        pickSelection.placeholderId,
        pickSelection.content,
        pickSelection.name ?? 'image',
        pickSelection.resourceType ?? 'image',
      );
      updateNode(nodeId, { data: { pickState: { selection: null } } }, { history: 'skip' });
    }, [nodeId, pickSelection, updateNode]);

    const handleAgentLayoutPickClick = useCallback(() => {
      if (!nodeId) return;
      inputRef.current?.focusEditor();
      // Canvas is the active region: enable on-canvas pick mode only; do not open the right editor
      // (which would switch focus to the image editor for image nodes).
      if (selectedWorkspaceRegion !== 'canvas') {
        openRightPanel('editor', nodeId);
      }
      for (const n of nodes) {
        const ps = (n.data as Partial<CanvasWorkflowNodeData> | undefined)?.pickState;
        if (ps?.fromCanvas && n.id !== nodeId) {
          updateNode(n.id, { data: { pickState: null } }, { history: 'skip' });
        }
      }
      onNodesChange(
        nodes.map((n) => ({ type: 'select' as const, id: n.id, selected: n.id === nodeId })),
        { history: 'skip' },
      );
      updateNode(
        nodeId,
        {
          selected: true,
          data: {
            pickState: {
              fromCanvas: true,
              composerFocused: true,
              pendingList: null,
              consumeFrom: 'chatRecordPanel',
            },
          },
        },
        { history: 'skip' },
      );
    }, [nodeId, nodes, onNodesChange, openRightPanel, selectedWorkspaceRegion, updateNode]);

    const effectiveUpstreamTargetNodeId = useMemo(() => {
      if (selectedWorkspaceRegion === 'canvas') return selectedNode?.id ?? '';
      if (selectedWorkspaceRegion === 'rightEditor') return rightPanel.nodeId ?? '';
      return nodeId;
    }, [selectedWorkspaceRegion, selectedNode?.id, rightPanel.nodeId, nodeId]);

    const handleRemoveUpstreamItem = useCallback(
      (itemId: string) => {
        const sourceNodeId = itemId.startsWith('upstream-')
          ? itemId.slice('upstream-'.length)
          : itemId.replace(/-(image|video|audio|text|file)$/, '');
        if (!effectiveUpstreamTargetNodeId) return;
        const edgeToRemove = edges.find((e) => e.source === sourceNodeId && e.target === effectiveUpstreamTargetNodeId);
        if (!edgeToRemove) return;
        onEdgesChange([{ type: 'remove', id: edgeToRemove.id }]);
      },
      [effectiveUpstreamTargetNodeId, edges, onEdgesChange],
    );

    /** Mention pick — canvas mode: enter pick mode without selecting the source node (no toolbar). */
    const handleCanvasMentionClick = useCallback(() => {
      if (!nodeId) return;
      inputRef.current?.focusEditor();
      if (selectedWorkspaceRegion !== 'canvas') {
        openRightPanel('editor', nodeId);
      }
      for (const n of nodes) {
        const ps = (n.data as Partial<CanvasWorkflowNodeData> | undefined)?.pickState;
        if (ps?.fromCanvas && n.id !== nodeId) {
          updateNode(n.id, { data: { pickState: null } }, { history: 'skip' });
        }
      }
      updateNode(
        nodeId,
        {
          data: {
            pickState: {
              fromCanvas: true,
              composerFocused: true,
              pendingList: null,
              consumeFrom: 'chatRecordPanelMention',
            },
          },
        },
        { history: 'skip' },
      );
    }, [nodeId, nodes, openRightPanel, selectedWorkspaceRegion, updateNode]);

    const handleMentionClick = handleCanvasMentionClick;

    /** Canvas mention pick flow: create a canvas edge from the picked node to this node. */
    useEffect(() => {
      const sourceNodeId = nodeId || undefined;
      if (!sourceNodeId || storedPickConsume !== 'chatRecordPanelMention' || agentCanvasPickPendingList.length === 0)
        return;

      for (const pending of agentCanvasPickPendingList) {
        if (processedCanvasMentionPickIdsRef.current.has(pending.placeholderId)) continue;
        processedCanvasMentionPickIdsRef.current.add(pending.placeholderId);

        onConnect({ source: pending.targetNodeId, target: sourceNodeId, sourceHandle: null, targetHandle: null });

        const nextList = agentCanvasPickPendingList.filter((p) => p.placeholderId !== pending.placeholderId);
        updateNode(
          sourceNodeId,
          { data: { pickState: { pendingList: nextList.length ? nextList : null } } },
          { history: 'skip' },
        );

        processedCanvasMentionPickIdsRef.current.delete(pending.placeholderId);
      }
    }, [nodeId, agentCanvasPickPendingList, storedPickConsume, updateNode, onConnect]);

    const handleCanvasPickSurfaceRemoved = useCallback(
      (detail: AgentCanvasPickSurfaceRemovalDetail) => {
        if (detail.surface === 'recognizing') {
          for (const n of nodes) {
            const ps = (n.data as Partial<CanvasWorkflowNodeData> | undefined)?.pickState;
            if (!ps) continue;
            const list = ps.pendingList ?? [];
            const nextList = list.filter((p) => p.placeholderId !== detail.placeholderId);
            const legacy = ps.pending;
            const clearLegacy = legacy?.placeholderId === detail.placeholderId;
            if (nextList.length === list.length && !clearLegacy) continue;
            updateNode(
              n.id,
              {
                data: {
                  pickState: {
                    ...(nextList.length !== list.length ? { pendingList: nextList.length ? nextList : null } : {}),
                    ...(clearLegacy ? { pending: null } : {}),
                  },
                },
              },
              { history: 'skip' },
            );
          }
          return;
        }

        for (const n of nodes) {
          const ps = (n.data as Partial<CanvasWorkflowNodeData> | undefined)?.pickState;
          const boxes = ps?.resultBoxes ?? [];
          const nextBoxes = boxes.filter((b) => b.placeholderId !== detail.placeholderId);
          if (nextBoxes.length === boxes.length) continue;
          updateNode(
            n.id,
            {
              data: {
                pickState: {
                  resultBoxes: nextBoxes.length ? nextBoxes : null,
                },
              },
            },
            { history: 'skip' },
          );
        }
      },
      [nodes, updateNode],
    );

    return (
      <div className='flex flex-col h-full min-h-0' {...rest}>
        <div className='h-12 flex flex-nowrap items-center justify-end gap-1 w-full shrink-0 px-2 border-b border-border-default-base bg-background-default-base'>
          <button
            type='button'
            className='shrink-0 flex items-center justify-center w-8 h-8 rounded hover:bg-background-default-secondary transition-colors'
            aria-label='New conversation'
          >
            <Icon name='project-chat-header-tool-icon' width={27} height={25} color='var(--color-icon-secondary)' />
          </button>
          <button
            type='button'
            className='shrink-0 flex items-center justify-center w-8 h-8 rounded hover:bg-background-default-secondary transition-colors'
            aria-label='History'
          >
            <Icon name='project-chat-header-history-icon' width={24} height={24} color='var(--color-icon-secondary)' />
          </button>
        </div>
        <div ref={scrollContainerRef} className='flex-1 min-h-0 overflow-auto px-4 py-4 flex flex-col gap-4'>
          {messageList.length === 0 ? (
            <EmptyChatRecordState />
          ) : (
            messageList.map((msg) => (
              <AgentMessage
                key={msg.id}
                role={msg.type}
                senderName={msg.senderName}
                content={msg.loading ? 'loading...' : msg.content}
              />
            ))
          )}
        </div>
        <div className='flex-shrink-0 p-4 pt-0'>
          <div className='rounded-[16px] border border-[var(--color-border-default-base)] bg-background-default-base p-[10px]'>
            <AgentComposerTabs
              upstreamTargetNodeId={effectiveUpstreamTargetNodeId}
              onUpstreamItemsChange={setUpstreamItems}
              upstreamItems={upstreamItems}
              uploadItems={uploadItems}
              onUpstreamItemClick={handleUpstreamItemClick}
              onRemoveUpstreamItem={handleRemoveUpstreamItem}
              onFilesSelected={handleComposerFiles}
              onRemoveUpload={handleRemoveUpload}
              onUploadItemClick={handleUploadItemClick}
              onLayoutClick={handleAgentLayoutPickClick}
              onMentionClick={handleMentionClick}
              showTrailingActions={false}
            />
            <AgentInput
              ref={inputRef}
              canvasPickSourceId={nodeId}
              placeholder={'Use "/" to activate skills.\nUse "@" to add resources to the dialogue.'}
              onEnterSend={handleSendClick}
              onEmptyChange={setInputEmpty}
              onFocusChange={(focused) => {
                if (!focused || !nodeId) return;
                updateNode(nodeId, { data: { pickState: { composerFocused: true } } }, { history: 'skip' });
              }}
              upstreamItems={upstreamItems}
              uploadItems={uploadItems}
              onCanvasPickSurfaceRemoved={handleCanvasPickSurfaceRemoved}
              className='mb-[8px] h-[84px] break-words whitespace-pre-wrap'
            />
            <AgentSendButton disabled={inputEmpty} onClick={handleSendClick} />
          </div>
        </div>
      </div>
    );
  },
);

const AiChatRecordPanel = memo(AiChatRecordPanelComponent);
export default AiChatRecordPanel;
