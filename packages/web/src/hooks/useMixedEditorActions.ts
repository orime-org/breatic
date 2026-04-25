/**
 * Mixed editor write actions + local-pending lifecycle (X pattern).
 *
 * Mirrors the main canvas' {@link useCanvasActions} pattern:
 *   - All writes go directly to Yjs (`doc.transact(fn, origin)`)
 *   - Origin controls the undo stack (`userOrigin` tracked,
 *     `noHistoryOrigin` not tracked)
 *   - Undo manager is attached lazily after Hocuspocus syncs so the
 *     initial-state replay never lands in the stack
 *
 * ## State taxonomy (aligned with main canvas + X pattern extension)
 *
 *   - `'idle'`        — finalized node, ready.
 *   - `'handling'`    — backend long-running job in flight (AIGC worker).
 *                       Written to Yjs so all collaborators see it.
 *                       Same semantics as main canvas `'handling'`.
 *   - `'localPending'` — browser-local short task (ffmpeg.wasm /
 *                       synchronous mini-tool API await). NEVER written
 *                       to Yjs (X pattern).
 *
 * ## X pattern lifecycle (for `'localPending'` only)
 *
 * Type A tasks (browser-local `ffmpeg.wasm`) do NOT persist their
 * `state: 'localPending'` tile to Yjs. Instead:
 *
 *   1. `addLocalPendingNode` registers a local pending entry in the
 *      context (tab-scoped). Only the originator sees the loading
 *      tile.
 *   2. `resolveLocalPendingNode` reads that entry, merges the completion
 *      patch, and writes a SINGLE final (`state: 'idle'`) node to
 *      Yjs under `userOrigin` → one undoable "I created this tile"
 *      step lands in the undo stack.
 *   3. `failLocalPendingNode` just drops the local entry.
 *
 * Why not persist `'localPending'` to Yjs? If the browser tab closes
 * mid-task, the ffmpeg Web Worker dies with it. A Yjs-persisted
 * handling tile would survive as a stuck-forever zombie that every
 * collaborator has to look at and eventually force-clear. The X
 * pattern eliminates that failure mode entirely — if the browser
 * dies, Yjs has nothing to be stuck on.
 *
 * Type B tasks (backend mini-tools) use `'handling'` in Yjs, and reuse
 * the same primitives to render their own loading tile locally while
 * `await`ing the API response.
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
import * as miniToolsApi from '@/apis/miniTools';
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

  // `zIndex` and `draggable` are UI-only (overlay) — per user stacking
  // order / per-user editing-mode drag lock. Writing them to Yjs leaks
  // single-tab UI state to every collaborator (and historically let an
  // editing-mode exit path strand `draggable: false` forever).
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

// X pattern: Yjs never holds `state: 'localPending'` — the originator
// keeps that pending tile locally, and Yjs only sees completed
// `state: 'idle'` nodes (or `state: 'handling'` for backend-owned
// jobs). Legacy callers writing 'localPending' directly via
// updateNode/updateNodeData are a bug; tracked by `removeNode`'s
// pending-task guard, not an implicit helper here.

// ── Hook input/output ──────────────────────────────────────────

export interface UseMixedEditorActionsResult {
  // ── Low-level primitives ──
  addNode: (node: Node, options?: HistoryOptions & { select?: boolean }) => void;
  addNodes: (nodes: Node[], options?: HistoryOptions) => void;
  updateNode: (nodeId: string, updates: Partial<Node>, options?: HistoryOptions) => void;
  updateNodeData: (nodeId: string, patch: ImageEditorNodeDataPatch, options?: HistoryOptions) => void;
  removeNode: (nodeId: string) => void;
  setNodes: (nodes: Node[], options?: HistoryOptions) => void;
  onNodesChange: (changes: NodeChange[], options?: HistoryOptions) => void;
  onEdgesChange: (changes: EdgeChange[]) => void;
  onConnect: (connection: Connection) => void;

  // ── Handling lifecycle ──
  addLocalPendingNode: (node: Node) => string;
  resolveLocalPendingNode: (nodeId: string, patch: ImageEditorNodeDataPatch) => void;
  failLocalPendingNode: (nodeId: string) => void;
  /** Remove a handling node whose heartbeat is stuck (called by the cleanup UI). */
  forceRemoveStaleLocalPendingNode: (nodeId: string) => void;

  /**
   * Promote a local-pending node into a Yjs `handling` node keeping
   * the same id. Used by the "frontend-compose + backend AIGC" flow
   * (e.g. `image.graffiti`) where the user first sees a local spinner
   * during compose/upload, then — once the composed artifact is ready
   * — the node transitions to a Yjs-shared handling state while the
   * backend works.
   *
   * Contract: `nodeId` must be a live localPending entry; otherwise
   * this is a no-op. The write is atomic under `userOrigin` so undo
   * reverts the transition.
   */
  promoteLocalPendingToHandling: (
    nodeId: string,
    patch: ImageEditorNodeDataPatch,
  ) => void;

  /**
   * Create a ReactFlow group + N child nodes in a single atomic
   * `setNodes` — semantically equivalent to the main canvas'
   * `GroupToolbarPanel.handleGroup`, but with pre-supplied children
   * and a per-child state directive (N of them enter either
   * `localPending` for pure-frontend work or `handling` for backend
   * multi-output tasks like `video.cut`).
   *
   * Children are stamped with `parentId = groupId` and have their
   * `position` treated as GROUP-LOCAL coordinates.
   *
   * @returns The created group id + the child ids, in input order.
   */
  createGroupWithChildren: (opts: {
    groupNode: Node;
    children: Node[];
    childState: 'localPending' | 'handling';
  }) => { groupId: string; childIds: string[] };

  /**
   * Trigger a backend-executed mini-tool for N placeholder nodes.
   *
   * Every placeholder is written to Yjs as a `state:'handling'` node
   * (collaborators see it instantly), then the POST is fired with
   * `node_ids: [...]` so the Worker knows which nodes to update when
   * the task completes. On POST failure every placeholder flips to
   * `state:'idle'` + `errorInfo` + cleared `content` / `coverUrl`
   * (mixed-editor failure contract — no retry, user deletes manually).
   *
   * Worker completion flows back through the `task-events` Redis
   * stream → Collab task-listener → Yjs observer. The client doesn't
   * `await` the result URL here.
   *
   * @returns Array of created placeholder node ids (length matches
   *   `opts.placeholders`), or `null` if any source is missing.
   */
  triggerBackendMiniTool: (opts: {
    category: 'image' | 'video' | 'audio';
    toolName: string;
    placeholders: Array<{
      sourceNodeId: string;
      nameSuffix: string;
      /** Explicit placeholder size; defaults to source node's size. */
      expectedSize?: { width: number; height: number };
      /** Optional parent group id (used by `video.cut` / multi-output tools). */
      parentId?: string;
      /** Explicit position override (group-local if `parentId` set). */
      positionOverride?: { x: number; y: number };
    }>;
    /**
     * Tool-specific params forwarded to the Worker. Must include the
     * source URL field matching that modality's schema convention
     * (image family: `image`; video family: `video`; audio family:
     * `audio`), plus any operation-specific fields. `node_ids` is
     * injected automatically from the placeholders.
     */
    params: Record<string, unknown>;
  }) => Promise<string[] | null>;

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
    options?: { nameSuffix?: string; state?: 'idle' | 'localPending' },
  ) => string | null;
  resolveVideoResultNode: (
    nodeId: string,
    nextVideoSrc: string,
    options?: { state?: 'idle' | 'localPending' },
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
  const {
    manager,
    setNodeLocalData,
    clearNodeLocalState,
    setNodeZIndex: setNodeZIndexOverlay,
    getMaxZIndex,
    addPendingTask,
    removePendingTask,
    getPendingTask,
    hostNodeId,
  } = useMixedEditorDataInternal();
  const userInfo = useSelector((s: RootState) => s.userCenter.userInfo);
  const userId = (userInfo as { id?: string } | undefined)?.id ?? '';
  const username =
    (userInfo as { username?: string; name?: string } | undefined)?.username ??
    (userInfo as { name?: string } | undefined)?.name ??
    '';
  const projectId = useSelector((s: RootState) => s.canvas.workflowId);

  const userOrigin = userOriginFor(userId);

  // UndoManager is attached lazily after sync; undoManagerRef is the
  // stable handle that all action callbacks close over.
  const undoManagerRef = useRef<Y.UndoManager | null>(null);
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);

  // X pattern: handling tiles live in the context's local pendingTasks
  // map. No heartbeats, no Yjs "handling" state, no cross-tab replication.
  // The action hook reaches that state through the Data Context.

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

  // New-node primitives: the single point where "a node just arrived"
  // gets reified. zIndex assignment is centralized here so every caller
  // (uploads, mini-tool results, placeholders, group creation, duplicate,
  // …) gets the "new on top in THIS user's stacking" semantics without
  // needing to remember to call `setNodeZIndex` themselves.
  const addNode = useCallback(
    (node: Node, options?: HistoryOptions & { select?: boolean }) => {
      const origin = options?.history === 'skip' ? noHistoryOrigin : userOrigin;
      withFlow((flow, doc) => {
        doc.transact(() => {
          flow.set(node.id, buildNodeYMap(node));
        }, origin);
      });
      setNodeZIndexOverlay(node.id, getMaxZIndex() + 1);
    },
    [withFlow, userOrigin, getMaxZIndex, setNodeZIndexOverlay],
  );

  const addNodes = useCallback(
    (nodes: Node[], options?: HistoryOptions) => {
      const origin = options?.history === 'skip' ? noHistoryOrigin : userOrigin;
      withFlow((flow, doc) => {
        doc.transact(() => {
          for (const node of nodes) flow.set(node.id, buildNodeYMap(node));
        }, origin);
      });
      // Preserve caller's input order as the layer order (earlier = lower).
      const base = getMaxZIndex();
      nodes.forEach((n, i) => setNodeZIndexOverlay(n.id, base + i + 1));
    },
    [withFlow, userOrigin, getMaxZIndex, setNodeZIndexOverlay],
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
          // `selected`, `draggable`, `zIndex`, `measured` are UI-only —
          // callers use the MixedEditorDataContext setters
          // (`applyLocalNodeChanges`, `setNodeDraggable`, `setNodeZIndex`)
          // so those writes never leak to collaborators.
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


  const removeNode = useCallback(
    (nodeId: string) => {
      // Handling guard (X pattern): if this node is a pending local
      // task, refuse to delete — let the task finish or be explicitly
      // cancelled. The in-flight ffmpeg Web Worker doesn't know about
      // the node's existence, so "silently delete the UI tile" would
      // strand its output when it lands.
      if (getPendingTask(nodeId)) return;

      withFlow((flow, doc) => {
        const nodeMap = flow.get(nodeId);
        if (!(nodeMap instanceof Y.Map)) return;
        doc.transact(() => {
          flow.delete(nodeId);
        }, userOrigin);
      });
      clearNodeLocalState(nodeId);
      dispatch(clearMixedEditorExpandLock(nodeId));
    },
    [withFlow, userOrigin, dispatch, clearNodeLocalState, getPendingTask],
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
              // Handling guard at the ReactFlow boundary too —
              // pending tiles are local and not in Yjs, and Delete/
              // backspace hitting one should be a no-op.
              if (getPendingTask(change.id)) continue;
              const nodeMap = flow.get(change.id);
              if (!(nodeMap instanceof Y.Map)) continue;
              flow.delete(change.id);
              dispatch(clearMixedEditorExpandLock(change.id));
            }
            // `select` / `dimensions` / `reset` are UI-only and MUST NOT
            // land in Yjs. Callers are expected to split them out and
            // pass them to `applyLocalNodeChanges` from
            // MixedEditorDataContext before reaching this function —
            // see `handleNodesChange` in `mixedEditor/index.tsx`.
          }
        }, origin);
      });
    },
    [withFlow, userOrigin, dispatch, getPendingTask],
  );

  // Mixed editor has no edges — these two are retained for API parity
  // with the ReactFlow props but do nothing.
  const onEdgesChange = useCallback((_changes: EdgeChange[]) => {
    /* intentionally empty */
  }, []);

  const onConnect = useCallback((_connection: Connection) => {
    /* intentionally empty */
  }, []);

  // ── Handling lifecycle (X pattern — local only) ───────────────
  //
  // Browser-local tasks (ffmpeg.wasm + mini-tool await) keep their
  // "loading tile" in the DataContext's `pendingTasks` map. Nothing
  // lands in Yjs until the task completes, so a dead browser tab can
  // never leave a stuck `'localPending'` node for collaborators.

  const addLocalPendingNode = useCallback(
    (node: Node): string => {
      const prepared: Node = {
        ...node,
        data: {
          ...(node.data ?? {}),
          state: 'localPending',
        } as Node['data'],
      };
      addPendingTask(prepared);
      // Same "new on top in author's stacking" semantics as addNode.
      // When this tile later resolves via resolveLocalPendingNode, the
      // Yjs write goes through addNode (well, flow.set + buildNodeYMap)
      // but the overlay entry remains, so the final idle node keeps its
      // stacking position — no flicker on resolve.
      setNodeZIndexOverlay(node.id, getMaxZIndex() + 1);
      return node.id;
    },
    [addPendingTask, getMaxZIndex, setNodeZIndexOverlay],
  );

  const resolveLocalPendingNode = useCallback(
    (nodeId: string, patch: ImageEditorNodeDataPatch) => {
      const pending = getPendingTask(nodeId);
      if (!pending) return;

      // Merge: pending node's own data (minus state/handlingBy) + patch
      // + state='idle'.
      const pendingData = (pending.node.data ?? {}) as Record<string, unknown>;
      const finalData: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(pendingData)) {
        if (k === 'state') continue;
        if (k === 'handlingBy') continue;
        finalData[k] = v;
      }
      for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
        if (k === 'pickState') continue;
        finalData[k] = v;
      }
      finalData.state = 'idle';

      const finalNode: Node = {
        ...pending.node,
        data: finalData,
      };

      // Drop the local pending entry BEFORE writing to Yjs so that
      // the context's merge (yjsNodes + pendingTasks) doesn't briefly
      // render the node twice.
      removePendingTask(nodeId);
      withFlow((flow, doc) => {
        doc.transact(() => {
          flow.set(nodeId, buildNodeYMap(finalNode));
        }, userOrigin);
      });
    },
    [getPendingTask, removePendingTask, withFlow, userOrigin],
  );

  const failLocalPendingNode = useCallback(
    (nodeId: string) => {
      removePendingTask(nodeId);
      clearNodeLocalState(nodeId);
      dispatch(clearMixedEditorExpandLock(nodeId));
    },
    [removePendingTask, clearNodeLocalState, dispatch],
  );

  const forceRemoveStaleLocalPendingNode = useCallback(
    (nodeId: string) => {
      // X pattern: "stale" only makes sense for local pending tasks,
      // and dropping one is the same as failing it.
      removePendingTask(nodeId);
      clearNodeLocalState(nodeId);
      dispatch(clearMixedEditorExpandLock(nodeId));
    },
    [removePendingTask, clearNodeLocalState, dispatch],
  );

  const promoteLocalPendingToHandling = useCallback(
    (nodeId: string, patch: ImageEditorNodeDataPatch) => {
      const pending = getPendingTask(nodeId);
      if (!pending) return;

      // Merge pending data + patch, force state='handling'.
      // Drop stale errorInfo from any prior failure so collaborators
      // don't briefly see the old message when the node becomes Yjs-
      // visible.
      const pendingData = (pending.node.data ?? {}) as Record<string, unknown>;
      const finalData: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(pendingData)) {
        if (k === 'state') continue;
        if (k === 'errorInfo') continue;
        finalData[k] = v;
      }
      for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
        if (k === 'pickState') continue;
        finalData[k] = v;
      }
      finalData.state = 'handling';

      const finalNode: Node = {
        ...pending.node,
        data: finalData,
      };

      // Move from local pendingTasks → Yjs in one atomic step. After
      // this point, every collaborator sees the node in `handling`
      // state and `handlingBy` identifies the originator.
      removePendingTask(nodeId);
      withFlow((flow, doc) => {
        doc.transact(() => {
          flow.set(nodeId, buildNodeYMap(finalNode));
        }, userOrigin);
      });
    },
    [getPendingTask, removePendingTask, withFlow, userOrigin],
  );

  const createGroupWithChildren = useCallback(
    (opts: {
      groupNode: Node;
      children: Node[];
      childState: 'localPending' | 'handling';
    }): { groupId: string; childIds: string[] } => {
      const { groupNode, children, childState } = opts;
      const groupId = groupNode.id;
      const childIds = children.map((c) => c.id);

      if (childState === 'localPending') {
        // gridSlice pattern: group enters Yjs (collaborators see an
        // empty container immediately); children stay local until they
        // finish Canvas work + upload, then land in Yjs one-by-one via
        // resolveLocalPendingNode.
        addNode(groupNode);
        for (const child of children) {
          addLocalPendingNode({
            ...child,
            parentId: groupId,
          });
        }
      } else {
        // video.cut pattern: group + N handling children all atomic
        // in Yjs so the Worker can address them via node_ids and
        // every collaborator sees the full group + spinners together.
        const withParent = children.map((c) => ({
          ...c,
          parentId: groupId,
          data: {
            ...((c.data ?? {}) as Record<string, unknown>),
            state: 'handling' as const,
          },
        }));
        addNodes([groupNode, ...withParent]);
      }

      return { groupId, childIds };
    },
    [addNode, addNodes, addLocalPendingNode],
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
      addLocalPendingNode(newNode);
      window.setTimeout(() => {
        resolveLocalPendingNode(nid, { content: nextImageSrc });
      }, delayMs);
    },
    [readAllNodesSnapshot, addLocalPendingNode, resolveLocalPendingNode],
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
        addLocalPendingNode(newNode);
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
          addLocalPendingNode(childNode);
        }
      }

      window.setTimeout(() => {
        for (const nid of resultIds) {
          resolveLocalPendingNode(nid, { content: nextImageSrc });
        }
      }, delayMs);
    },
    [readAllNodesSnapshot, addLocalPendingNode, addNode, resolveLocalPendingNode],
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
        addLocalPendingNode({
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
          addLocalPendingNode({
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
          resolveLocalPendingNode(nid, { content: next.src });
        });
      }, delayMs);
    },
    [readAllNodesSnapshot, addNode, addLocalPendingNode, resolveLocalPendingNode],
  );

  const createVideoPlaceholderNodeRight = useCallback(
    (
      sourceNodeId: string,
      options?: { nameSuffix?: string; state?: 'idle' | 'localPending' },
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
      const state = options?.state ?? 'localPending';

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

      if (state === 'localPending') {
        addLocalPendingNode(node);
      } else {
        addNode(node);
      }
      return nodeId;
    },
    [readAllNodesSnapshot, addLocalPendingNode, addNode],
  );

  const resolveVideoResultNode = useCallback(
    (
      nodeId: string,
      nextVideoSrc: string,
      options?: { state?: 'idle' | 'localPending' },
    ) => {
      if (!nodeId || !nextVideoSrc) return;
      const nextState = options?.state ?? 'idle';
      if (nextState === 'idle') {
        resolveLocalPendingNode(nodeId, { content: nextVideoSrc });
      } else {
        updateNodeData(nodeId, { content: nextVideoSrc, state: nextState }, { history: 'skip' });
      }
    },
    [resolveLocalPendingNode, updateNodeData],
  );

  const createVideoResultNodeRight = useCallback(
    (sourceNodeId: string, nextVideoSrc: string, delayMs: number = 200) => {
      if (!nextVideoSrc) return;
      const nodeId = createVideoPlaceholderNodeRight(sourceNodeId, { nameSuffix: 'speed', state: 'localPending' });
      if (!nodeId) return;
      window.setTimeout(() => {
        resolveVideoResultNode(nodeId, nextVideoSrc, { state: 'idle' });
      }, delayMs);
    },
    [createVideoPlaceholderNodeRight, resolveVideoResultNode],
  );

  /**
   * Trigger a backend-executed mini-tool (T3 phase 2+).
   *
   * Unlike `createVideoPlaceholderNodeRight` which writes to the local
   * pendingTasks map (X pattern for browser-local ffmpeg.wasm tasks),
   * this path:
   *   1. `addNode(state:'handling')` writes the placeholder to Yjs
   *      directly — collaborators see it instantly.
   *   2. POSTs to `/api/v1/mini-tools/:category` with `host_node_id`
   *      so the Worker routes its completion event to the mixed-editor
   *      doc (not the main canvas).
   *   3. On POST failure, flips the node to `state:'idle'` with
   *      `errorInfo`, clears `content` / `coverUrl` (mixed-editor
   *      failure contract — no retry, user deletes manually).
   *
   * Successful task completion flows back through the task-events
   * Redis stream → Collab task-listener → Yjs observer in every
   * connected client. No awaited HTTP result here.
   */
  const triggerBackendMiniTool = useCallback(
    async (opts: {
      category: 'image' | 'video' | 'audio';
      toolName: string;
      placeholders: Array<{
        sourceNodeId: string;
        nameSuffix: string;
        expectedSize?: { width: number; height: number };
        parentId?: string;
        positionOverride?: { x: number; y: number };
      }>;
      params: Record<string, unknown>;
    }): Promise<string[] | null> => {
      const { category, toolName, placeholders, params: toolParams } = opts;
      if (placeholders.length === 0) return null;

      const allNodes = readAllNodesSnapshot();

      const idPrefix = category === 'video' ? 'video-flow' : category === 'audio' ? 'audio-flow' : 'image-flow';
      const nodeType = category === 'video' ? imageEditorVideoNodeType
        : category === 'audio' ? imageEditorAudioNodeType
        : imageEditorImageNodeType;

      const newNodeIds: string[] = [];
      const newNodes: Node<ImageFlowNodeData>[] = [];

      for (const p of placeholders) {
        const source = allNodes.find((n) => n.id === p.sourceNodeId);
        if (!source) return null;

        const sourceData = (source.data ?? {}) as ImageFlowNodeData;
        const sourceName = typeof sourceData.name === 'string' && sourceData.name.trim()
          ? sourceData.name.trim()
          : category;
        const sourceStyle = (source.style ?? {}) as { width?: number; height?: number };
        const sizeW = p.expectedSize?.width ?? sourceStyle.width ?? imageFlowDefaultWidth;
        const sizeH = p.expectedSize?.height ?? sourceStyle.height ?? imageFlowDefaultHeight;

        const newNodeId = `${idPrefix}-${nanoid(12)}`;
        newNodeIds.push(newNodeId);

        const position = p.positionOverride ?? {
          x: source.position.x + sizeW + uploadGap,
          y: source.position.y,
        };

        const seedData = category === 'video'
          ? createEditorVideoNodeData(`${sourceName} (${p.nameSuffix})`, '')
          : category === 'audio'
            ? createEditorAudioNodeData(`${sourceName} (${p.nameSuffix})`, '')
            : createEditorImageNodeData(`${sourceName} (${p.nameSuffix})`, '');

        const placeholder: Node<ImageFlowNodeData> = {
          id: newNodeId,
          type: nodeType,
          position,
          style: { width: sizeW, height: sizeH },
          data: {
            ...seedData,
            state: 'handling',
          },
          ...(p.parentId
            ? { parentId: p.parentId }
            : inheritParentFieldsFromNode(source)),
        };
        newNodes.push(placeholder);
      }

      // One atomic Yjs write — every collaborator sees all placeholders
      // appear together. Uses userOrigin so the creation is undoable.
      addNodes(newNodes);

      const body = {
        tool: toolName,
        project_id: projectId ?? undefined,
        node_ids: newNodeIds,
        host_node_id: hostNodeId ?? undefined,
        ...toolParams,
      };

      try {
        if (category === 'video') {
          await miniToolsApi.executeVideo(body);
        } else if (category === 'audio') {
          await miniToolsApi.executeAudio(body);
        } else {
          await miniToolsApi.executeImage(body);
        }
        return newNodeIds;
      } catch (err) {
        const errorMessage =
          err instanceof Error ? err.message : typeof err === 'string' ? err : 'Mini-tool request failed';
        // Mixed-editor failure contract for every placeholder: clear
        // content/coverUrl, surface errorInfo. `history: 'skip'` keeps
        // the undo stack clean so the user's next Ctrl+Z does not
        // revive the handling placeholders (which would be confusing).
        for (const nid of newNodeIds) {
          updateNodeData(
            nid,
            {
              state: 'idle',
              content: '',
              coverUrl: '',
              errorInfo: errorMessage,
            },
            { history: 'skip' },
          );
        }
        message.error(errorMessage);
        return newNodeIds;
      }
    },
    [readAllNodesSnapshot, addNodes, updateNodeData, projectId, hostNodeId],
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
        addLocalPendingNode({
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
          addLocalPendingNode({
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
          resolveLocalPendingNode(nodeId, { content: nextSrc });
        });
      }, delayMs);
    },
    [readAllNodesSnapshot, addNode, addLocalPendingNode, resolveLocalPendingNode],
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
      const created: Node<ImageFlowNodeData>[] = [];
      const center = options?.viewportCenterFlow;
      if (center) {
        const totalH = prepared.reduce((h, item, i) => h + item.nodeSize.height + (i > 0 ? uploadGap : 0), 0);
        let y = center.y - totalH / 2;
        for (const { file, src, nodeSize } of prepared) {
          created.push({
            id: `image-flow-${nanoid(12)}`,
            type: imageEditorImageNodeType,
            position: { x: center.x - nodeSize.width / 2, y },
            style: { width: nodeSize.width, height: nodeSize.height },
            data: createEditorImageNodeData(file.name, src),
          });
          y += nodeSize.height + uploadGap;
        }
      } else {
        let y = getNextStackY(currentNodes);
        for (const { file, src, nodeSize } of prepared) {
          created.push({
            id: `image-flow-${nanoid(12)}`,
            type: imageEditorImageNodeType,
            position: { x: 120, y },
            style: { width: nodeSize.width, height: nodeSize.height },
            data: createEditorImageNodeData(file.name, src),
          });
          y += nodeSize.height + uploadGap;
        }
      }

      // addNodes centralizes zIndex assignment (caller input order =
      // layer order, earlier = lower).
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
      const created: Node<ImageFlowNodeData>[] = [];
      const center = options?.viewportCenterFlow;
      if (center) {
        const totalH = prepared.reduce((h, item, i) => h + item.nodeSize.height + (i > 0 ? uploadGap : 0), 0);
        let y = center.y - totalH / 2;
        for (const { file, src, nodeSize } of prepared) {
          created.push({
            id: `video-flow-${nanoid(12)}`,
            type: imageEditorVideoNodeType,
            position: { x: center.x - nodeSize.width / 2, y },
            style: { width: nodeSize.width, height: nodeSize.height },
            data: createEditorVideoNodeData(file.name || 'video', src),
          });
          y += nodeSize.height + uploadGap;
        }
      } else {
        let y = getNextStackY(currentNodes);
        for (const { file, src, nodeSize } of prepared) {
          created.push({
            id: `video-flow-${nanoid(12)}`,
            type: imageEditorVideoNodeType,
            position: { x: 120, y },
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
      const created: Node<ImageFlowNodeData>[] = [];
      const center = options?.viewportCenterFlow;
      if (center) {
        const totalH = prepared.length * audioFlowDefaultHeight + Math.max(0, prepared.length - 1) * uploadGap;
        let y = center.y - totalH / 2;
        for (const { file, src } of prepared) {
          created.push({
            id: `audio-flow-${nanoid(12)}`,
            type: imageEditorAudioNodeType,
            position: { x: center.x - audioFlowDefaultWidth / 2, y },
            style: { width: audioFlowDefaultWidth, height: audioFlowDefaultHeight },
            data: createEditorAudioNodeData(file.name || 'audio', src),
          });
          y += audioFlowDefaultHeight + uploadGap;
        }
      } else {
        let y = getNextStackY(currentNodes);
        for (const { file, src } of prepared) {
          created.push({
            id: `audio-flow-${nanoid(12)}`,
            type: imageEditorAudioNodeType,
            position: { x: 120, y },
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
    removeNode,
    setNodes,
    onNodesChange,
    onEdgesChange,
    onConnect,

    addLocalPendingNode,
    resolveLocalPendingNode,
    failLocalPendingNode,
    forceRemoveStaleLocalPendingNode,
    promoteLocalPendingToHandling,
    createGroupWithChildren,

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
    triggerBackendMiniTool,
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
