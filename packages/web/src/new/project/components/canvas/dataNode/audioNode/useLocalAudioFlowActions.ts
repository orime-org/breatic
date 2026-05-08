import { useCallback, type Dispatch, type SetStateAction } from 'react';
import { nanoid } from 'nanoid';
import { addEdge, type Edge, type Node } from '@xyflow/react';
import {
  createEditorAudioNodeData,
  imageEditorAudioNodeType,
  type LocalCanvasNodeData,
} from '@/new/project/types';
import { CANVAS_SPAWNED_OUTPUT_GAP_PX } from '../../canvasSpawnLayout';

const audioFlowHandleId = 'Audio_0_0';
const audioFlowDefaultWidth = 300;
const audioFlowDefaultHeight = 250;

function maxZIndex(nodes: Array<Node<LocalCanvasNodeData>>): number {
  return nodes.reduce((m, n) => Math.max(m, (n as Node & { zIndex?: number }).zIndex ?? 0), 0);
}

const defaultAudioHandles: LocalCanvasNodeData['handles'] = {
  target: [{ handleType: 'Audio', number: 0 }],
  source: [{ handleType: 'Audio', number: 0 }],
};

function mergeNode(
  prev: Node<LocalCanvasNodeData>,
  updates: Partial<Node<LocalCanvasNodeData>>,
): Node<LocalCanvasNodeData> {
  const next: Node<LocalCanvasNodeData> = { ...prev, ...updates };
  if (updates.position) {
    next.position = { ...prev.position, ...updates.position };
  }
  if (updates.style) {
    next.style = { ...(prev.style as object), ...(updates.style as object) };
  }
  if (updates.data) {
    next.data = { ...(prev.data ?? {}), ...(updates.data as object) } as LocalCanvasNodeData;
  }
  return next;
}

export type LocalAudioFlowActions = {
  removeNode: (nodeId: string) => void;
  updateNode: (nodeId: string, updates: Partial<Node<LocalCanvasNodeData>>, options?: { history?: 'skip' }) => void;
  updateNodeData: (nodeId: string, patch: Partial<LocalCanvasNodeData>, options?: { history?: 'skip' }) => void;
  createAudioPlaceholderNodeRight: (
    sourceNodeId: string,
    options?: { nameSuffix?: string; state?: 'idle' | 'localPending' },
  ) => string | null;
  resolveAudioResultNode: (nodeId: string, nextAudioSrc: string, options?: { state?: 'idle' | 'localPending' }) => void;
  /**
   * One `setNodes` — adds a `1004` tile to the right already holding `audioUrl` (no pending overlay).
   * Prefer this over placeholder + delayed resolve to avoid React 18 batching races with timers.
   */
  addResolvedAudioOutputRight: (sourceNodeId: string, audioUrl: string, nameSuffix: string) => string | null;
  createCutAudioResultNodesRight: (
    sourceNodeId: string,
    payload: { segments: Array<{ start: number; end: number }>; cutMarkers?: Array<{ id: string; progressPct: number }> },
    nextAudioSrc: string | string[],
    delayMs?: number,
  ) => void;
};

/**
 * Local canvas audio node spawn + resolve (mirrors {@link useLocalVideoFlowActions}).
 */
export function useLocalAudioFlowActions(
  getNodes: () => Node<LocalCanvasNodeData>[],
  setNodes: Dispatch<SetStateAction<Node<LocalCanvasNodeData>[]>>,
  setEdges: Dispatch<SetStateAction<Edge[]>>,
): LocalAudioFlowActions {
  const readAllNodesSnapshot = useCallback(() => getNodes(), [getNodes]);

  const appendSpawnEdge = useCallback(
    (sourceId: string, targetId: string) => {
      const edgeId = `e-${sourceId}-${audioFlowHandleId}-${targetId}-${audioFlowHandleId}`;
      setEdges((eds) => {
        if (eds.some((e) => e.id === edgeId)) return eds;
        return addEdge(
          {
            id: edgeId,
            source: sourceId,
            target: targetId,
            sourceHandle: audioFlowHandleId,
            targetHandle: audioFlowHandleId,
            type: 'default',
          },
          eds,
        );
      });
    },
    [setEdges],
  );

  const removeNode = useCallback(
    (nodeId: string) => {
      setNodes((nds) => nds.filter((n) => n.id !== nodeId));
      setEdges((eds) => eds.filter((e) => e.source !== nodeId && e.target !== nodeId));
    },
    [setEdges, setNodes],
  );

  const updateNode = useCallback(
    (nodeId: string, updates: Partial<Node<LocalCanvasNodeData>>, _options?: { history?: 'skip' }) => {
      setNodes((nds) => nds.map((n) => (n.id === nodeId ? mergeNode(n, updates) : n)));
    },
    [setNodes],
  );

  const updateNodeData = useCallback(
    (nodeId: string, patch: Partial<LocalCanvasNodeData>, _options?: { history?: 'skip' }) => {
      setNodes((nds) =>
        nds.map((n) => (n.id === nodeId ? { ...n, data: { ...(n.data ?? {}), ...patch } } : n)),
      );
    },
    [setNodes],
  );

  const createAudioPlaceholderNodeRight = useCallback(
    (sourceNodeId: string, options?: { nameSuffix?: string; state?: 'idle' | 'localPending' }): string | null => {
      const allNodes = readAllNodesSnapshot();
      const source = allNodes.find((n) => n.id === sourceNodeId);
      if (!source) return null;

      const prev = (source.data ?? {}) as LocalCanvasNodeData;
      const sourceName = typeof prev.name === 'string' && prev.name.trim() ? prev.name.trim() : 'Audio';
      const sourceStyle = (source.style ?? {}) as { width?: number; height?: number };
      const copyW = typeof sourceStyle.width === 'number' ? sourceStyle.width : audioFlowDefaultWidth;
      const copyH = typeof sourceStyle.height === 'number' ? sourceStyle.height : audioFlowDefaultHeight;
      const nodeId = `audio-flow-${nanoid(12)}`;
      const x = source.position.x + copyW + CANVAS_SPAWNED_OUTPUT_GAP_PX;
      const y = source.position.y;
      const nameSuffix = options?.nameSuffix?.trim() ? options.nameSuffix.trim() : 'copy';
      const state = options?.state ?? 'localPending';

      const node: Node<LocalCanvasNodeData> = {
        id: nodeId,
        type: imageEditorAudioNodeType,
        position: { x, y },
        style: { width: copyW, height: copyH },
        data: {
          ...createEditorAudioNodeData(`${sourceName} (${nameSuffix})`, ''),
          state: state === 'localPending' ? 'localPending' : 'idle',
          handles: prev.handles ?? defaultAudioHandles,
        },
      };

      if (state === 'localPending') {
        setNodes((nds) => {
          const top = maxZIndex(nds);
          const pushed: Node<LocalCanvasNodeData> = {
            ...node,
            zIndex: top + 1,
            selected: true,
            data: {
              ...node.data,
              state: 'localPending',
              url: '',
              content: '',
              localOutputPending: true,
            },
          };
          return [...nds.map((n) => ({ ...n, selected: false })), pushed];
        });
      } else {
        setNodes((nds) => {
          const top = maxZIndex(nds);
          return [...nds.map((n) => ({ ...n, selected: false })), { ...node, zIndex: top + 1, selected: true }];
        });
      }
      appendSpawnEdge(sourceNodeId, nodeId);
      return nodeId;
    },
    [appendSpawnEdge, readAllNodesSnapshot, setNodes],
  );

  const resolveAudioResultNode = useCallback(
    (nodeId: string, nextAudioSrc: string, options?: { state?: 'idle' | 'localPending' }) => {
      if (!nodeId || !nextAudioSrc) return;
      const nextState = options?.state ?? 'idle';
      setNodes((nds) => {
        const top = maxZIndex(nds);
        return nds.map((n) => {
          if (n.id !== nodeId) {
            return { ...n, selected: false };
          }
          return {
            ...n,
            zIndex: top + 1,
            selected: true,
            data: {
              ...(n.data ?? {}),
              url: nextAudioSrc,
              content: nextAudioSrc,
              state: nextState,
              errorInfo: undefined,
              localOutputPending: false,
              localOutputProgressPct: undefined,
            },
          };
        });
      });
    },
    [setNodes],
  );

  const addResolvedAudioOutputRight = useCallback(
    (sourceNodeId: string, audioUrl: string, nameSuffix: string): string | null => {
      const trimmed = audioUrl?.trim();
      if (!trimmed) return null;
      const allNodes = readAllNodesSnapshot();
      const source = allNodes.find((n) => n.id === sourceNodeId);
      if (!source) return null;

      const prev = (source.data ?? {}) as LocalCanvasNodeData;
      const sourceName = typeof prev.name === 'string' && prev.name.trim() ? prev.name.trim() : 'Audio';
      const sourceStyle = (source.style ?? {}) as { width?: number; height?: number };
      const copyW = typeof sourceStyle.width === 'number' ? sourceStyle.width : audioFlowDefaultWidth;
      const copyH = typeof sourceStyle.height === 'number' ? sourceStyle.height : audioFlowDefaultHeight;
      const nodeId = `audio-flow-${nanoid(12)}`;
      const x = source.position.x + copyW + CANVAS_SPAWNED_OUTPUT_GAP_PX;
      const y = source.position.y;
      const suffix = nameSuffix.trim() ? nameSuffix.trim() : 'copy';

      const node: Node<LocalCanvasNodeData> = {
        id: nodeId,
        type: imageEditorAudioNodeType,
        position: { x, y },
        style: { width: copyW, height: copyH },
        data: {
          ...createEditorAudioNodeData(`${sourceName} (${suffix})`, trimmed),
          state: 'idle',
          handles: prev.handles ?? defaultAudioHandles,
          localOutputPending: false,
          localOutputProgressPct: undefined,
          errorInfo: undefined,
        },
      };

      setNodes((nds) => {
        const top = maxZIndex(nds);
        return [...nds.map((n) => ({ ...n, selected: false })), { ...node, zIndex: top + 1, selected: true }];
      });
      appendSpawnEdge(sourceNodeId, nodeId);
      return nodeId;
    },
    [appendSpawnEdge, readAllNodesSnapshot, setNodes],
  );

  const createCutAudioResultNodesRight = useCallback(
    (
      sourceNodeId: string,
      payload: { segments: Array<{ start: number; end: number }>; cutMarkers?: Array<{ id: string; progressPct: number }> },
      nextAudioSrc: string | string[],
      delayMs: number = 1800,
    ) => {
      const allNodes = readAllNodesSnapshot();
      const source = allNodes.find((n) => n.id === sourceNodeId);
      const hasNextSrc = Array.isArray(nextAudioSrc) ? nextAudioSrc.some((src) => Boolean(src)) : Boolean(nextAudioSrc);
      if (!source || !hasNextSrc) return;

      const normalizedSegments = payload.segments
        .map((segment) => ({
          start: Number.isFinite(segment.start) ? Math.max(0, segment.start) : 0,
          end: Number.isFinite(segment.end) ? Math.max(0, segment.end) : 0,
        }))
        .filter((segment) => segment.end - segment.start > 1e-3);
      if (normalizedSegments.length === 0) return;

      const data = (source.data ?? {}) as LocalCanvasNodeData;
      const sourceName = typeof data?.name === 'string' && data.name.trim() ? data.name.trim() : 'Audio';
      const sourceStyle = (source.style ?? {}) as { width?: number; height?: number };
      const copyW = typeof sourceStyle.width === 'number' ? sourceStyle.width : audioFlowDefaultWidth;
      const copyH = typeof sourceStyle.height === 'number' ? sourceStyle.height : audioFlowDefaultHeight;
      const startX = source.position.x + copyW + CANVAS_SPAWNED_OUTPUT_GAP_PX;
      const startY = source.position.y;
      const resultIds: string[] = [];

      const pickClipSrc = (index: number): string => {
        if (Array.isArray(nextAudioSrc)) {
          return nextAudioSrc[index] ?? nextAudioSrc[nextAudioSrc.length - 1] ?? '';
        }
        return typeof nextAudioSrc === 'string' ? nextAudioSrc : '';
      };

      const resolveInline = delayMs <= 0;

      const buildClipNodeData = (
        clipIndex: number,
        segment: { start: number; end: number },
        segmentCount: number,
      ): LocalCanvasNodeData => {
        const src = pickClipSrc(clipIndex);
        const resolved = resolveInline && Boolean(src);
        return {
          ...createEditorAudioNodeData(`${sourceName} (clip ${clipIndex + 1})`, resolved ? src : ''),
          ...(resolved
            ? {
                url: src,
                content: src,
                state: 'idle' as const,
                errorInfo: undefined,
                localOutputPending: false,
                localOutputProgressPct: undefined,
              }
            : {
                url: '',
                content: '',
                state: 'localPending' as const,
                localOutputPending: true,
              }),
          handles: data.handles ?? defaultAudioHandles,
          nodeRuntimeData: {
            parameter: {
              cutMarkers: payload.cutMarkers ?? [],
              cutSegments: normalizedSegments,
              cutSegment: segment,
              cutSegmentIndex: clipIndex,
              cutSegmentCount: segmentCount,
              cutSourceNodeId: sourceNodeId,
            },
          },
        };
      };

      if (normalizedSegments.length === 1) {
        const onlySegment = normalizedSegments[0];
        const nodeId = `audio-flow-${nanoid(12)}`;
        resultIds.push(nodeId);
        setNodes((nds) => {
          const top = maxZIndex(nds);
          const pushed: Node<LocalCanvasNodeData> = {
            id: nodeId,
            type: imageEditorAudioNodeType,
            position: { x: startX, y: startY },
            style: { width: copyW, height: copyH },
            zIndex: top + 1,
            selected: true,
            data: buildClipNodeData(0, onlySegment, 1),
          };
          return [...nds.map((n) => ({ ...n, selected: false })), pushed];
        });
        appendSpawnEdge(sourceNodeId, nodeId);
      } else {
        const spacingY = 24;
        const groupPadding = 40;
        const minGroupGapX = CANVAS_SPAWNED_OUTPUT_GAP_PX;
        const groupWidth = copyW + groupPadding * 2;
        const contentHeight = normalizedSegments.length * copyH + (normalizedSegments.length - 1) * spacingY;
        const groupHeight = contentHeight + groupPadding * 2;
        const sourceCenterY = source.position.y + copyH / 2;
        const groupLeft = source.position.x + copyW + minGroupGapX;
        const groupTop = sourceCenterY - groupHeight / 2;
        const groupId = `group-${nanoid(8)}`;
        const groupNode: Node<LocalCanvasNodeData> = {
          id: groupId,
          type: 'group',
          position: { x: groupLeft, y: groupTop },
          style: { width: groupWidth, height: groupHeight },
          data: { collapsed: false, backgroundColor: 'rgba(12, 12, 13, 0.1)' } as LocalCanvasNodeData,
        };
        const clipNodes: Node<LocalCanvasNodeData>[] = normalizedSegments.map((segment, index) => {
          const nid = `audio-flow-${nanoid(12)}`;
          resultIds.push(nid);
          return {
            id: nid,
            type: imageEditorAudioNodeType,
            parentId: groupId,
            position: { x: groupPadding, y: groupPadding + index * (copyH + spacingY) },
            style: { width: copyW, height: copyH },
            data: buildClipNodeData(index, segment, normalizedSegments.length),
          };
        });
        setNodes((nds) => {
          const top = maxZIndex(nds);
          const groupZ = top + 1;
          const groupWithStack: Node<LocalCanvasNodeData> = {
            ...groupNode,
            zIndex: groupZ,
            selected: false,
          };
          const clipsWithStack = clipNodes.map((c, i) => ({
            ...c,
            zIndex: top + 2 + i,
            selected: true,
          }));
          return [...nds.map((n) => ({ ...n, selected: false })), groupWithStack, ...clipsWithStack];
        });
        resultIds.forEach((rid) => appendSpawnEdge(sourceNodeId, rid));
      }

      if (resolveInline) return;

      window.setTimeout(() => {
        setNodes((nds) => {
          const baseTop = maxZIndex(nds);
          let next = nds.map((n) => ({ ...n, selected: false }));
          resultIds.forEach((clipNodeId, index) => {
            const nextSrc = pickClipSrc(index);
            if (!nextSrc) return;
            next = next.map((n) => {
              if (n.id !== clipNodeId) return n;
              return {
                ...n,
                zIndex: baseTop + 1 + index,
                selected: true,
                data: {
                  ...(n.data ?? {}),
                  url: nextSrc,
                  content: nextSrc,
                  state: 'idle',
                  errorInfo: undefined,
                  localOutputPending: false,
                  localOutputProgressPct: undefined,
                },
              };
            });
          });
          return next;
        });
      }, delayMs);
    },
    [appendSpawnEdge, readAllNodesSnapshot, setNodes],
  );

  return {
    removeNode,
    updateNode,
    updateNodeData,
    createAudioPlaceholderNodeRight,
    resolveAudioResultNode,
    addResolvedAudioOutputRight,
    createCutAudioResultNodesRight,
  };
}
