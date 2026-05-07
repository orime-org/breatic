import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { nanoid } from 'nanoid';
import { cn } from '@/utils/classnames';
import AgentInput, {
  type AgentCanvasPickSurfaceRemovalDetail,
  type AgentComposerInputHandle,
} from '@/features/chat/components/AgentInput';
import AgentComposerTabs, {
  type AgentComposerUpstreamItem,
  type AgentComposerUploadItem,
} from '@/features/chat/components/AgentComposerTabs';
import AgentSendButton from '@/features/chat/components/AgentSendButton';
import { useCanvasData } from '@/contexts/CanvasDataContext';
import { useCanvasActions } from '@/hooks/useCanvasActions';
import { useCanvasUI } from '@/hooks/useCanvasUI';
import {
  useProjectWorkspaceRegion,
  type PickResultBox,
  type CanvasWorkflowNodeData,
} from '@/apps/project/components/canvas/types';
export type NodeChatComposerProps = {
  targetNodeId: string;
  onSend: (content: string, imageUrls?: string[]) => void;
  className?: string;
};
const defaultRecognizedLabel = '山脉';

const NodeChatComposer: React.FC<NodeChatComposerProps> = ({ targetNodeId, onSend, className }) => {
  const { nodes, edges } = useCanvasData();
  const { updateNode, onNodesChange, onEdgesChange, onConnect } = useCanvasActions();
  const { openRightPanel } = useCanvasUI();
  const workspaceRegion = useProjectWorkspaceRegion();
  const inputRef = useRef<AgentComposerInputHandle>(null);
  const [uploadItems, setUploadItems] = useState<AgentComposerUploadItem[]>([]);
  const uploadItemsRef = useRef<AgentComposerUploadItem[]>([]);
  uploadItemsRef.current = uploadItems;
  const [upstreamItems, setUpstreamItems] = useState<AgentComposerUpstreamItem[]>([]);
  const [inputEmpty, setInputEmpty] = useState(true);
  const [modelId, setModelId] = useState('gemini');
  const [quality, setQuality] = useState('2k');
  const [aspectRatio, setAspectRatio] = useState('3:2');
  const draftPersistTimerRef = useRef<number | null>(null);
  const lastHydratedDraftRef = useRef<string | null>(null);
  const lastLocalDraftRef = useRef<string>('');
  const processedPickIdsRef = useRef(new Set<string>());
  const processedMentionPickIdsRef = useRef(new Set<string>());

  const persistAttach = useCallback(
    (attach: AgentComposerUploadItem[]) => {
      updateNode(targetNodeId, { data: { attach } });
    },
    [targetNodeId, updateNode],
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
        setUploadItems((prev) => {
          const next = [...prev, ...mapped];
          persistAttach(next);
          return next;
        });
      })();
    },
    [mapFileToUploadItem, persistAttach],
  );

  const handleRemoveUpload = useCallback(
    (id: string) => {
      setUploadItems((prev) => {
        const hit = prev.find((u) => u.id === id);
        if (hit?.previewUrl?.startsWith('blob:')) URL.revokeObjectURL(hit.previewUrl);
        const next = prev.filter((u) => u.id !== id);
        persistAttach(next);
        return next;
      });
    },
    [persistAttach],
  );

  useEffect(
    () => () => {
      uploadItemsRef.current.forEach((u) => {
        if (u.previewUrl?.startsWith('blob:')) URL.revokeObjectURL(u.previewUrl);
      });
    },
    [],
  );

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

  const handleComposerWheelCapture = useCallback((e: React.WheelEvent<HTMLDivElement>) => {
    e.stopPropagation();
  }, []);

  const targetNode = nodes.find((n) => n.id === targetNodeId);
  const targetNodeData = targetNode?.data as Partial<CanvasWorkflowNodeData> | undefined;
  const pickCanvasData = targetNodeData?.pickState;
  const nodeAttach = targetNodeData?.attach;
  const nodePrompt = typeof targetNodeData?.prompt === 'string' ? targetNodeData.prompt : '';
  const nodeParams = (targetNodeData?.params ?? {}) as Record<string, unknown>;
  const storedPickConsume = pickCanvasData?.consumeFrom ?? 'nodeComposer';
  const agentCanvasPickPendingList = useMemo(() => pickCanvasData?.pendingList ?? [], [pickCanvasData?.pendingList]);

  const mergeNodeData = useCallback(
    (patch: { prompt?: string; params?: Record<string, unknown>; attach?: unknown }) => {
      const dataPatch: Record<string, unknown> = {};
      if (patch.prompt !== undefined) dataPatch.prompt = patch.prompt;
      if (patch.attach !== undefined) dataPatch.attach = patch.attach;
      if (patch.params) {
        const currentNode = nodes.find((n) => n.id === targetNodeId);
        const currentData = currentNode?.data as Partial<CanvasWorkflowNodeData> | undefined;
        const prevParams = (currentData?.params ?? {}) as Record<string, unknown>;
        dataPatch.params = { ...prevParams, ...patch.params };
      }
      updateNode(targetNodeId, { data: dataPatch });
    },
    [nodes, targetNodeId, updateNode],
  );

  useEffect(() => {
    if (!Array.isArray(nodeAttach)) {
      setUploadItems([]);
      return;
    }
    setUploadItems(nodeAttach as AgentComposerUploadItem[]);
  }, [targetNodeId, nodeAttach]);

  const handleSendClick = useCallback(() => {
    const input = inputRef.current;
    if (!input || input.isEmpty()) return;
    const content = input.getHtml();
    onSend(content);
    input.clear();
    mergeNodeData({ prompt: '' });
  }, [mergeNodeData, onSend]);

  useEffect(() => {
    setModelId(typeof nodeParams.model === 'string' ? nodeParams.model : 'gemini');
    setQuality(typeof nodeParams.resolution === 'string' ? nodeParams.resolution : '2k');
    setAspectRatio(typeof nodeParams.aspectRatio === 'string' ? nodeParams.aspectRatio : '3:2');
  }, [targetNodeId, nodeParams.model, nodeParams.resolution, nodeParams.aspectRatio]);

  useEffect(() => {
    const signature = `${targetNodeId}\0${nodePrompt}`;
    if (lastHydratedDraftRef.current === signature) return;
    if (lastLocalDraftRef.current === nodePrompt) {
      lastHydratedDraftRef.current = signature;
      return;
    }
    const currentHtml = inputRef.current?.getHtml() ?? '';
    if (currentHtml === nodePrompt) {
      lastHydratedDraftRef.current = signature;
      return;
    }
    lastHydratedDraftRef.current = signature;
    inputRef.current?.setHtml(nodePrompt);
  }, [targetNodeId, nodePrompt]);

  useEffect(() => {
    return () => {
      if (draftPersistTimerRef.current != null) {
        window.clearTimeout(draftPersistTimerRef.current);
      }
    };
  }, []);

  const persistDraftHtml = useCallback(
    (draftHtml: string) => {
      lastLocalDraftRef.current = draftHtml;
      if (draftPersistTimerRef.current != null) {
        window.clearTimeout(draftPersistTimerRef.current);
      }
      draftPersistTimerRef.current = window.setTimeout(() => {
        mergeNodeData({ prompt: draftHtml });
      }, 180);
    },
    [mergeNodeData],
  );

  const handleModelChange = useCallback(
    (id: string, _label: string) => {
      void _label;
      setModelId(id);
      mergeNodeData({ params: { model: id } });
    },
    [mergeNodeData],
  );

  const handleQualityChange = useCallback(
    (value: string) => {
      setQuality(value);
      mergeNodeData({ params: { resolution: value } });
    },
    [mergeNodeData],
  );

  const handleAspectChange = useCallback(
    (value: string) => {
      setAspectRatio(value);
      mergeNodeData({ params: { aspectRatio: value } });
    },
    [mergeNodeData],
  );

  useEffect(() => {
    if (!targetNodeId || storedPickConsume !== 'nodeComposer' || agentCanvasPickPendingList.length === 0) return;

    for (const pending of agentCanvasPickPendingList) {
      if (processedPickIdsRef.current.has(pending.placeholderId)) continue;
      processedPickIdsRef.current.add(pending.placeholderId);

      const { placeholderId, targetNodeId: pickedNodeId, content: pickedContent, name } = pending;
      const recognizedLabel = defaultRecognizedLabel || name;

      inputRef.current?.appendCanvasPickRecognizingPlaceholder(placeholderId);

      window.setTimeout(() => {
        const source = nodes.find((n) => n.id === targetNodeId);
        const sourcePs = (source?.data as Partial<CanvasWorkflowNodeData> | undefined)?.pickState;
        const currentList = sourcePs?.pendingList ?? [];
        if (!currentList.some((p) => p.placeholderId === placeholderId)) {
          processedPickIdsRef.current.delete(placeholderId);
          return;
        }

        inputRef.current?.replaceCanvasPickPlaceholderWithImageChip(placeholderId, pickedContent, recognizedLabel);
        const nextList = currentList.filter((p) => p.placeholderId !== placeholderId);
        updateNode(
          targetNodeId,
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
        const picked = nodes.find((n) => n.id === pickedNodeId);
        const prev = ((picked?.data as Partial<CanvasWorkflowNodeData> | undefined)?.pickState?.resultBoxes ??
          []) as PickResultBox[];
        const nextBox: PickResultBox = { cxPct, cyPct, wPct, hPct, placeholderId };
        nextBox.sourceNodeId = targetNodeId;
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

        processedPickIdsRef.current.delete(placeholderId);
      }, 3000);
    }
  }, [nodes, targetNodeId, agentCanvasPickPendingList, storedPickConsume, updateNode, inputRef]);

  useEffect(() => {
    const currentPendingIds = new Set(agentCanvasPickPendingList.map((p) => p.placeholderId));
    for (const placeholderId of Array.from(processedPickIdsRef.current)) {
      if (currentPendingIds.has(placeholderId)) continue;
      inputRef.current?.removeCanvasPickPlaceholder(placeholderId);
      processedPickIdsRef.current.delete(placeholderId);
    }
  }, [agentCanvasPickPendingList]);

  /** Mention pick flow: create a canvas edge from the picked node to this node. */
  useEffect(() => {
    if (!targetNodeId || storedPickConsume !== 'nodeComposerMention' || agentCanvasPickPendingList.length === 0) return;

    for (const pending of agentCanvasPickPendingList) {
      if (processedMentionPickIdsRef.current.has(pending.placeholderId)) continue;
      processedMentionPickIdsRef.current.add(pending.placeholderId);

      onConnect({ source: pending.targetNodeId, target: targetNodeId, sourceHandle: null, targetHandle: null });

      const nextList = agentCanvasPickPendingList.filter((p) => p.placeholderId !== pending.placeholderId);
      updateNode(
        targetNodeId,
        { data: { pickState: { pendingList: nextList.length ? nextList : null } } },
        { history: 'skip' },
      );

      processedMentionPickIdsRef.current.delete(pending.placeholderId);
    }
  }, [targetNodeId, agentCanvasPickPendingList, storedPickConsume, updateNode, onConnect]);

  const pickInject = pickCanvasData?.inject;
  const pickSelection = pickCanvasData?.selection;
  const lastProcessedInjectRef = useRef<string | null>(null);

  useEffect(() => {
    if (!pickInject?.content) {
      lastProcessedInjectRef.current = null;
      return;
    }
    const sig = `${pickInject.content}\0${pickInject.name}`;
    if (lastProcessedInjectRef.current === sig) return;
    lastProcessedInjectRef.current = sig;
    inputRef.current?.addResourceFromUrl(pickInject.content, pickInject.name, pickInject.type);
    updateNode(targetNodeId, { data: { pickState: { inject: null } } }, { history: 'skip' });
  }, [pickInject, targetNodeId, updateNode]);

  useEffect(() => {
    if (!pickSelection?.placeholderId || !pickSelection.content) return;
    inputRef.current?.replaceCanvasPickChipById(
      pickSelection.placeholderId,
      pickSelection.content,
      pickSelection.name ?? 'image',
      pickSelection.resourceType ?? 'image',
    );
    updateNode(targetNodeId, { data: { pickState: { selection: null } } }, { history: 'skip' });
  }, [pickSelection, targetNodeId, updateNode]);

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

  const handleAddToInput = useCallback(() => {
    // Canvas-native schema: node output URL is data.content directly.
    const { content, name: nodeName } = targetNodeData ?? {};
    if (!content) return;
    const name = nodeName ?? 'File';
    let type: 'image' | 'video' | 'audio' | 'text' = 'image';
    if (targetNode?.type === '1001') type = 'text';
    else if (targetNode?.type === '1003') type = 'audio';
    else if (targetNode?.type === '1004') type = 'video';
    inputRef.current?.addResourceFromUrl(content, name, type);
  }, [targetNode, targetNodeData]);

  const handleMentionClick = useCallback(() => {
    inputRef.current?.focusEditor();
    if (workspaceRegion !== 'canvas') {
      openRightPanel('editor', targetNodeId, undefined, true);
    }
    for (const n of nodes) {
      const ps = (n.data as Partial<CanvasWorkflowNodeData> | undefined)?.pickState;
      if (ps?.fromCanvas && n.id !== targetNodeId) {
        updateNode(n.id, { data: { pickState: null } }, { history: 'skip' });
      }
    }
    onNodesChange(
      nodes.map((n) => ({ type: 'select' as const, id: n.id, selected: n.id === targetNodeId })),
      { history: 'skip' },
    );
    updateNode(
      targetNodeId,
      {
        selected: true,
        data: {
          pickState: {
            fromCanvas: true,
            composerFocused: true,
            pendingList: null,
            consumeFrom: 'nodeComposerMention',
          },
        },
      },
      { history: 'skip' },
    );
  }, [nodes, onNodesChange, openRightPanel, targetNodeId, updateNode, workspaceRegion]);

  const handleAgentLayoutPickClick = useCallback(() => {
    // Ensure the composer has a caret before enabling pick mode.
    inputRef.current?.focusEditor();
    if (workspaceRegion !== 'canvas') {
      openRightPanel('editor', targetNodeId, undefined, true);
    }
    for (const n of nodes) {
      const ps = (n.data as Partial<CanvasWorkflowNodeData> | undefined)?.pickState;
      if (ps?.fromCanvas && n.id !== targetNodeId) {
        updateNode(n.id, { data: { pickState: null } }, { history: 'skip' });
      }
    }
    onNodesChange(
      nodes.map((n) => ({ type: 'select' as const, id: n.id, selected: n.id === targetNodeId })),
      { history: 'skip' },
    );
    updateNode(
      targetNodeId,
      {
        selected: true,
        data: {
          pickState: {
            fromCanvas: true,
            composerFocused: true,
            pendingList: null,
            consumeFrom: 'nodeComposer',
          },
        },
      },
      { history: 'skip' },
    );
  }, [nodes, onNodesChange, openRightPanel, targetNodeId, updateNode, workspaceRegion]);

  const handleRemoveUpstreamItem = useCallback(
    (itemId: string) => {
      const sourceNodeId = itemId.startsWith('upstream-')
        ? itemId.slice('upstream-'.length)
        : itemId.replace(/-(image|video|audio|text|file)$/, '');
      const edgeToRemove = edges.find((e) => e.source === sourceNodeId && e.target === targetNodeId);
      if (!edgeToRemove) return;
      onEdgesChange([{ type: 'remove', id: edgeToRemove.id }]);
    },
    [edges, targetNodeId, onEdgesChange],
  );

  return (
    <div className={cn('cursor-default', className)} onWheelCapture={handleComposerWheelCapture}>
      <div className='cursor-default rounded-[16px] border border-[var(--color-border-default-base)] bg-background-default-base p-[10px]'>
        <AgentComposerTabs
          className='mb-2'
          upstreamTargetNodeId={targetNodeId}
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
          onTrailingClick={handleAddToInput}
        />
        <AgentInput
          ref={inputRef}
          canvasPickSourceId={targetNodeId}
          placeholder={'Use "/" to activate skills.\nUse "@" to add resources to the dialogue.'}
          onEnterSend={handleSendClick}
          onEmptyChange={setInputEmpty}
          onFocusChange={(focused) => {
            if (!focused) return;
            updateNode(targetNodeId, { data: { pickState: { composerFocused: true } } }, { history: 'skip' });
          }}
          upstreamItems={upstreamItems}
          uploadItems={uploadItems}
          onHtmlChange={persistDraftHtml}
          onCanvasPickSurfaceRemoved={handleCanvasPickSurfaceRemoved}
          className='mb-[8px] h-[84px] rounded-[8px] border border-[var(--color-border-default-base)] break-words whitespace-pre-wrap'
        />
        <AgentSendButton
          disabled={inputEmpty}
          onClick={handleSendClick}
          modelValue={modelId}
          qualityValue={quality}
          aspectValue={aspectRatio}
          onModelChange={handleModelChange}
          onQualityChange={handleQualityChange}
          onAspectChange={handleAspectChange}
        />
      </div>
    </div>
  );
};

export default NodeChatComposer;
