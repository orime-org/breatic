/**
 * Mixed editor write actions + handling lifecycle + heartbeat.
 *
 * Mirrors the main canvas' {@link useCanvasActions} pattern:
 *   - All writes go directly to Yjs (`doc.transact(fn, origin)`)
 *   - Origin controls the undo stack (`userOrigin` tracked,
 *     `noHistoryOrigin` not tracked)
 *   - Undo manager is attached lazily after Hocuspocus syncs so the
 *     initial-state replay never lands in the stack
 *
 * Extra responsibilities unique to the mixed editor:
 *   - **Handling lifecycle** — loading nodes are created via
 *     `noHistoryOrigin` so Ctrl+Z never ends up deleting a node with
 *     a live task; their "finalization" (loading → final) lands in
 *     the stack as a single undoable step
 *   - **Heartbeat** — handling nodes carry a 30 s heartbeat updated
 *     on `data.handlingBy.heartbeatAt`. Peers treat a node stale
 *     when the heartbeat is older than 90 s (see PR-2 Phase E UI).
 *     The heartbeat tick itself uses `noHistoryOrigin`.
 *
 * The hook requires a {@link YjsNodeEditorManager} — caller plumbs it
 * in from `useYjsNodeEditor`. Unlike the main canvas we do not read
 * from the global ref here because the mixed editor is per-node and
 * swapping nodes must rebuild the undo manager scope cleanly.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import * as Y from 'yjs';
import { nanoid } from 'nanoid';
import type { Connection, Edge, EdgeChange, Node, NodeChange } from '@xyflow/react';
import type { RootState } from '@/store';
import { useMixedEditorDataInternal } from '@/contexts/MixedEditorDataContext';
import { message } from '@/components/base/message';
import { getImageMeta, getVideoMeta } from '@/utils/mediaUtils';
import {
  clearMixedEditorExpandLock,
  pruneMixedEditorExpandLocks,
  setMixedEditorActiveTool,
} from '@/store/modules/mixedEditor';
import type {
  EditorTool,
  ImageEditorNodeDataPatch,
  ImageFlowNodeData,
} from '@/apps/project/components/mixedEditor/types';
import {
  createEditorAudioNodeData,
  createEditorImageNodeData,
  createEditorVideoNodeData,
  imageEditorAudioNodeType,
  imageEditorImageNodeType,
  imageEditorVideoNodeType,
} from '@/apps/project/components/mixedEditor/types';

// ── Origins ────────────────────────────────────────────────────
//
// Symbols are opaque (not serialisable, not leaked across iframes) which
// is what we want for the UndoManager's trackedOrigins to never
// accidentally match remote updates.

const noHistoryOrigin = Symbol('mixed-no-history');

/** Per-user origin so collaborators never undo each other's ops. */
function userOriginFor(userId: string): string {
  return `mixed-user:${userId || 'anon'}`;
}

type HistoryOptions = { history?: 'default' | 'skip' };

// ── Constants ──────────────────────────────────────────────────

const UNDO_STACK_MAX = 50;
const HEARTBEAT_INTERVAL_MS = 30_000;

const imageFlowDefaultWidth = 260;
const imageFlowDefaultHeight = 160;
const audioFlowDefaultWidth = 300;
const audioFlowDefaultHeight = 250;
const uploadGap = 30;
const flowTopOffset = 10;

// ── Small helpers ──────────────────────────────────────────────

function calcNodeSizeFromImage(naturalWidth?: number | null, naturalHeight?: number | null) {
  const w = naturalWidth ?? 0;
  const h = naturalHeight ?? 0;
  if (w <= 0 || h <= 0) {
    return { width: imageFlowDefaultWidth, height: imageFlowDefaultHeight };
  }
  const isLandscape = w >= h;
  if (isLandscape) {
    const height = Math.max(Math.round(imageFlowDefaultWidth * (h / w)), imageFlowDefaultHeight);
    const width = Math.round(height * (w / h));
    return { width, height };
  }
  return {
    width: imageFlowDefaultWidth,
    height: Math.round(imageFlowDefaultWidth * (h / w)),
  };
}

function nodeSizeFromResultOrFallback(
  resultImageSize: { width: number; height: number } | undefined,
  fallbackWidth: number,
  fallbackHeight: number,
): { width: number; height: number } {
  if (resultImageSize != null) {
    return calcNodeSizeFromImage(resultImageSize.width, resultImageSize.height);
  }
  return { width: fallbackWidth, height: fallbackHeight };
}

function getNextStackY(nodes: Node[]): number {
  if (!nodes.length) return flowTopOffset;
  let maxBottom = 0;
  for (const n of nodes) {
    const st = (n.style ?? {}) as { height?: number };
    const h = typeof st.height === 'number' ? st.height : imageFlowDefaultHeight;
    const bottom = n.position.y + h;
    if (bottom > maxBottom) maxBottom = bottom;
  }
  return maxBottom + uploadGap;
}

function inheritParentFieldsFromNode(source: Node): Pick<Partial<Node>, 'parentId' | 'extent'> {
  const out: Pick<Partial<Node>, 'parentId' | 'extent'> = {};
  if (source.parentId == null) return out;
  out.parentId = source.parentId;
  if (source.extent !== undefined) out.extent = source.extent;
  return out;
}

// ── Yjs write helpers ──────────────────────────────────────────

/** Build a node Y.Map from a ReactFlow `Node`. Used by addNode and setNodes. */
function buildNodeYMap(node: Node): Y.Map<unknown> {
  const nodeMap = new Y.Map();
  nodeMap.set('id', node.id);
  nodeMap.set('type', node.type ?? '2002');

  const pos = new Y.Map();
  pos.set('x', node.position?.x ?? 0);
  pos.set('y', node.position?.y ?? 0);
  nodeMap.set('position', pos);

  const style = (node.style ?? {}) as { width?: number; height?: number };
  const styleMap = new Y.Map();
  if (typeof style.width === 'number') styleMap.set('width', style.width);
  if (typeof style.height === 'number') styleMap.set('height', style.height);
  nodeMap.set('style', styleMap);

  const zIndex = (node as Node & { zIndex?: number }).zIndex;
  if (typeof zIndex === 'number') nodeMap.set('zIndex', zIndex);
  if (node.parentId) nodeMap.set('parentId', node.parentId);
  if (node.extent !== undefined) nodeMap.set('extent', node.extent as unknown);

  const dataMap = new Y.Map();
  const data = (node.data ?? {}) as Record<string, unknown>;
  for (const [key, val] of Object.entries(data)) {
    // pickState is UI-only, never persist to Yjs.
    if (key === 'pickState') continue;
    dataMap.set(key, val as unknown);
  }
  nodeMap.set('data', dataMap);

  return nodeMap;
}

function getNodeDataMap(flow: Y.Map<unknown>, nodeId: string): Y.Map<unknown> | null {
  const nodeMap = flow.get(nodeId);
  if (!(nodeMap instanceof Y.Map)) return null;
  const dataMap = nodeMap.get('data');
  return dataMap instanceof Y.Map ? (dataMap as Y.Map<unknown>) : null;
}

function isHandlingState(state: unknown): boolean {
  // Accept both the canonical 'handling' and the legacy 'generating' the
  // video sub-flow produced historically — treat as synonyms until
  // callers are migrated.
  return state === 'handling' || state === 'generating';
}

// ── Hook input/output ──────────────────────────────────────────

export interface UseMixedEditorActionsResult {
  // ── Low-level primitives ──
  addNode: (node: Node, options?: HistoryOptions & { select?: boolean }) => void;
  addNodes: (nodes: Node[], options?: HistoryOptions) => void;
  updateNode: (nodeId: string, updates: Partial<Node>, options?: HistoryOptions) => void;
  updateNodeData: (nodeId: string, patch: ImageEditorNodeDataPatch, options?: HistoryOptions) => void;
  setNodeDraggable: (nodeId: string, draggable: boolean) => void;
  removeNode: (nodeId: string) => void;
  setNodes: (nodes: Node[], options?: HistoryOptions) => void;
  onNodesChange: (changes: NodeChange[], options?: HistoryOptions) => void;
  onEdgesChange: (changes: EdgeChange[]) => void;
  onConnect: (connection: Connection) => void;

  // ── Handling lifecycle ──
  addHandlingNode: (node: Node) => string;
  resolveHandlingNode: (nodeId: string, patch: ImageEditorNodeDataPatch) => void;
  failHandlingNode: (nodeId: string) => void;
  /** Remove a handling node whose heartbeat is stuck (called by the cleanup UI). */
  forceRemoveStaleHandlingNode: (nodeId: string) => void;

  // ── High-level convenience ──
  onCropNode: (nodeId: string) => void;
  replaceNodeWithFile: (nodeId: string, file: File) => Promise<void>;
  copyNodeImageSrc: (nodeId: string) => void;
  createNewNodeBelow: (nodeId: string) => void;
  createInpaintResultNodeRight: (
    sourceNodeId: string,
    nextImageSrc: string,
    delayMs?: number,
    resultImageSize?: { width: number; height: number },
  ) => void;
  createInpaintResultNodesRight: (
    sourceNodeId: string,
    nextImageSrc: string,
    count: number,
    delayMs?: number,
    resultImageSize?: { width: number; height: number },
  ) => void;
  createEnhanceResultNodesRight: (
    sourceNodeId: string,
    results: Array<{ row: number; col: number; src: string; width: number; height: number }>,
    delayMs?: number,
  ) => void;
  createVideoPlaceholderNodeRight: (
    sourceNodeId: string,
    options?: { nameSuffix?: string; state?: 'idle' | 'generating' },
  ) => string | null;
  resolveVideoResultNode: (
    nodeId: string,
    nextVideoSrc: string,
    options?: { state?: 'idle' | 'generating' },
  ) => void;
  createVideoResultNodeRight: (sourceNodeId: string, nextVideoSrc: string, delayMs?: number) => void;
  createCutVideoResultNodesRight: (
    sourceNodeId: string,
    payload: { segments: Array<{ start: number; end: number }>; cutMarkers?: Array<{ id: string; progressPct: number }> },
    nextVideoSrc: string | string[],
    delayMs?: number,
  ) => void;
  importImagesFromFiles: (files: File[], options?: { viewportCenterFlow: { x: number; y: number } }) => Promise<void>;
  importVideosFromFiles: (files: File[], options?: { viewportCenterFlow: { x: number; y: number } }) => Promise<void>;
  importAudiosFromFiles: (files: File[], options?: { viewportCenterFlow: { x: number; y: number } }) => Promise<void>;

  // ── Apply to this node (mixed → main canvas) ──
  applyToMainCanvasNode: (mainCanvasNodeId: string, sourceInnerNodeId: string) => void;

  // ── Undo / redo ──
  undo: () => boolean;
  redo: () => boolean;
  canUndo: boolean;
  canRedo: boolean;
}

export function useMixedEditorActions(): UseMixedEditorActionsResult {
  const dispatch = useDispatch();
  const { manager, setNodeLocalData, clearNodeLocalState } = useMixedEditorDataInternal();
  const userInfo = useSelector((s: RootState) => s.userCenter.userInfo);
  const userId = (userInfo as { id?: string } | undefined)?.id ?? '';
  const username = (userInfo as { name?: string } | undefined)?.name ?? '';

  const userOrigin = userOriginFor(userId);

  // UndoManager is attached lazily after sync; undoManagerRef is the
  // stable handle that all action callbacks close over.
  const undoManagerRef = useRef<Y.UndoManager | null>(null);
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);

  // Heartbeat timers keyed by nodeId. Each tick rewrites
  // `handlingBy.heartbeatAt` under noHistoryOrigin so it never pollutes
  // the undo stack.
  const heartbeatsRef = useRef<Map<string, ReturnType<typeof setInterval>>>(new Map());

  const stopHeartbeat = useCallback((nodeId: string) => {
    const interval = heartbeatsRef.current.get(nodeId);
    if (interval) {
      clearInterval(interval);
      heartbeatsRef.current.delete(nodeId);
    }
  }, []);

  const startHeartbeat = useCallback(
    (nodeId: string) => {
      if (!manager) return;
      if (heartbeatsRef.current.has(nodeId)) return;

      const tick = () => {
        const flow = manager.doc.getMap('flow') as Y.Map<unknown>;
        const nodeMap = flow.get(nodeId);
        if (!(nodeMap instanceof Y.Map)) {
          stopHeartbeat(nodeId);
          return;
        }
        const dataMap = nodeMap.get('data');
        if (!(dataMap instanceof Y.Map)) {
          stopHeartbeat(nodeId);
          return;
        }
        if (!isHandlingState(dataMap.get('state'))) {
          stopHeartbeat(nodeId);
          return;
        }
        manager.doc.transact(() => {
          let handlingBy = dataMap.get('handlingBy');
          if (!(handlingBy instanceof Y.Map)) {
            handlingBy = new Y.Map();
            (handlingBy as Y.Map<unknown>).set('userId', userId);
            (handlingBy as Y.Map<unknown>).set('username', username);
            dataMap.set('handlingBy', handlingBy);
          }
          (handlingBy as Y.Map<unknown>).set('heartbeatAt', Date.now());
        }, noHistoryOrigin);
      };
      tick(); // initial beat
      const interval = setInterval(tick, HEARTBEAT_INTERVAL_MS);
      heartbeatsRef.current.set(nodeId, interval);
    },
    [manager, stopHeartbeat, userId, username],
  );

  // Clean up all heartbeats when the manager changes or the hook unmounts.
  useEffect(() => {
    return () => {
      heartbeatsRef.current.forEach((interval) => clearInterval(interval));
      heartbeatsRef.current.clear();
    };
  }, [manager]);

  // Attach UndoManager after sync; per-user trackedOrigins filter out
  // remote + noHistoryOrigin ops. 500 ms captureTimeout merges
  // consecutive drags / nudges into a single undo step.
  useEffect(() => {
    if (!manager) {
      undoManagerRef.current = null;
      setCanUndo(false);
      setCanRedo(false);
      return;
    }

    let destroyed = false;
    let um: Y.UndoManager | null = null;
    let onStackChange: (() => void) | null = null;

    const unsubSynced = manager.onSynced(() => {
      if (destroyed) return;
      const flow = manager.doc.getMap('flow') as Y.Map<unknown>;
      um = new Y.UndoManager(flow, {
        trackedOrigins: new Set([userOrigin]),
        captureTimeout: 500,
      });
      const currentUm = um; // non-null in closure
      currentUm.on('stack-item-added', () => {
        while (currentUm.undoStack.length > UNDO_STACK_MAX) {
          currentUm.undoStack.shift();
        }
      });
      currentUm.clear(); // don't let initial sync load into the stack

      onStackChange = () => {
        setCanUndo(currentUm.undoStack.length > 0);
        setCanRedo(currentUm.redoStack.length > 0);
      };
      currentUm.on('stack-item-added', onStackChange);
      currentUm.on('stack-item-popped', onStackChange);
      onStackChange();

      undoManagerRef.current = currentUm;
    });

    return () => {
      destroyed = true;
      unsubSynced();
      if (um && onStackChange) {
        um.off('stack-item-added', onStackChange);
        um.off('stack-item-popped', onStackChange);
      }
      undoManagerRef.current = null;
      setCanUndo(false);
      setCanRedo(false);
    };
  }, [manager, userOrigin]);

  // ── Low-level primitives ──────────────────────────────────────

  const withFlow = useCallback(
    <R,>(fn: (flow: Y.Map<unknown>, doc: Y.Doc) => R): R | null => {
      if (!manager) return null;
      const flow = manager.doc.getMap('flow') as Y.Map<unknown>;
      return fn(flow, manager.doc);
    },
    [manager],
  );

  const addNode = useCallback(
    (node: Node, options?: HistoryOptions & { select?: boolean }) => {
      const origin = options?.history === 'skip' ? noHistoryOrigin : userOrigin;
      withFlow((flow, doc) => {
        doc.transact(() => {
          flow.set(node.id, buildNodeYMap(node));
        }, origin);
      });
    },
    [withFlow, userOrigin],
  );

  const addNodes = useCallback(
    (nodes: Node[], options?: HistoryOptions) => {
      const origin = options?.history === 'skip' ? noHistoryOrigin : userOrigin;
      withFlow((flow, doc) => {
        doc.transact(() => {
          for (const node of nodes) flow.set(node.id, buildNodeYMap(node));
        }, origin);
      });
    },
    [withFlow, userOrigin],
  );

  const updateNode = useCallback(
    (nodeId: string, updates: Partial<Node>, options?: HistoryOptions) => {
      const origin = options?.history === 'skip' ? noHistoryOrigin : userOrigin;

      // pickState is UI-only → route to local overlay instead of Yjs.
      const dataObj = (updates.data ?? {}) as Record<string, unknown>;
      if ('pickState' in dataObj) {
        setNodeLocalData(nodeId, { pickState: dataObj.pickState });
      }

      withFlow((flow, doc) => {
        const nodeMap = flow.get(nodeId);
        if (!(nodeMap instanceof Y.Map)) return;

        doc.transact(() => {
          if (updates.position) {
            let pos = nodeMap.get('position');
            if (!(pos instanceof Y.Map)) {
              pos = new Y.Map();
              nodeMap.set('position', pos);
            }
            if (updates.position.x !== undefined) (pos as Y.Map<unknown>).set('x', updates.position.x);
            if (updates.position.y !== undefined) (pos as Y.Map<unknown>).set('y', updates.position.y);
          }

          if (updates.style !== undefined) {
            let style = nodeMap.get('style');
            if (!(style instanceof Y.Map)) {
              style = new Y.Map();
              nodeMap.set('style', style);
            }
            const styleObj = updates.style as Record<string, unknown>;
            for (const [k, v] of Object.entries(styleObj)) {
              (style as Y.Map<unknown>).set(k, v);
            }
          }

          if (updates.data !== undefined) {
            let dataMap = nodeMap.get('data');
            if (!(dataMap instanceof Y.Map)) {
              dataMap = new Y.Map();
              nodeMap.set('data', dataMap);
            }
            for (const [k, v] of Object.entries(dataObj)) {
              if (k === 'pickState') continue; // already routed to overlay above
              (dataMap as Y.Map<unknown>).set(k, v);
            }
          }

          if (updates.parentId !== undefined) {
            if (updates.parentId === null) nodeMap.delete('parentId');
            else nodeMap.set('parentId', updates.parentId);
          }
          if (updates.extent !== undefined) {
            nodeMap.set('extent', updates.extent as unknown);
          }
          if (updates.draggable !== undefined) {
            nodeMap.set('draggable', updates.draggable);
          }
          // `selected` is UI-only — callers should drive it through
          // `applyLocalNodeChanges` from `useMixedEditorData`.
        }, origin);
      });
    },
    [withFlow, userOrigin, setNodeLocalData],
  );

  const updateNodeData = useCallback(
    (nodeId: string, patch: ImageEditorNodeDataPatch, options?: HistoryOptions) => {
      const origin = options?.history === 'skip' ? noHistoryOrigin : userOrigin;
      const patchObj = patch as Record<string, unknown>;

      // pickState → overlay, not Yjs.
      if ('pickState' in patchObj) {
        setNodeLocalData(nodeId, { pickState: patchObj.pickState });
      }

      withFlow((flow, doc) => {
        const dataMap = getNodeDataMap(flow, nodeId);
        if (!dataMap) return;
        doc.transact(() => {
          for (const [k, v] of Object.entries(patchObj)) {
            if (k === 'pickState') continue;
            dataMap.set(k, v as unknown);
          }
        }, origin);
      });
    },
    [withFlow, userOrigin, setNodeLocalData],
  );

  const setNodeDraggable = useCallback(
    (nodeId: string, draggable: boolean) => {
      updateNode(nodeId, { draggable }, { history: 'skip' });
    },
    [updateNode],
  );

  const removeNode = useCallback(
    (nodeId: string) => {
      withFlow((flow, doc) => {
        const nodeMap = flow.get(nodeId);
        if (!(nodeMap instanceof Y.Map)) return;
        const dataMap = nodeMap.get('data');
        if (dataMap instanceof Y.Map && isHandlingState(dataMap.get('state'))) {
          // Handling guard: never delete a node with a live task. Peers
          // (and the originator via undo, though the initial creation
          // was non-tracked anyway) must use forceRemoveStaleHandlingNode
          // through the stuck-cleanup UI instead.
          return;
        }
        doc.transact(() => {
          flow.delete(nodeId);
        }, userOrigin);
      });
      stopHeartbeat(nodeId);
      clearNodeLocalState(nodeId);
      dispatch(clearMixedEditorExpandLock(nodeId));
    },
    [withFlow, userOrigin, dispatch, stopHeartbeat, clearNodeLocalState],
  );

  const setNodes = useCallback(
    (next: Node[], options?: HistoryOptions) => {
      const origin = options?.history === 'skip' ? noHistoryOrigin : userOrigin;
      withFlow((flow, doc) => {
        doc.transact(() => {
          flow.forEach((_v, key) => flow.delete(key));
          for (const node of next) flow.set(node.id, buildNodeYMap(node));
        }, origin);
      });
      dispatch(pruneMixedEditorExpandLocks(next.map((n) => n.id)));
    },
    [withFlow, userOrigin, dispatch],
  );

  const onNodesChange = useCallback(
    (changes: NodeChange[], options?: HistoryOptions) => {
      const origin = options?.history === 'skip' ? noHistoryOrigin : userOrigin;
      withFlow((flow, doc) => {
        doc.transact(() => {
          for (const change of changes) {
            if (change.type === 'position' && change.position) {
              const nodeMap = flow.get(change.id);
              if (!(nodeMap instanceof Y.Map)) continue;
              let pos = nodeMap.get('position');
              if (!(pos instanceof Y.Map)) {
                pos = new Y.Map();
                nodeMap.set('position', pos);
              }
              (pos as Y.Map<unknown>).set('x', change.position.x);
              (pos as Y.Map<unknown>).set('y', change.position.y);
            } else if (change.type === 'remove') {
              const nodeMap = flow.get(change.id);
              if (!(nodeMap instanceof Y.Map)) continue;
              const dataMap = nodeMap.get('data');
              if (dataMap instanceof Y.Map && isHandlingState(dataMap.get('state'))) {
                // Handling guard at the ReactFlow boundary too.
                continue;
              }
              flow.delete(change.id);
              dispatch(clearMixedEditorExpandLock(change.id));
            }
            // 'select', 'dimensions', 'reset' — handled by local overlay
          }
        }, origin);
      });
    },
    [withFlow, userOrigin, dispatch],
  );

  // Mixed editor has no edges — these two are retained for API parity
  // with the ReactFlow props but do nothing.
  const onEdgesChange = useCallback((_changes: EdgeChange[]) => {
    /* intentionally empty */
  }, []);

  const onConnect = useCallback((_connection: Connection) => {
    /* intentionally empty */
  }, []);

  // ── Handling lifecycle ────────────────────────────────────────

  const addHandlingNode = useCallback(
    (node: Node): string => {
      // Loading nodes always bypass the undo stack — the user's
      // "intent to produce" materialises as a single undoable step
      // only after the task succeeds (see resolveHandlingNode).
      withFlow((flow, doc) => {
        doc.transact(() => {
          const prepared: Node = {
            ...node,
            data: {
              ...(node.data ?? {}),
              state: 'handling',
            } as Node['data'],
          };
          flow.set(node.id, buildNodeYMap(prepared));
        }, noHistoryOrigin);
      });
      startHeartbeat(node.id);
      return node.id;
    },
    [withFlow, startHeartbeat],
  );

  const resolveHandlingNode = useCallback(
    (nodeId: string, patch: ImageEditorNodeDataPatch) => {
      withFlow((flow, doc) => {
        const nodeMap = flow.get(nodeId);
        if (!(nodeMap instanceof Y.Map)) return;

        // Snapshot current node shape for the "final" replacement.
        const currentType = nodeMap.get('type') as string | undefined;
        const currentPos = nodeMap.get('position') as Y.Map<unknown> | undefined;
        const currentStyle = nodeMap.get('style') as Y.Map<unknown> | undefined;
        const currentData = nodeMap.get('data') as Y.Map<unknown> | undefined;
        const currentParent = nodeMap.get('parentId') as string | undefined;
        const currentExtent = nodeMap.get('extent');
        const currentZIndex = nodeMap.get('zIndex') as number | undefined;

        const finalData: Record<string, unknown> = {};
        if (currentData) {
          currentData.forEach((v, k) => {
            if (k === 'handlingBy') return;
            if (k === 'state') return;
            finalData[k] = v;
          });
        }
        // Apply the patch
        for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
          if (k === 'pickState') continue;
          finalData[k] = v;
        }
        finalData.state = 'idle';

        const finalNode: Node = {
          id: nodeId,
          type: currentType ?? '2002',
          position: {
            x: currentPos instanceof Y.Map ? (currentPos.get('x') as number) ?? 0 : 0,
            y: currentPos instanceof Y.Map ? (currentPos.get('y') as number) ?? 0 : 0,
          },
          style: currentStyle instanceof Y.Map
            ? {
                width: currentStyle.get('width') as number | undefined,
                height: currentStyle.get('height') as number | undefined,
              }
            : undefined,
          data: finalData,
        };
        if (typeof currentZIndex === 'number') {
          (finalNode as Node & { zIndex?: number }).zIndex = currentZIndex;
        }
        if (typeof currentParent === 'string') finalNode.parentId = currentParent;
        if (currentExtent !== undefined) finalNode.extent = currentExtent as Node['extent'];

        // Delete loading + add final in one transact under userOrigin →
        // one combined undo step. Undo will remove the (now-final)
        // node; redo will restore it with the resolved content.
        doc.transact(() => {
          flow.delete(nodeId);
          flow.set(nodeId, buildNodeYMap(finalNode));
        }, userOrigin);
      });
      stopHeartbeat(nodeId);
    },
    [withFlow, userOrigin, stopHeartbeat],
  );

  const failHandlingNode = useCallback(
    (nodeId: string) => {
      withFlow((flow, doc) => {
        doc.transact(() => {
          flow.delete(nodeId);
        }, noHistoryOrigin);
      });
      stopHeartbeat(nodeId);
      clearNodeLocalState(nodeId);
      dispatch(clearMixedEditorExpandLock(nodeId));
    },
    [withFlow, stopHeartbeat, dispatch, clearNodeLocalState],
  );

  const forceRemoveStaleHandlingNode = useCallback(
    (nodeId: string) => {
      withFlow((flow, doc) => {
        doc.transact(() => {
          flow.delete(nodeId);
        }, noHistoryOrigin);
      });
      stopHeartbeat(nodeId);
      clearNodeLocalState(nodeId);
      dispatch(clearMixedEditorExpandLock(nodeId));
    },
    [withFlow, stopHeartbeat, dispatch, clearNodeLocalState],
  );

  // ── Undo / redo ──────────────────────────────────────────────

  const undo = useCallback(() => {
    const um = undoManagerRef.current;
    if (!um || um.undoStack.length === 0) return false;
    um.undo();
    return true;
  }, []);

  const redo = useCallback(() => {
    const um = undoManagerRef.current;
    if (!um || um.redoStack.length === 0) return false;
    um.redo();
    return true;
  }, []);

  // ── High-level convenience — thin wrappers around primitives ──

  const onCropNode = useCallback(
    (_nodeId: string) => {
      dispatch(setMixedEditorActiveTool('crop'));
    },
    [dispatch],
  );

  const replaceNodeWithFile = useCallback(
    async (nodeId: string, file: File) => {
      const toDataUrl = (f: File) =>
        new Promise<string>((resolve) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result ?? ''));
          reader.readAsDataURL(f);
        });
      const src = await toDataUrl(file);
      const meta = await getImageMeta(file);
      const nextSize = calcNodeSizeFromImage(meta.width, meta.height);
      updateNode(nodeId, {
        style: { width: nextSize.width, height: nextSize.height },
        data: createEditorImageNodeData(file.name, src) as Node['data'],
      });
    },
    [updateNode],
  );

  const copyNodeImageSrc = useCallback(
    (nodeId: string) => {
      const dataMap = manager ? getNodeDataMap(manager.doc.getMap('flow') as Y.Map<unknown>, nodeId) : null;
      const src = dataMap?.get('content') as string | undefined;
      if (!src) return;
      void navigator.clipboard.writeText(String(src));
      message.success('Copied');
    },
    [manager],
  );

  const readAllNodesSnapshot = useCallback((): Node[] => {
    if (!manager) return [];
    const flow = manager.doc.getMap('flow') as Y.Map<unknown>;
    const result: Node[] = [];
    flow.forEach((value, key) => {
      if (!(value instanceof Y.Map)) return;
      const pos = value.get('position') as Y.Map<unknown> | undefined;
      const style = value.get('style') as Y.Map<unknown> | undefined;
      const dataMap = value.get('data') as Y.Map<unknown> | undefined;
      const dataObj: Record<string, unknown> = {};
      if (dataMap) dataMap.forEach((v, k) => { dataObj[k] = v; });
      const node: Node = {
        id: key,
        type: (value.get('type') as string) ?? '2002',
        position: {
          x: pos instanceof Y.Map ? (pos.get('x') as number) ?? 0 : 0,
          y: pos instanceof Y.Map ? (pos.get('y') as number) ?? 0 : 0,
        },
        data: dataObj,
        selected: false,
      };
      if (style instanceof Y.Map) {
        node.style = {
          width: style.get('width') as number | undefined,
          height: style.get('height') as number | undefined,
        };
      }
      const parentId = value.get('parentId') as string | undefined;
      if (typeof parentId === 'string') node.parentId = parentId;
      const extent = value.get('extent');
      if (extent !== undefined) node.extent = extent as Node['extent'];
      result.push(node);
    });
    return result;
  }, [manager]);

  const createNewNodeBelow = useCallback(
    (nodeId: string) => {
      const allNodes = readAllNodesSnapshot();
      const source = allNodes.find((n) => n.id === nodeId);
      if (!source) return;
      const data = (source.data ?? {}) as ImageFlowNodeData;
      const { content: src, name } = data;
      if (!src) return;

      const sourceStyle = (source.style ?? {}) as { width?: number; height?: number };
      const copyW = typeof sourceStyle.width === 'number' ? sourceStyle.width : imageFlowDefaultWidth;
      const copyH = typeof sourceStyle.height === 'number' ? sourceStyle.height : imageFlowDefaultHeight;
      const sourceH = typeof sourceStyle.height === 'number' ? sourceStyle.height : imageFlowDefaultHeight;

      const nid = `image-flow-${nanoid(12)}`;
      const x = source.position.x;
      const y = source.position.y + sourceH + uploadGap;

      const newNode: Node<ImageFlowNodeData> = {
        id: nid,
        type: imageEditorImageNodeType,
        position: { x, y },
        style: { width: copyW, height: copyH },
        data: createEditorImageNodeData(`${name} (copy)`, src),
      };

      addNode(newNode);
    },
    [readAllNodesSnapshot, addNode],
  );

  const createInpaintResultNodeRight = useCallback(
    (
      sourceNodeId: string,
      nextImageSrc: string,
      delayMs: number = 3000,
      resultImageSize?: { width: number; height: number },
    ) => {
      const allNodes = readAllNodesSnapshot();
      const source = allNodes.find((n) => n.id === sourceNodeId);
      if (!source) return;

      const data = (source.data ?? {}) as ImageFlowNodeData;
      const name = data.name || 'Image';

      const sourceStyle = (source.style ?? {}) as { width?: number; height?: number };
      const copyW = typeof sourceStyle.width === 'number' ? sourceStyle.width : imageFlowDefaultWidth;
      const copyH = typeof sourceStyle.height === 'number' ? sourceStyle.height : imageFlowDefaultHeight;

      const nodeSize = nodeSizeFromResultOrFallback(resultImageSize, copyW, copyH);

      const nid = `image-flow-${nanoid(12)}`;
      const x = source.position.x + copyW + uploadGap;
      const y = source.position.y;

      const newNode: Node<ImageFlowNodeData> = {
        id: nid,
        type: imageEditorImageNodeType,
        position: { x, y },
        style: { width: nodeSize.width, height: nodeSize.height },
        data: createEditorImageNodeData(`${name} (copy)`, ''),
        ...inheritParentFieldsFromNode(source),
      };

      // Create as handling node (no undo); resolve on completion.
      addHandlingNode(newNode);
      window.setTimeout(() => {
        resolveHandlingNode(nid, { content: nextImageSrc });
      }, delayMs);
    },
    [readAllNodesSnapshot, addHandlingNode, resolveHandlingNode],
  );

  const createInpaintResultNodesRight = useCallback(
    (
      sourceNodeId: string,
      nextImageSrc: string,
      count: number,
      delayMs: number = 3000,
      resultImageSize?: { width: number; height: number },
    ) => {
      const allNodes = readAllNodesSnapshot();
      const source = allNodes.find((n) => n.id === sourceNodeId);
      if (!source) return;

      const normalizedCount = Math.max(1, Math.floor(count));
      const data = (source.data ?? {}) as ImageFlowNodeData;
      const name = data.name || 'Image';

      const sourceStyle = (source.style ?? {}) as { width?: number; height?: number };
      const copyW = typeof sourceStyle.width === 'number' ? sourceStyle.width : imageFlowDefaultWidth;
      const copyH = typeof sourceStyle.height === 'number' ? sourceStyle.height : imageFlowDefaultHeight;

      const nodeSize = nodeSizeFromResultOrFallback(resultImageSize, copyW, copyH);

      const startX = source.position.x + copyW + uploadGap;
      const startY = source.position.y;

      const inheritParentFromSource = inheritParentFieldsFromNode(source);
      const resultIds: string[] = [];

      if (normalizedCount === 1) {
        const nid = `image-flow-${nanoid(12)}`;
        resultIds.push(nid);
        const newNode: Node<ImageFlowNodeData> = {
          id: nid,
          type: imageEditorImageNodeType,
          position: { x: startX, y: startY },
          style: { width: nodeSize.width, height: nodeSize.height },
          data: createEditorImageNodeData(`${name} (copy)`, ''),
          ...inheritParentFromSource,
        };
        addHandlingNode(newNode);
      } else {
        const groupPadding = 40;
        const spacingY = uploadGap;
        const childrenAbsolute = Array.from({ length: normalizedCount }, (_, index) => ({
          id: `image-flow-${nanoid(12)}`,
          x: startX,
          y: startY + index * (nodeSize.height + spacingY),
        }));
        const groupId = `group-${nanoid(8)}`;
        const minX = Math.min(...childrenAbsolute.map((n) => n.x));
        const minY = Math.min(...childrenAbsolute.map((n) => n.y));
        const maxX = Math.max(...childrenAbsolute.map((n) => n.x + nodeSize.width));
        const maxY = Math.max(...childrenAbsolute.map((n) => n.y + nodeSize.height));
        const groupLeft = minX - groupPadding;
        const groupTop = minY - groupPadding;
        const groupNode: Node = {
          id: groupId,
          type: 'group',
          position: { x: groupLeft, y: groupTop },
          style: {
            width: maxX - minX + groupPadding * 2,
            height: maxY - minY + groupPadding * 2,
          },
          data: { collapsed: false, backgroundColor: 'rgba(12, 12, 13, 0.1)' },
        };
        // Group node is a user-visible topology choice — track in undo
        // stack. Children are handling nodes (non-tracked) so they'll
        // promote to undo-able on resolve.
        addNode(groupNode);
        for (const child of childrenAbsolute) {
          const childNode: Node<ImageFlowNodeData> = {
            id: child.id,
            type: imageEditorImageNodeType,
            parentId: groupId,
            position: { x: child.x - groupLeft, y: child.y - groupTop },
            style: { width: nodeSize.width, height: nodeSize.height },
            data: createEditorImageNodeData(`${name} (copy ${childrenAbsolute.indexOf(child) + 1})`, ''),
          };
          resultIds.push(child.id);
          addHandlingNode(childNode);
        }
      }

      window.setTimeout(() => {
        for (const nid of resultIds) {
          resolveHandlingNode(nid, { content: nextImageSrc });
        }
      }, delayMs);
    },
    [readAllNodesSnapshot, addHandlingNode, addNode, resolveHandlingNode],
  );

  const createEnhanceResultNodesRight = useCallback(
    (
      sourceNodeId: string,
      results: Array<{ row: number; col: number; src: string; width: number; height: number }>,
      delayMs: number = 3000,
    ) => {
      const allNodes = readAllNodesSnapshot();
      const source = allNodes.find((n) => n.id === sourceNodeId);
      if (!source || results.length === 0) return;

      const data = (source.data ?? {}) as ImageFlowNodeData;
      const name = data.name || 'Image';
      const sourceStyle = (source.style ?? {}) as { width?: number; height?: number };
      const copyW = typeof sourceStyle.width === 'number' ? sourceStyle.width : imageFlowDefaultWidth;
      const copyH = typeof sourceStyle.height === 'number' ? sourceStyle.height : imageFlowDefaultHeight;
      const gridGapX = 10;
      const gridGapY = 20;

      const startX = source.position.x + copyW + uploadGap;
      const startY = source.position.y;
      const minRow = Math.min(...results.map((item) => item.row));
      const minCol = Math.min(...results.map((item) => item.col));
      const sizedResults = results.map((item) => ({
        ...item,
        nodeSize: calcNodeSizeFromImage(item.width, item.height),
      }));
      const maxCellW = Math.max(...sizedResults.map((item) => item.nodeSize.width));
      const maxCellH = Math.max(...sizedResults.map((item) => item.nodeSize.height));
      const resultIds: string[] = [];

      if (sizedResults.length === 1) {
        const only = sizedResults[0];
        const nid = `image-flow-${nanoid(12)}`;
        resultIds.push(nid);
        addHandlingNode({
          id: nid,
          type: imageEditorImageNodeType,
          position: { x: startX, y: startY },
          style: { width: only.nodeSize.width, height: only.nodeSize.height },
          data: createEditorImageNodeData(`${name} (enhance)`, ''),
        });
      } else {
        const groupPadding = 40;
        const minGroupGapX = 40;
        const maxRow = Math.max(...sizedResults.map((item) => item.row));
        const maxCol = Math.max(...sizedResults.map((item) => item.col));
        const contentWidth = (maxCol - minCol) * (maxCellW + gridGapX) + maxCellW;
        const contentHeight = (maxRow - minRow) * (maxCellH + gridGapY) + maxCellH;
        const groupWidth = contentWidth + groupPadding * 2;
        const groupHeight = contentHeight + groupPadding * 2;
        const sourceCenterY = source.position.y + copyH / 2;
        const groupLeft = source.position.x + copyW + minGroupGapX;
        const groupTop = sourceCenterY - groupHeight / 2;
        const groupId = `group-${nanoid(8)}`;
        addNode({
          id: groupId,
          type: 'group',
          position: { x: groupLeft, y: groupTop },
          style: { width: groupWidth, height: groupHeight },
          data: { collapsed: false, backgroundColor: 'rgba(12, 12, 13, 0.1)' },
        });
        for (const item of sizedResults) {
          const nid = `image-flow-${nanoid(12)}`;
          resultIds.push(nid);
          const cellColOffset = item.col - minCol;
          const cellRowOffset = item.row - minRow;
          const slotX = groupPadding + cellColOffset * (maxCellW + gridGapX);
          const slotY = groupPadding + cellRowOffset * (maxCellH + gridGapY);
          addHandlingNode({
            id: nid,
            type: imageEditorImageNodeType,
            parentId: groupId,
            position: { x: slotX, y: slotY },
            style: { width: item.nodeSize.width, height: item.nodeSize.height },
            data: createEditorImageNodeData(`${name} (enhance ${sizedResults.indexOf(item) + 1})`, ''),
          });
        }
      }

      window.setTimeout(() => {
        resultIds.forEach((nid, index) => {
          const next = sizedResults[index];
          if (!next) return;
          resolveHandlingNode(nid, { content: next.src });
        });
      }, delayMs);
    },
    [readAllNodesSnapshot, addNode, addHandlingNode, resolveHandlingNode],
  );

  const createVideoPlaceholderNodeRight = useCallback(
    (
      sourceNodeId: string,
      options?: { nameSuffix?: string; state?: 'idle' | 'generating' },
    ): string | null => {
      const allNodes = readAllNodesSnapshot();
      const source = allNodes.find((n) => n.id === sourceNodeId);
      if (!source) return null;

      const data = (source.data ?? {}) as ImageFlowNodeData;
      const sourceName = typeof data?.name === 'string' && data.name.trim() ? data.name.trim() : 'video';
      const sourceStyle = (source.style ?? {}) as { width?: number; height?: number };
      const copyW = typeof sourceStyle.width === 'number' ? sourceStyle.width : imageFlowDefaultWidth;
      const copyH = typeof sourceStyle.height === 'number' ? sourceStyle.height : imageFlowDefaultHeight;
      const nodeId = `video-flow-${nanoid(12)}`;
      const x = source.position.x + copyW + uploadGap;
      const y = source.position.y;
      const nameSuffix = options?.nameSuffix?.trim() ? options.nameSuffix.trim() : 'copy';
      const state = options?.state ?? 'generating';

      const node: Node<ImageFlowNodeData> = {
        id: nodeId,
        type: imageEditorVideoNodeType,
        position: { x, y },
        style: { width: copyW, height: copyH },
        data: {
          ...createEditorVideoNodeData(`${sourceName} (${nameSuffix})`, ''),
          state,
        },
        ...inheritParentFieldsFromNode(source),
      };

      if (state === 'generating') {
        addHandlingNode(node);
      } else {
        addNode(node);
      }
      return nodeId;
    },
    [readAllNodesSnapshot, addHandlingNode, addNode],
  );

  const resolveVideoResultNode = useCallback(
    (
      nodeId: string,
      nextVideoSrc: string,
      options?: { state?: 'idle' | 'generating' },
    ) => {
      if (!nodeId || !nextVideoSrc) return;
      const nextState = options?.state ?? 'idle';
      if (nextState === 'idle') {
        resolveHandlingNode(nodeId, { content: nextVideoSrc });
      } else {
        updateNodeData(nodeId, { content: nextVideoSrc, state: nextState }, { history: 'skip' });
      }
    },
    [resolveHandlingNode, updateNodeData],
  );

  const createVideoResultNodeRight = useCallback(
    (sourceNodeId: string, nextVideoSrc: string, delayMs: number = 200) => {
      if (!nextVideoSrc) return;
      const nodeId = createVideoPlaceholderNodeRight(sourceNodeId, { nameSuffix: 'speed', state: 'generating' });
      if (!nodeId) return;
      window.setTimeout(() => {
        resolveVideoResultNode(nodeId, nextVideoSrc, { state: 'idle' });
      }, delayMs);
    },
    [createVideoPlaceholderNodeRight, resolveVideoResultNode],
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

      const data = (source.data ?? {}) as ImageFlowNodeData;
      const sourceName = typeof data?.name === 'string' && data.name.trim() ? data.name.trim() : 'video';
      const sourceStyle = (source.style ?? {}) as { width?: number; height?: number };
      const copyW = typeof sourceStyle.width === 'number' ? sourceStyle.width : imageFlowDefaultWidth;
      const copyH = typeof sourceStyle.height === 'number' ? sourceStyle.height : imageFlowDefaultHeight;
      const startX = source.position.x + copyW + uploadGap;
      const startY = source.position.y;
      const resultIds: string[] = [];

      if (normalizedSegments.length === 1) {
        const onlySegment = normalizedSegments[0];
        const nodeId = `video-flow-${nanoid(12)}`;
        resultIds.push(nodeId);
        addHandlingNode({
          id: nodeId,
          type: imageEditorVideoNodeType,
          position: { x: startX, y: startY },
          style: { width: copyW, height: copyH },
          data: {
            ...createEditorVideoNodeData(`${sourceName} (clip 1)`, ''),
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
        });
      } else {
        const spacingY = uploadGap;
        const groupPadding = 40;
        const minGroupGapX = 40;
        const groupWidth = copyW + groupPadding * 2;
        const contentHeight = normalizedSegments.length * copyH + (normalizedSegments.length - 1) * spacingY;
        const groupHeight = contentHeight + groupPadding * 2;
        const sourceCenterY = source.position.y + copyH / 2;
        const groupLeft = source.position.x + copyW + minGroupGapX;
        const groupTop = sourceCenterY - groupHeight / 2;
        const groupId = `group-${nanoid(8)}`;
        addNode({
          id: groupId,
          type: 'group',
          position: { x: groupLeft, y: groupTop },
          style: { width: groupWidth, height: groupHeight },
          data: { collapsed: false, backgroundColor: 'rgba(12, 12, 13, 0.1)' },
        });
        normalizedSegments.forEach((segment, index) => {
          const nodeId = `video-flow-${nanoid(12)}`;
          resultIds.push(nodeId);
          addHandlingNode({
            id: nodeId,
            type: imageEditorVideoNodeType,
            parentId: groupId,
            position: { x: groupPadding, y: groupPadding + index * (copyH + spacingY) },
            style: { width: copyW, height: copyH },
            data: {
              ...createEditorVideoNodeData(`${sourceName} (clip ${index + 1})`, ''),
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
          });
        });
      }

      window.setTimeout(() => {
        resultIds.forEach((nodeId, index) => {
          const nextSrc = Array.isArray(nextVideoSrc)
            ? nextVideoSrc[index] ?? nextVideoSrc[nextVideoSrc.length - 1] ?? ''
            : nextVideoSrc;
          if (!nextSrc) return;
          resolveHandlingNode(nodeId, { content: nextSrc });
        });
      }, delayMs);
    },
    [readAllNodesSnapshot, addNode, addHandlingNode, resolveHandlingNode],
  );

  const importImagesFromFiles = useCallback(
    async (files: File[], options?: { viewportCenterFlow: { x: number; y: number } }) => {
      if (!files.length) return;

      const toDataUrl = (file: File) =>
        new Promise<string>((resolve) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result ?? ''));
          reader.readAsDataURL(file);
        });

      type Prepared = { file: File; src: string; nodeSize: { width: number; height: number } };
      const prepared: Prepared[] = [];
      for (const file of files) {
        const src = await toDataUrl(file);
        const meta = await getImageMeta(file);
        const nodeSize = calcNodeSizeFromImage(meta.width, meta.height);
        prepared.push({ file, src, nodeSize });
      }

      const currentNodes = readAllNodesSnapshot();
      const maxZIndex = currentNodes.reduce((max, n) => {
        const z = (n as Node & { zIndex?: number }).zIndex ?? 0;
        return Math.max(max, z);
      }, 0);
      let zIndexCursor = maxZIndex;

      const created: Node<ImageFlowNodeData>[] = [];
      const center = options?.viewportCenterFlow;
      if (center) {
        const totalH = prepared.reduce((h, item, i) => h + item.nodeSize.height + (i > 0 ? uploadGap : 0), 0);
        let y = center.y - totalH / 2;
        for (const { file, src, nodeSize } of prepared) {
          const nid = `image-flow-${nanoid(12)}`;
          zIndexCursor += 1;
          created.push({
            id: nid,
            type: imageEditorImageNodeType,
            position: { x: center.x - nodeSize.width / 2, y },
            zIndex: zIndexCursor,
            style: { width: nodeSize.width, height: nodeSize.height },
            data: createEditorImageNodeData(file.name, src),
          });
          y += nodeSize.height + uploadGap;
        }
      } else {
        let y = getNextStackY(currentNodes);
        for (const { file, src, nodeSize } of prepared) {
          const nid = `image-flow-${nanoid(12)}`;
          zIndexCursor += 1;
          created.push({
            id: nid,
            type: imageEditorImageNodeType,
            position: { x: 120, y },
            zIndex: zIndexCursor,
            style: { width: nodeSize.width, height: nodeSize.height },
            data: createEditorImageNodeData(file.name, src),
          });
          y += nodeSize.height + uploadGap;
        }
      }

      addNodes(created);
    },
    [readAllNodesSnapshot, addNodes],
  );

  const importVideosFromFiles = useCallback(
    async (files: File[], options?: { viewportCenterFlow: { x: number; y: number } }) => {
      if (!files.length) return;

      const toDataUrl = (file: File) =>
        new Promise<string>((resolve) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result ?? ''));
          reader.readAsDataURL(file);
        });

      type Prepared = { file: File; src: string; nodeSize: { width: number; height: number } };
      const prepared: Prepared[] = [];
      for (const file of files) {
        const src = await toDataUrl(file);
        const meta = await getVideoMeta(file);
        const nodeSize = calcNodeSizeFromImage(meta.width, meta.height);
        prepared.push({ file, src, nodeSize });
      }

      const currentNodes = readAllNodesSnapshot();
      const maxZIndex = currentNodes.reduce((max, n) => {
        const z = (n as Node & { zIndex?: number }).zIndex ?? 0;
        return Math.max(max, z);
      }, 0);
      let zIndexCursor = maxZIndex;

      const created: Node<ImageFlowNodeData>[] = [];
      const center = options?.viewportCenterFlow;
      if (center) {
        const totalH = prepared.reduce((h, item, i) => h + item.nodeSize.height + (i > 0 ? uploadGap : 0), 0);
        let y = center.y - totalH / 2;
        for (const { file, src, nodeSize } of prepared) {
          const nid = `video-flow-${nanoid(12)}`;
          zIndexCursor += 1;
          created.push({
            id: nid,
            type: imageEditorVideoNodeType,
            position: { x: center.x - nodeSize.width / 2, y },
            zIndex: zIndexCursor,
            style: { width: nodeSize.width, height: nodeSize.height },
            data: createEditorVideoNodeData(file.name || 'video', src),
          });
          y += nodeSize.height + uploadGap;
        }
      } else {
        let y = getNextStackY(currentNodes);
        for (const { file, src, nodeSize } of prepared) {
          const nid = `video-flow-${nanoid(12)}`;
          zIndexCursor += 1;
          created.push({
            id: nid,
            type: imageEditorVideoNodeType,
            position: { x: 120, y },
            zIndex: zIndexCursor,
            style: { width: nodeSize.width, height: nodeSize.height },
            data: createEditorVideoNodeData(file.name || 'video', src),
          });
          y += nodeSize.height + uploadGap;
        }
      }

      addNodes(created);
    },
    [readAllNodesSnapshot, addNodes],
  );

  const importAudiosFromFiles = useCallback(
    async (files: File[], options?: { viewportCenterFlow: { x: number; y: number } }) => {
      if (!files.length) return;

      const toDataUrl = (file: File) =>
        new Promise<string>((resolve) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result ?? ''));
          reader.readAsDataURL(file);
        });

      type Prepared = { file: File; src: string };
      const prepared: Prepared[] = [];
      for (const file of files) {
        const src = await toDataUrl(file);
        prepared.push({ file, src });
      }

      const currentNodes = readAllNodesSnapshot();
      const maxZIndex = currentNodes.reduce((max, n) => {
        const z = (n as Node & { zIndex?: number }).zIndex ?? 0;
        return Math.max(max, z);
      }, 0);
      let zIndexCursor = maxZIndex;

      const created: Node<ImageFlowNodeData>[] = [];
      const center = options?.viewportCenterFlow;
      if (center) {
        const totalH = prepared.length * audioFlowDefaultHeight + Math.max(0, prepared.length - 1) * uploadGap;
        let y = center.y - totalH / 2;
        for (const { file, src } of prepared) {
          const nid = `audio-flow-${nanoid(12)}`;
          zIndexCursor += 1;
          created.push({
            id: nid,
            type: imageEditorAudioNodeType,
            position: { x: center.x - audioFlowDefaultWidth / 2, y },
            zIndex: zIndexCursor,
            style: { width: audioFlowDefaultWidth, height: audioFlowDefaultHeight },
            data: createEditorAudioNodeData(file.name || 'audio', src),
          });
          y += audioFlowDefaultHeight + uploadGap;
        }
      } else {
        let y = getNextStackY(currentNodes);
        for (const { file, src } of prepared) {
          const nid = `audio-flow-${nanoid(12)}`;
          zIndexCursor += 1;
          created.push({
            id: nid,
            type: imageEditorAudioNodeType,
            position: { x: 120, y },
            zIndex: zIndexCursor,
            style: { width: audioFlowDefaultWidth, height: audioFlowDefaultHeight },
            data: createEditorAudioNodeData(file.name || 'audio', src),
          });
          y += audioFlowDefaultHeight + uploadGap;
        }
      }

      addNodes(created);
    },
    [readAllNodesSnapshot, addNodes],
  );

  // ── Apply to main canvas ─────────────────────────────────────
  //
  // Apply reads `data.content` from the selected inner node (from THIS
  // editor's flow) and writes it to the main canvas host node's
  // `data.content`. The write uses the main canvas manager (via the
  // global ref) with userOrigin so the main canvas undo stack records
  // the replacement — Ctrl+Z on the main canvas rolls back.

  const applyToMainCanvasNode = useCallback(
    (mainCanvasNodeId: string, sourceInnerNodeId: string) => {
      if (!manager) return;
      const flow = manager.doc.getMap('flow') as Y.Map<unknown>;
      const innerDataMap = getNodeDataMap(flow, sourceInnerNodeId);
      if (!innerDataMap) return;
      const content = innerDataMap.get('content') as string | undefined;
      if (!content) return;

      // Lazy import to avoid a circular dep with canvas Yjs manager.
      // The main canvas manager registration is a module-level side
      // effect, so this require path is safe at call time.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const canvasRef = require('@/utils/canvasYjsRef') as typeof import('@/utils/canvasYjsRef');
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const projectMgr = require('@/utils/yjsProjectManager') as typeof import('@/utils/yjsProjectManager');
      const mainMgr = canvasRef.getCanvasYjsManager();
      if (!mainMgr) return;
      const mainNodeMap = mainMgr.nodesMap.get(mainCanvasNodeId);
      if (!(mainNodeMap instanceof Y.Map)) return;
      mainMgr.doc.transact(() => {
        const mainData = mainNodeMap.get('data');
        if (mainData instanceof Y.Map) {
          (mainData as Y.Map<unknown>).set('content', content);
        }
      }, projectMgr.getUserOrigin());
    },
    [manager],
  );

  return {
    addNode,
    addNodes,
    updateNode,
    updateNodeData,
    setNodeDraggable,
    removeNode,
    setNodes,
    onNodesChange,
    onEdgesChange,
    onConnect,

    addHandlingNode,
    resolveHandlingNode,
    failHandlingNode,
    forceRemoveStaleHandlingNode,

    onCropNode,
    replaceNodeWithFile,
    copyNodeImageSrc,
    createNewNodeBelow,
    createInpaintResultNodeRight,
    createInpaintResultNodesRight,
    createEnhanceResultNodesRight,
    createVideoPlaceholderNodeRight,
    resolveVideoResultNode,
    createVideoResultNodeRight,
    createCutVideoResultNodesRight,
    importImagesFromFiles,
    importVideosFromFiles,
    importAudiosFromFiles,

    applyToMainCanvasNode,

    undo,
    redo,
    canUndo,
    canRedo,
  };
}
