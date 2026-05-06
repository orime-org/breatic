import { useCallback, type Dispatch, type SetStateAction } from 'react';
import { nanoid } from 'nanoid';
import { addEdge, type Edge, type Node } from '@xyflow/react';
import type { TaskEntity } from '@breatic/shared';
import { getTask } from '@/apis/canvas';
import { executeVideo } from '@/apis/miniTools';
import { message } from '@/components/base/message';
import {
  createEditorVideoNodeData,
  imageEditorVideoNodeType,
  type LocalCanvasNodeData,
} from '@/new/project/types';
import { CANVAS_SPAWNED_OUTPUT_GAP_PX } from '../../canvasSpawnLayout';

const videoFlowHandleId = 'Video_0_0';
const imageFlowDefaultWidth = 300;
const imageFlowDefaultHeight = 250;

const miniToolPollIntervalMs = 1500;
const miniToolMaxWaitMs = 240_000;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function unwrapMiniToolEnqueue(res: unknown): string | null {
  const r = res as { data?: { task_id?: string } };
  const id = r?.data?.task_id;
  return typeof id === 'string' && id.length > 0 ? id : null;
}

function unwrapTaskFetch(res: unknown): TaskEntity | null {
  if (res != null && typeof res === 'object' && 'data' in res) {
    const inner = (res as { data: TaskEntity }).data;
    if (inner && typeof inner === 'object' && 'status' in inner && 'id' in inner) return inner;
  }
  if (res != null && typeof res === 'object' && 'status' in res && 'id' in res) {
    return res as TaskEntity;
  }
  return null;
}

/**
 * Reads a playable video URL from a completed mini-tool task row.
 *
 * @param task - Task entity from `GET /tasks/:id`
 * @returns URL string or null
 */
function extractVideoUrlFromTask(task: TaskEntity): string | null {
  const direct = task.providerResultUrl?.trim();
  if (direct) return direct;
  const result = task.result;
  if (!result || typeof result !== 'object') return null;
  const outs = (result as { outputs?: Array<{ url?: string }> }).outputs;
  if (Array.isArray(outs)) {
    const u = outs[0]?.url;
    if (typeof u === 'string' && u.trim()) return u.trim();
  }
  const flat = (result as { url?: string }).url;
  return typeof flat === 'string' && flat.trim() ? flat.trim() : null;
}

function maxZIndex(nodes: Array<Node<LocalCanvasNodeData>>): number {
  return nodes.reduce((m, n) => Math.max(m, (n as Node & { zIndex?: number }).zIndex ?? 0), 0);
}

const defaultVideoHandles: LocalCanvasNodeData['handles'] = {
  target: [{ handleType: 'Video', number: 0 }],
  source: [{ handleType: 'Video', number: 0 }],
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

export type LocalVideoFlowActions = {
  removeNode: (nodeId: string) => void;
  updateNode: (nodeId: string, updates: Partial<Node<LocalCanvasNodeData>>, options?: { history?: 'skip' }) => void;
  updateNodeData: (nodeId: string, patch: Partial<LocalCanvasNodeData>, options?: { history?: 'skip' }) => void;
  createVideoPlaceholderNodeRight: (
    sourceNodeId: string,
    options?: { nameSuffix?: string; state?: 'idle' | 'localPending' },
  ) => string | null;
  resolveVideoResultNode: (nodeId: string, nextVideoSrc: string, options?: { state?: 'idle' | 'localPending' }) => void;
  createCutVideoResultNodesRight: (
    sourceNodeId: string,
    payload: { segments: Array<{ start: number; end: number }>; cutMarkers?: Array<{ id: string; progressPct: number }> },
    nextVideoSrc: string | string[],
    delayMs?: number,
  ) => void;
  triggerBackendMiniTool: (opts: {
    sourceNodeId: string;
    category: 'image' | 'video' | 'audio';
    toolName: string;
    nameSuffix: string;
    expectedSize?: { width: number; height: number };
    params: Record<string, unknown>;
  }) => Promise<string | null>;
  addNode: (node: Node<LocalCanvasNodeData>, options?: { select?: boolean; history?: 'skip' }) => void;
};

/**
 * React-Flow replacements for mixed-editor {@link useMixedEditorActions} video primitives
 * (local canvas has no Yjs / pendingTasks overlay).
 */
export function useLocalVideoFlowActions(
  getNodes: () => Node<LocalCanvasNodeData>[],
  setNodes: Dispatch<SetStateAction<Node<LocalCanvasNodeData>[]>>,
  setEdges: Dispatch<SetStateAction<Edge[]>>,
): LocalVideoFlowActions {
  const readAllNodesSnapshot = useCallback(() => getNodes(), [getNodes]);

  const appendSpawnEdge = useCallback(
    (sourceId: string, targetId: string) => {
      const edgeId = `e-${sourceId}-${videoFlowHandleId}-${targetId}-${videoFlowHandleId}`;
      setEdges((eds) => {
        if (eds.some((e) => e.id === edgeId)) return eds;
        return addEdge(
          {
            id: edgeId,
            source: sourceId,
            target: targetId,
            sourceHandle: videoFlowHandleId,
            targetHandle: videoFlowHandleId,
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

  const addNode = useCallback(
    (node: Node<LocalCanvasNodeData>, _options?: { select?: boolean; history?: 'skip' }) => {
      setNodes((nds) => [...nds, node]);
    },
    [setNodes],
  );

  const createVideoPlaceholderNodeRight = useCallback(
    (sourceNodeId: string, options?: { nameSuffix?: string; state?: 'idle' | 'localPending' }): string | null => {
      const allNodes = readAllNodesSnapshot();
      const source = allNodes.find((n) => n.id === sourceNodeId);
      if (!source) return null;

      const prev = (source.data ?? {}) as LocalCanvasNodeData;
      const sourceName = typeof prev.name === 'string' && prev.name.trim() ? prev.name.trim() : 'Video';
      const sourceStyle = (source.style ?? {}) as { width?: number; height?: number };
      const copyW = typeof sourceStyle.width === 'number' ? sourceStyle.width : imageFlowDefaultWidth;
      const copyH = typeof sourceStyle.height === 'number' ? sourceStyle.height : imageFlowDefaultHeight;
      const nodeId = `video-flow-${nanoid(12)}`;
      const x = source.position.x + copyW + CANVAS_SPAWNED_OUTPUT_GAP_PX;
      const y = source.position.y;
      const nameSuffix = options?.nameSuffix?.trim() ? options.nameSuffix.trim() : 'copy';
      const state = options?.state ?? 'localPending';

      const node: Node<LocalCanvasNodeData> = {
        id: nodeId,
        type: imageEditorVideoNodeType,
        position: { x, y },
        style: { width: copyW, height: copyH },
        data: {
          ...createEditorVideoNodeData(`${sourceName} (${nameSuffix})`, ''),
          state: state === 'localPending' ? 'localPending' : 'idle',
          handles: prev.handles ?? defaultVideoHandles,
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

  const resolveVideoResultNode = useCallback(
    (nodeId: string, nextVideoSrc: string, options?: { state?: 'idle' | 'localPending' }) => {
      if (!nodeId || !nextVideoSrc) return;
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
              url: nextVideoSrc,
              content: nextVideoSrc,
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

  const createCutVideoResultNodesRight = useCallback(
    (
      sourceNodeId: string,
      payload: { segments: Array<{ start: number; end: number }>; cutMarkers?: Array<{ id: string; progressPct: number }> },
      nextVideoSrc: string | string[],
      delayMs: number = 1800,
    ) => {
      const allNodes = readAllNodesSnapshot();
      const source = allNodes.find((n) => n.id === sourceNodeId);
      const hasNextVideoSrc = Array.isArray(nextVideoSrc) ? nextVideoSrc.some((src) => Boolean(src)) : Boolean(nextVideoSrc);
      if (!source || !hasNextVideoSrc) return;

      const normalizedSegments = payload.segments
        .map((segment) => ({
          start: Number.isFinite(segment.start) ? Math.max(0, segment.start) : 0,
          end: Number.isFinite(segment.end) ? Math.max(0, segment.end) : 0,
        }))
        .filter((segment) => segment.end - segment.start > 1e-3);
      if (normalizedSegments.length === 0) return;

      const data = (source.data ?? {}) as LocalCanvasNodeData;
      const sourceName = typeof data?.name === 'string' && data.name.trim() ? data.name.trim() : 'Video';
      const sourceStyle = (source.style ?? {}) as { width?: number; height?: number };
      const copyW = typeof sourceStyle.width === 'number' ? sourceStyle.width : imageFlowDefaultWidth;
      const copyH = typeof sourceStyle.height === 'number' ? sourceStyle.height : imageFlowDefaultHeight;
      const startX = source.position.x + copyW + CANVAS_SPAWNED_OUTPUT_GAP_PX;
      const startY = source.position.y;
      const resultIds: string[] = [];

      if (normalizedSegments.length === 1) {
        const onlySegment = normalizedSegments[0];
        const nodeId = `video-flow-${nanoid(12)}`;
        resultIds.push(nodeId);
        setNodes((nds) => {
          const top = maxZIndex(nds);
          const pushed: Node<LocalCanvasNodeData> = {
            id: nodeId,
            type: imageEditorVideoNodeType,
            position: { x: startX, y: startY },
            style: { width: copyW, height: copyH },
            zIndex: top + 1,
            selected: true,
            data: {
              ...createEditorVideoNodeData(`${sourceName} (clip 1)`, ''),
              state: 'localPending',
              url: '',
              content: '',
              localOutputPending: true,
              handles: data.handles ?? defaultVideoHandles,
              nodeRuntimeData: {
                parameter: {
                  cutMarkers: payload.cutMarkers ?? [],
                  cutSegments: normalizedSegments,
                  cutSegment: onlySegment,
                  cutSegmentIndex: 0,
                  cutSegmentCount: 1,
                  cutSourceNodeId: sourceNodeId,
                },
              },
            },
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
          const nodeId = `video-flow-${nanoid(12)}`;
          resultIds.push(nodeId);
          return {
            id: nodeId,
            type: imageEditorVideoNodeType,
            parentId: groupId,
            position: { x: groupPadding, y: groupPadding + index * (copyH + spacingY) },
            style: { width: copyW, height: copyH },
            data: {
              ...createEditorVideoNodeData(`${sourceName} (clip ${index + 1})`, ''),
              state: 'localPending',
              url: '',
              content: '',
              localOutputPending: true,
              handles: data.handles ?? defaultVideoHandles,
              nodeRuntimeData: {
                parameter: {
                  cutMarkers: payload.cutMarkers ?? [],
                  cutSegments: normalizedSegments,
                  cutSegment: segment,
                  cutSegmentIndex: index,
                  cutSegmentCount: normalizedSegments.length,
                  cutSourceNodeId: sourceNodeId,
                },
              },
            },
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

      window.setTimeout(() => {
        setNodes((nds) => {
          const baseTop = maxZIndex(nds);
          let next = nds.map((n) => ({ ...n, selected: false }));
          resultIds.forEach((nodeId, index) => {
            const nextSrc = Array.isArray(nextVideoSrc)
              ? nextVideoSrc[index] ?? nextVideoSrc[nextVideoSrc.length - 1] ?? ''
              : nextVideoSrc;
            if (!nextSrc) return;
            next = next.map((n) => {
              if (n.id !== nodeId) return n;
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

  const triggerBackendMiniTool = useCallback(
    async (opts: {
      sourceNodeId: string;
      category: 'image' | 'video' | 'audio';
      toolName: string;
      nameSuffix: string;
      expectedSize?: { width: number; height: number };
      params: Record<string, unknown>;
    }): Promise<string | null> => {
      const { sourceNodeId, category, toolName, nameSuffix, expectedSize, params: toolParams } = opts;

      const allNodes = readAllNodesSnapshot();
      const source = allNodes.find((n) => n.id === sourceNodeId);
      if (!source) return null;

      const sourceData = (source.data ?? {}) as LocalCanvasNodeData;
      const sourceName = typeof sourceData.name === 'string' && sourceData.name.trim() ? sourceData.name.trim() : category;
      const sourceStyle = (source.style ?? {}) as { width?: number; height?: number };
      const sizeW = expectedSize?.width ?? sourceStyle.width ?? imageFlowDefaultWidth;
      const sizeH = expectedSize?.height ?? sourceStyle.height ?? imageFlowDefaultHeight;

      const newNodeId = `video-flow-${nanoid(12)}`;
      const newX = source.position.x + sizeW + CANVAS_SPAWNED_OUTPUT_GAP_PX;
      const newY = source.position.y;

      const placeholder: Node<LocalCanvasNodeData> = {
        id: newNodeId,
        type: imageEditorVideoNodeType,
        position: { x: newX, y: newY },
        style: { width: sizeW, height: sizeH },
        data: {
          ...createEditorVideoNodeData(`${sourceName} (${nameSuffix})`, ''),
          state: 'handling',
          url: '',
          content: '',
          localOutputPending: true,
          localOutputProgressPct: 6,
          handles: sourceData.handles ?? defaultVideoHandles,
        },
      };

      setNodes((nds) => {
        const top = maxZIndex(nds);
        return [...nds.map((n) => ({ ...n, selected: false })), { ...placeholder, zIndex: top + 1, selected: true }];
      });
      appendSpawnEdge(sourceNodeId, newNodeId);

      const mergedParams = { ...toolParams } as Record<string, unknown>;
      const body: Record<string, unknown> = {
        ...mergedParams,
        tool: toolName,
        /** Worker + Collab use this; local canvas also resolves via `getTask` polling below. */
        node_ids: [newNodeId],
      };
      if (typeof mergedParams.history_item_id !== 'string' || !mergedParams.history_item_id) {
        body.history_item_id =
          typeof crypto !== 'undefined' && 'randomUUID' in crypto
            ? crypto.randomUUID()
            : '00000000-0000-4000-8000-000000000001';
      }

      try {
        if (category === 'video') {
          const enqueueRes = await executeVideo(body);
          const taskId = unwrapMiniToolEnqueue(enqueueRes);
          if (!taskId) {
            message.error('Mini-tool did not return a task id');
            removeNode(newNodeId);
            return null;
          }

          const pollStart = Date.now();
          while (Date.now() - pollStart < miniToolMaxWaitMs) {
            const elapsed = Date.now() - pollStart;
            const pct = Math.min(92, Math.round(5 + (elapsed / miniToolMaxWaitMs) * 87));
            updateNodeData(newNodeId, { localOutputProgressPct: pct }, { history: 'skip' });

            try {
              const raw = await getTask(taskId);
              const task = unwrapTaskFetch(raw);
              if (task) {
                if (task.status === 'completed') {
                  const outUrl = extractVideoUrlFromTask(task);
                  if (outUrl) {
                    resolveVideoResultNode(newNodeId, outUrl, { state: 'idle' });
                  } else {
                    updateNodeData(
                      newNodeId,
                      {
                        state: 'idle',
                        url: '',
                        content: '',
                        localOutputPending: false,
                        localOutputProgressPct: undefined,
                        errorInfo: 'Task finished but no video URL was returned',
                      },
                      { history: 'skip' },
                    );
                    message.error('Video mini-tool finished without a downloadable URL.');
                  }
                  return newNodeId;
                }
                if (task.status === 'failed' || task.status === 'cancelled') {
                  const err = task.errorMessage?.trim() || `Task ${task.status}`;
                  updateNodeData(
                    newNodeId,
                    {
                      state: 'idle',
                      url: '',
                      content: '',
                      errorInfo: err,
                      localOutputPending: false,
                      localOutputProgressPct: undefined,
                    },
                    { history: 'skip' },
                  );
                  message.error(err);
                  return newNodeId;
                }
              }
            } catch {
              // Transient GET errors — keep polling until timeout.
            }

            await sleep(miniToolPollIntervalMs);
          }

          updateNodeData(
            newNodeId,
            {
              state: 'idle',
              url: '',
              content: '',
              errorInfo: 'Timed out waiting for mini-tool result',
              localOutputPending: false,
              localOutputProgressPct: undefined,
            },
            { history: 'skip' },
          );
          message.error('Timed out waiting for video mini-tool result.');
          return newNodeId;
        }
        message.warning('Only video mini-tools are wired on the local canvas preview.');
        removeNode(newNodeId);
        return null;
      } catch (err) {
        const errorMessage =
          err instanceof Error ? err.message : typeof err === 'string' ? err : 'Mini-tool request failed';
        setNodes((nds) =>
          nds.map((n) => {
            if (n.id !== newNodeId) return n;
            return {
              ...n,
              data: {
                ...(n.data ?? {}),
                state: 'idle',
                url: '',
                content: '',
                errorInfo: errorMessage,
                localOutputPending: false,
                localOutputProgressPct: undefined,
              },
            };
          }),
        );
        message.error(errorMessage);
        return newNodeId;
      }
    },
    [appendSpawnEdge, readAllNodesSnapshot, removeNode, resolveVideoResultNode, setNodes, updateNodeData],
  );

  return {
    removeNode,
    updateNode,
    updateNodeData,
    createVideoPlaceholderNodeRight,
    resolveVideoResultNode,
    createCutVideoResultNodesRight,
    triggerBackendMiniTool,
    addNode,
  };
}
