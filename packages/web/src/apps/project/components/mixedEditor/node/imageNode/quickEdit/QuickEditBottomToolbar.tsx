import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { nanoid } from 'nanoid';
import type { Edge, Node } from '@xyflow/react';
import { Icon } from '@/components/base/icon';
import { Button } from '@/components/base/button';
import Tooltip from '@/components/base/tooltip';
import AgentComposerInput, {
  type AgentCanvasPickSurfaceRemovalDetail,
  type AgentComposerInputHandle,
} from '@/components/base/agent/AgentInput';
import AgentComposerTabs, {
  type AgentComposerUpstreamItem,
  type AgentComposerUploadItem,
} from '@/components/base/agent/AgentComposerTabs';
import { useMixedEditorData } from '@/contexts/MixedEditorDataContext';
import { useMixedEditorActions } from '@/hooks/useMixedEditorActions';
import type { ImageFlowNodeData } from '../../../types';
import type { ImageEditorPickResultBox, ImageEditorPickState } from '../../../types';
import store from '@/store';

type QuickEditBottomToolbarProps = {
  nodeId: string;
  active: boolean;
  onClose: () => void;
  onSend: (content: string) => void;
  onComposerLayoutClick?: () => void;
  topSlot?: React.ReactNode;
};

const trailingSquareBtnClass = 'flex h-7 w-7 shrink-0 cursor-pointer select-none items-center justify-center rounded-[4px] border border-[var(--color-border-default-base)] bg-background-default-base text-[var(--color-icon-base)] transition-colors hover:bg-[var(--color-background-default-base-hover)] disabled:cursor-not-allowed disabled:opacity-50';
const disabledLeftSlotClass = 'inline-flex h-[40px] items-center gap-1.5 rounded-full border border-[#C8C8C8] px-4 text-[12px] font-semibold !text-text-disabled-base cursor-not-allowed bg-[var(--color-background-default-base)]';
const defaultRecognizedLabel = '山脉';

/**
 * Builds upstream thumbnails for the image editor graph (incoming edges → source nodes with `content`).
 *
 * @param nodes - Image editor React Flow nodes
 * @param edges - Image editor edges
 * @param targetId - Node id whose inbound edges define upstream
 * @returns Items for {@link AgentComposerTabs} / {@link AgentComposerInput}
 */
const buildImageEditorUpstreamItems = (nodes: Node[], edges: Edge[], targetId: string): AgentComposerUpstreamItem[] => {
  const inbound = edges.filter((e) => e.target === targetId);
  if (!inbound.length) return [];
  const sourceIds = inbound.map((e) => e.source);
  return sourceIds
    .map((sid) => nodes.find((n) => n.id === sid))
    .filter((n): n is Node => Boolean(n))
    .map((node) => {
      const data = node.data as Partial<ImageFlowNodeData> | undefined;
      const content = typeof data?.content === 'string' ? data.content : '';
      if (!content.trim()) return null;
      const name = typeof data?.name === 'string' && data.name.trim() ? data.name : undefined;
      return {
        id: `upstream-${node.id}`,
        previewUrl: content,
        name,
        mediaType: 'image' as const,
      };
    })
    .filter(Boolean) as AgentComposerUpstreamItem[];
};

/**
 * Image editor Quick Edit: {@link AgentComposerTabs} + {@link AgentComposerInput} (same pattern as chat record panel), exit on the right.
 */
const QuickEditBottomToolbar: React.FC<QuickEditBottomToolbarProps> = ({
  nodeId,
  active,
  onClose,
  onSend,
  onComposerLayoutClick,
  topSlot,
}) => {
  const { nodes, edges } = useMixedEditorData();
  const { updateNode, onNodesChange, onEdgesChange, onConnect } = useMixedEditorActions();
  const inputRef = useRef<AgentComposerInputHandle>(null);
  const [inputEmpty, setInputEmpty] = useState(true);
  const processedPickIdsRef = useRef(new Set<string>());
  const processedMentionPickIdsRef = useRef(new Set<string>());
  const [uploadItems, setUploadItems] = useState<AgentComposerUploadItem[]>([]);
  const uploadItemsRef = useRef<AgentComposerUploadItem[]>([]);
  uploadItemsRef.current = uploadItems;

  const upstreamItems = useMemo(
    () => (active && nodeId ? buildImageEditorUpstreamItems(nodes, edges, nodeId) : []),
    [active, nodeId, nodes, edges],
  );

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
      const content = await file.text();
      return { id, type: 'text', previewUrl: content, name: file.name };
    }

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
    if (!active) return;
    inputRef.current?.clear();
    setInputEmpty(true);
    setUploadItems((prev) => {
      prev.forEach((u) => {
        if (u.previewUrl?.startsWith('blob:')) URL.revokeObjectURL(u.previewUrl);
      });
      return [];
    });
  }, [active]);

  const handleUpstreamItemClick = useCallback((item: AgentComposerUpstreamItem) => {
    if (!item.previewUrl) return;
    const type = item.mediaType ?? 'file';
    inputRef.current?.focusEditor();
    inputRef.current?.addResourceFromUrl(item.previewUrl, item.name ?? 'File', type);
  }, []);

  const handleUploadItemClick = useCallback((item: AgentComposerUploadItem) => {
    inputRef.current?.focusEditor();
    if (item.type === 'image' && item.previewUrl) {
      inputRef.current?.addResourceFromUrl(item.previewUrl, item.name ?? 'Image', 'image');
      return;
    }

    if (item.type === 'text') {
      inputRef.current?.addResourceFromUrl(item.previewUrl ?? '', item.name ?? 'Text', item.type);
      return;
    }

    if (item.previewUrl) inputRef.current?.addResourceFromUrl(item.previewUrl, item.name ?? 'File', item.type);
  }, []);

  const handleSendClick = () => {
    const input = inputRef.current;
    if (!input || input.isEmpty()) return;
    const content = input.getHtml();
    onSend(content);
    input.clear();
    setInputEmpty(true);
  };

  const handleMentionClick = useCallback(() => {
    if (!nodeId) return;
    inputRef.current?.focusEditor();
    for (const n of nodes) {
      const ps = (n.data as Partial<ImageFlowNodeData> | undefined)?.pickState;
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
            consumeFrom: 'quickEditMention',
          } satisfies ImageEditorPickState,
        },
      },
      { history: 'skip' },
    );
  }, [nodeId, nodes, onNodesChange, updateNode]);

  const handleExitQuickEdit = useCallback(() => {
    for (const n of nodes) {
      const ps = (n.data as Partial<ImageFlowNodeData> | undefined)?.pickState;
      if (ps?.resultBoxes?.length) {
        updateNode(n.id, { data: { pickState: null } }, { history: 'skip' });
      }
    }
    if (nodeId) {
      updateNode(nodeId, { data: { pickState: null } }, { history: 'skip' });
    }
    onClose();
  }, [nodeId, nodes, onClose, updateNode]);

  const handleCanvasPickSurfaceRemoved = useCallback(
    (detail: AgentCanvasPickSurfaceRemovalDetail) => {
      const nodesForRemoval = store.getState().mixedEditor.nodes;
      if (detail.surface === 'recognizing') {
        for (const n of nodesForRemoval) {
          const ps = (n.data as Partial<ImageFlowNodeData> | undefined)?.pickState;
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

      for (const n of nodesForRemoval) {
        const ps = (n.data as Partial<ImageFlowNodeData> | undefined)?.pickState;
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
    [updateNode],
  );

  const handleAddToInput = useCallback(() => {
    const currentNode = nodeId ? nodes.find((n) => n.id === nodeId) : undefined;
    const content = (currentNode?.data as Partial<ImageFlowNodeData> | undefined)?.content;
    const name = (currentNode?.data as Partial<ImageFlowNodeData> | undefined)?.name ?? 'Image';
    if (!content) return;
    inputRef.current?.addResourceFromUrl(content, name, 'image');
  }, [nodeId, nodes]);

  const handleFocusEditorClick = useCallback(() => {
    if (onComposerLayoutClick) {
      onComposerLayoutClick();
      return;
    }

    // Default: enter image-editor pick mode for Quick Edit.
    if (!nodeId) return;
    inputRef.current?.focusEditor();
    for (const n of nodes) {
      const ps = (n.data as Partial<ImageFlowNodeData> | undefined)?.pickState;
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
            consumeFrom: 'quickEdit',
          } satisfies ImageEditorPickState,
        },
      },
      { history: 'skip' },
    );
  }, [nodeId, nodes, onComposerLayoutClick, onNodesChange, updateNode]);

  const currentNode = nodeId ? nodes.find((n) => n.id === nodeId) : undefined;
  const currentPickData = (currentNode?.data as Partial<ImageFlowNodeData> | undefined)?.pickState;
  const agentCanvasPickPendingList = useMemo(() => currentPickData?.pendingList ?? [], [currentPickData?.pendingList]);
  const storedPickConsume = currentPickData?.consumeFrom ?? 'nodeComposer';

  useEffect(() => {
    if (!active || !nodeId) return;
    if (storedPickConsume !== 'quickEdit' || agentCanvasPickPendingList.length === 0) return;

    for (const pending of agentCanvasPickPendingList) {
      if (processedPickIdsRef.current.has(pending.placeholderId)) continue;
      processedPickIdsRef.current.add(pending.placeholderId);

      const { placeholderId, content, name } = pending;
      const recognizedLabel = defaultRecognizedLabel || name;

      inputRef.current?.appendCanvasPickRecognizingPlaceholder(placeholderId);

      window.setTimeout(() => {
        const currentNodes = store.getState().mixedEditor.nodes;
        const source = currentNodes.find((n) => n.id === nodeId);
        const sourcePs = (source?.data as Partial<ImageFlowNodeData> | undefined)?.pickState;
        const currentList = sourcePs?.pendingList ?? [];
        if (!currentList.some((p) => p.placeholderId === placeholderId)) {
          processedPickIdsRef.current.delete(placeholderId);
          return;
        }

        inputRef.current?.replaceCanvasPickPlaceholderWithImageChip(placeholderId, content, recognizedLabel);
        const nextList = currentList.filter((p) => p.placeholderId !== placeholderId);
        updateNode(
          nodeId,
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
        const picked = currentNodes.find((n) => n.id === pending.targetNodeId);
        const prev = ((picked?.data as Partial<ImageFlowNodeData> | undefined)?.pickState?.resultBoxes ??
          []) as ImageEditorPickResultBox[];
        const nextBox: ImageEditorPickResultBox = {
          cxPct,
          cyPct,
          wPct,
          hPct,
          placeholderId: pending.placeholderId,
          sourceNodeId: nodeId,
          content,
          name: recognizedLabel,
        };
        updateNode(
          pending.targetNodeId,
          {
            data: { pickState: { resultBoxes: [...prev, nextBox] } },
          },
          { history: 'skip' },
        );

        processedPickIdsRef.current.delete(placeholderId);
      }, 3000);
    }
  }, [active, nodeId, agentCanvasPickPendingList, storedPickConsume, updateNode, inputRef]);

  useEffect(() => {
    const currentPendingIds = new Set(agentCanvasPickPendingList.map((p) => p.placeholderId));
    for (const placeholderId of Array.from(processedPickIdsRef.current)) {
      if (currentPendingIds.has(placeholderId)) continue;
      inputRef.current?.removeCanvasPickPlaceholder(placeholderId);
      processedPickIdsRef.current.delete(placeholderId);
    }
  }, [agentCanvasPickPendingList]);

  useEffect(() => {
    if (!nodeId) return;
    const sourceNode = nodes.find((n) => n.id === nodeId);
    const selection = (sourceNode?.data as Partial<ImageFlowNodeData> | undefined)?.pickState?.selection;
    if (!selection?.placeholderId || !selection.content) return;
    inputRef.current?.replaceCanvasPickChipById(
      selection.placeholderId,
      selection.content,
      selection.name ?? 'image',
      'image',
    );
    updateNode(nodeId, { data: { pickState: { selection: null } } }, { history: 'skip' });
  }, [nodeId, nodes, updateNode]);

  /** Mention pick flow: create an image editor edge from the picked node to this node. */
  useEffect(() => {
    if (!active || !nodeId) return;
    if (storedPickConsume !== 'quickEditMention' || agentCanvasPickPendingList.length === 0) return;

    for (const pending of agentCanvasPickPendingList) {
      if (processedMentionPickIdsRef.current.has(pending.placeholderId)) continue;
      processedMentionPickIdsRef.current.add(pending.placeholderId);

      onConnect({ source: pending.targetNodeId, target: nodeId, sourceHandle: null, targetHandle: null });

      const nextList = agentCanvasPickPendingList.filter((p) => p.placeholderId !== pending.placeholderId);
      updateNode(
        nodeId,
        { data: { pickState: { pendingList: nextList.length ? nextList : null } } },
        { history: 'skip' },
      );

      processedMentionPickIdsRef.current.delete(pending.placeholderId);
    }
  }, [active, nodeId, agentCanvasPickPendingList, storedPickConsume, updateNode, onConnect]);

  const handleRemoveUpstreamItem = useCallback(
    (itemId: string) => {
      // itemId format: 'upstream-{sourceNodeId}'
      const sourceNodeId = itemId.slice('upstream-'.length);
      const edgeToRemove = edges.find((e) => e.source === sourceNodeId && e.target === nodeId);
      if (!edgeToRemove) return;
      onEdgesChange([{ type: 'remove', id: edgeToRemove.id }]);
    },
    [edges, nodeId, onEdgesChange],
  );

  if (!active) return null;

  return (
    <div className='nodrag nopan pointer-events-auto flex w-[min(520px,92vw)] flex-col gap-2'>
      {topSlot}
      <div
        className='flex flex-col gap-2 overflow-hidden rounded-[16px] border border-[#DBDBDB] bg-background-default-base p-[10px] shadow-[0_1px_3px_rgba(0,0,0,0.08)]'
        onMouseDown={(e) => e.stopPropagation()}
        onPointerDown={(e) => e.stopPropagation()}
      >
        <div className='min-w-0'>
          <AgentComposerTabs
            upstreamItems={upstreamItems}
            uploadItems={uploadItems}
            onUpstreamItemClick={handleUpstreamItemClick}
            onRemoveUpstreamItem={handleRemoveUpstreamItem}
            onFilesSelected={handleComposerFiles}
            onRemoveUpload={handleRemoveUpload}
            onUploadItemClick={handleUploadItemClick}
            onLayoutClick={handleFocusEditorClick}
            onMentionClick={handleMentionClick}
            onTrailingClick={handleAddToInput}
            trailingActionsSlot={
              <Tooltip title='Exit quick edit' placement='top' offset={4} triggerClassName='self-start'>
                <button
                  type='button'
                  className={trailingSquareBtnClass}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                  }}
                  onClick={handleExitQuickEdit}
                  aria-label='Exit quick edit'
                >
                  <Icon name='imageEditor-multi-angle-close-icon' width={16} height={16} />
                </button>
              </Tooltip>
            }
            disabled={!active}
          />
        </div>

        <div className='flex h-[100px] flex-col overflow-hidden rounded-[8px] border border-[var(--color-border-default-base)] bg-background-default-base'>
          <AgentComposerInput
            ref={inputRef}
            canvasPickSourceId={nodeId}
            className='flex-1 !cursor-text'
            placeholder='Please describe the modifications you want here.'
            disabled={!active}
            onEnterSend={handleSendClick}
            onEmptyChange={setInputEmpty}
            onFocusChange={(focused) => {
              if (!focused || !nodeId) return;
              updateNode(nodeId, { data: { pickState: { composerFocused: true } } }, { history: 'skip' });
            }}
            upstreamItems={upstreamItems}
            uploadItems={uploadItems}
            onCanvasPickSurfaceRemoved={handleCanvasPickSurfaceRemoved}
          />
        </div>
        <div className='flex items-center justify-between gap-2'>
          <Button
            type='default'
            shape='round'
            disabled
            className={disabledLeftSlotClass}
            aria-label='Nano Banana Pro disabled'
          >
            <Icon
              name='imageEditor-nano-banana-pro-icon'
              width={16}
              height={17}
              color='var(--color-bg-icon-tertiary-hover)'
            />
            <span className='text-text-disabled-base'>Nano Banana Pro</span>
          </Button>
          <div className='flex items-center gap-2'>
            <div className='flex h-[28px] items-center gap-1 text-xs font-bold text-text-disabled-base'>
              <Icon name='imageEditor-nano-banana-credit-icon' width={18} height={18} />
              <span>120</span>
            </div>
            <Button
              type='primary'
              size='medium'
              shape='round'
              disabled={!active || inputEmpty}
              icon={<Icon name='project-chat-send-icon' width={18} height={16} color='#fff' />}
              onClick={handleSendClick}
              className='!h-[28px] w-[52px] shrink-0 !border-[#35C838] !bg-[#35C838] !py-[2px] !pl-[16px] !pr-[12px] hover:!border-[#35C838] hover:!bg-[#35C838] disabled:!border-[#CDCDCD] disabled:!bg-[#CDCDCD]'
              aria-label='Send quick edit'
            />
          </div>
        </div>
      </div>
    </div>
  );
};

export default QuickEditBottomToolbar;
