/**
 * Mixed editor data + runtime context — read layer between the
 * per-node editor Y.Doc and React components, plus the manager handle
 * and three layers of UI-only local state:
 *
 *   1. `overlay` — per-node select / dimensions / pickState. UI-only,
 *      never replicated to collaborators.
 *   2. `pendingTasks` — ffmpeg.wasm / local-only work-in-progress
 *      "loading" tiles. See § X pattern below.
 *   3. `hostNodeId` — the main canvas node this editor is bound to.
 *      Consumed by the per-node Apply button so it writes back to the
 *      same host that opened the editor (never to a sibling node).
 *
 * ## The X pattern for loading tiles
 *
 * Mixed editor tasks come in two flavours:
 *
 *   - **Type A (browser-local)** — `ffmpeg.wasm` crop / speed /
 *     adjust / etc. The Web Worker is tied to the browser tab; if
 *     the tab dies or the panel unmounts, the task dies with it.
 *   - **Type B (backend)** — AI mini-tools. Executed on the server
 *     Worker; survives the browser.
 *
 * For Type A we do NOT write `state: 'localPending'` nodes to the Yjs
 * flow. Instead the originator keeps a local `pendingTasks` entry
 * (ephemeral to this browser tab). On completion the action hook
 * materialises a single `state: 'idle'` node into Yjs — collaborators
 * see the result appear atomically.
 *
 * This eliminates the "stuck handling node" failure mode by design:
 * if the browser dies there is simply nothing in Yjs to be stuck on.
 * The cost is that collaborators don't see the loading tile of a
 * peer's in-flight local task — which is acceptable because in-flight
 * Type A tasks are seconds-long and the editor is primarily single-user.
 *
 * ```
 * Yjs node editor Y.Doc (source of truth for completed state)
 *   ↓  useMixedEditorYjsInternal (observe `flow` Y.Map)
 * MixedEditorDataContext (Yjs nodes + pending tiles + overlay + hostNodeId)
 *   ↓  useMixedEditorData()      ← read
 *   ↓  useMixedEditorActions()   ← write (reaches state via context)
 * MixedEditor ReactFlow / toolbar / per-node Apply button
 * ```
 */

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useCallback,
  type ReactNode,
} from 'react';
import type { Node, Edge, NodeChange } from '@xyflow/react';
import type { YjsNodeEditorManager } from '@/utils/yjsNodeEditorManager';
import { useMixedEditorYjsInternal } from '@/hooks/useMixedEditorYjsInternal';

/**
 * Per-node UI-only overlay merged on top of the Yjs-authoritative node.
 *
 * Each field here is DELIBERATELY not in Yjs:
 *   - `selected` — one user's focus, not a collaborative cursor.
 *   - `measured` — ReactFlow's DOM measurement, reflects local viewport.
 *   - `draggable` — temporary lock while THIS user is in an editing
 *     mode (Relight / Crop / Inpaint overlay). Letting it escape to
 *     Yjs would lock the node for every collaborator.
 *   - `zIndex` — each user is free to bring their own focused tile to
 *     the top; layer order is not a collaborative contract.
 *   - `dataOverlay` — any UI-only `data.*` key (e.g. `pickState`).
 */
export interface MixedEditorNodeLocalState {
  selected?: boolean;
  measured?: { width: number; height: number };
  draggable?: boolean;
  zIndex?: number;
  /** Anything under `data.*` that should NOT replicate via Yjs (pickState, other ephemeral UI). */
  dataOverlay?: Record<string, unknown>;
}

/**
 * A browser-local in-flight task (Type A).
 *
 * The full `node` payload is what ReactFlow renders while the task
 * runs; `state: 'localPending'` (and any handler-specific runtime data
 * like `nodeRuntimeData.parameter`) lives here. On resolution the
 * action hook merges this with a `patch` and writes a single final
 * node to Yjs.
 */
export interface PendingTaskEntry {
  node: Node;
  startedAt: number;
}

export interface MixedEditorDataContextValue {
  /** The Yjs node editor manager backing this editor (null while connecting). */
  manager: YjsNodeEditorManager | null;

  /**
   * The main-canvas node id that this editor is bound to — the "host".
   * Per-node Apply buttons write their content back to THIS node and
   * only this node. `null` when no editor panel is open on a
   * mixed-type host (provider receives `undefined` → normalises to
   * `null`).
   */
  hostNodeId: string | null;

  nodes: Node[];
  /** Always empty — mixed editor has no edges by design. */
  edges: Edge[];
  /** O(1) node lookup by ID. */
  nodesById: Map<string, Node>;
  /**
   * The node id currently selected locally, or `null` if nothing is
   * selected. Single-value — Apply-to-this-node is single-target.
   */
  selectedNodeId: string | null;

  loading: boolean;
  syncError: string | null;

  /** `true` if any in-flight Type A task is running in this browser tab. */
  hasPendingTasks: boolean;
  /** Count of pending tasks (drives the close-panel confirm message). */
  pendingTaskCount: number;

  /** Apply select / dimensions changes into the overlay (not Yjs). */
  applyLocalNodeChanges: (changes: NodeChange[]) => void;
  /**
   * Patch a node's UI-only `data` overlay (e.g. `pickState`). Values
   * of `null`/`undefined` clear the corresponding overlay key.
   * Collaborators never see these writes.
   */
  setNodeLocalData: (nodeId: string, patch: Record<string, unknown>) => void;
  /** Drop an entire node's overlay (used on node deletion). */
  clearNodeLocalState: (nodeId: string) => void;
  /**
   * Toggle per-node `draggable` locally. Consumed by ReactFlow via the
   * overlay merge. `null`/`undefined` clears the overlay (ReactFlow
   * default: draggable).
   */
  setNodeDraggable: (nodeId: string, draggable: boolean | null) => void;
  /**
   * Set per-node `zIndex` locally. Each client maintains its own
   * stacking order; z changes never replicate to collaborators.
   */
  setNodeZIndex: (nodeId: string, zIndex: number) => void;
  /**
   * Current maximum `zIndex` across merged nodes (Yjs base + pending +
   * overlay), or `0` if no node has one. Used by new-node paths to
   * compute `maxZ + 1` locally without reaching into Yjs.
   */
  getMaxZIndex: () => number;

  // ── Pending tasks (X pattern for Type A) ──
  /** Register a browser-local pending task — shows a loading tile locally only. */
  addPendingTask: (node: Node) => void;
  /** Drop a pending task without materialising it (failure path). */
  removePendingTask: (nodeId: string) => void;
  /**
   * Read a pending task entry. Caller uses this to snapshot the
   * pending node's data before merging a completion patch.
   */
  getPendingTask: (nodeId: string) => PendingTaskEntry | undefined;
}

const MixedEditorDataContext = createContext<MixedEditorDataContextValue | null>(null);

interface MixedEditorDataProviderProps {
  manager: YjsNodeEditorManager | null;
  /** Main canvas host node id. Undefined when no mixed editor panel is open. */
  hostNodeId?: string;
  children: ReactNode;
}

export function MixedEditorDataProvider({
  manager,
  hostNodeId,
  children,
}: MixedEditorDataProviderProps) {
  const { nodes: yjsNodes, edges, loading, syncError } = useMixedEditorYjsInternal(manager);

  // Local overlay for UI-only state (select, dimensions, pickState).
  // Keyed by node id; survives as long as the provider is mounted.
  const [overlay, setOverlay] = useState<Map<string, MixedEditorNodeLocalState>>(new Map());

  // Pending tasks — X pattern for Type A. Keyed by node id.
  // A ref mirror keeps non-React consumers (action callbacks) reading
  // the latest value synchronously without waiting for a re-render.
  const [pendingTasks, setPendingTasks] = useState<Map<string, PendingTaskEntry>>(new Map());
  const pendingTasksRef = useRef(pendingTasks);
  useEffect(() => {
    pendingTasksRef.current = pendingTasks;
  }, [pendingTasks]);

  // When the host node swaps or the provider unmounts, drop every
  // in-flight pending task. The browser Worker dies with the panel
  // anyway (see § X pattern docs above) — we just make sure the UI
  // doesn't flash stale loading tiles when the user re-opens.
  useEffect(() => {
    return () => {
      setPendingTasks(new Map());
    };
  }, [manager]);

  const applyLocalNodeChanges = useCallback((changes: NodeChange[]) => {
    setOverlay((prev) => {
      const next = new Map(prev);
      let changed = false;
      for (const change of changes) {
        if (change.type === 'select') {
          const existing = next.get(change.id);
          if (existing?.selected !== change.selected) {
            next.set(change.id, { ...existing, selected: change.selected });
            changed = true;
          }
        } else if (change.type === 'dimensions' && change.dimensions) {
          const existing = next.get(change.id);
          const prevMeasured = existing?.measured;
          if (prevMeasured?.width !== change.dimensions.width || prevMeasured?.height !== change.dimensions.height) {
            next.set(change.id, {
              ...existing,
              measured: { width: change.dimensions.width, height: change.dimensions.height },
            });
            changed = true;
          }
        }
      }
      return changed ? next : prev;
    });
  }, []);

  const setNodeLocalData = useCallback((nodeId: string, patch: Record<string, unknown>) => {
    setOverlay((prev) => {
      const next = new Map(prev);
      const existing = next.get(nodeId);
      const prevOverlayData = existing?.dataOverlay ?? {};
      const newOverlayData: Record<string, unknown> = { ...prevOverlayData };
      for (const [k, v] of Object.entries(patch)) {
        if (v == null) {
          delete newOverlayData[k];
        } else {
          newOverlayData[k] = v;
        }
      }
      const dataOverlay = Object.keys(newOverlayData).length > 0 ? newOverlayData : undefined;
      next.set(nodeId, { ...existing, dataOverlay });
      return next;
    });
  }, []);

  const clearNodeLocalState = useCallback((nodeId: string) => {
    setOverlay((prev) => {
      if (!prev.has(nodeId)) return prev;
      const next = new Map(prev);
      next.delete(nodeId);
      return next;
    });
  }, []);

  const setNodeDraggable = useCallback((nodeId: string, draggable: boolean | null) => {
    setOverlay((prev) => {
      const existing = prev.get(nodeId);
      const currentDraggable = existing?.draggable;
      if (draggable == null) {
        if (currentDraggable === undefined) return prev;
        const next = new Map(prev);
        const { draggable: _drop, ...rest } = existing ?? {};
        void _drop;
        if (Object.keys(rest).length === 0) {
          next.delete(nodeId);
        } else {
          next.set(nodeId, rest);
        }
        return next;
      }
      if (currentDraggable === draggable) return prev;
      const next = new Map(prev);
      next.set(nodeId, { ...existing, draggable });
      return next;
    });
  }, []);

  const setNodeZIndex = useCallback((nodeId: string, zIndex: number) => {
    setOverlay((prev) => {
      const existing = prev.get(nodeId);
      if (existing?.zIndex === zIndex) return prev;
      const next = new Map(prev);
      next.set(nodeId, { ...existing, zIndex });
      return next;
    });
  }, []);

  const addPendingTask = useCallback((node: Node) => {
    setPendingTasks((prev) => {
      const next = new Map(prev);
      next.set(node.id, { node, startedAt: Date.now() });
      return next;
    });
  }, []);

  const removePendingTask = useCallback((nodeId: string) => {
    setPendingTasks((prev) => {
      if (!prev.has(nodeId)) return prev;
      const next = new Map(prev);
      next.delete(nodeId);
      return next;
    });
  }, []);

  const getPendingTask = useCallback(
    (nodeId: string): PendingTaskEntry | undefined => pendingTasksRef.current.get(nodeId),
    [],
  );

  // Merge Yjs nodes + pending tasks + overlay.
  //
  // Order: pending tiles appear AFTER Yjs nodes so they render on top
  // if positions overlap (user just spawned them; they want them
  // visible). pendingTasks entries with the same id as a Yjs node
  // (shouldn't happen once resolved correctly, but defensively) are
  // dropped — Yjs wins.
  const nodes = useMemo(() => {
    const yjsIds = new Set(yjsNodes.map((n) => n.id));
    const result: Node[] = [];
    const applyOverlay = (base: Node, o: MixedEditorNodeLocalState | undefined): Node => {
      if (!o) return base;
      const merged: Node = { ...base };
      if (o.selected != null) merged.selected = o.selected;
      if (o.measured) merged.measured = o.measured;
      if (o.draggable != null) merged.draggable = o.draggable;
      if (o.zIndex != null) (merged as Node & { zIndex?: number }).zIndex = o.zIndex;
      if (o.dataOverlay) {
        merged.data = { ...(base.data ?? {}), ...o.dataOverlay };
      }
      return merged;
    };
    for (const n of yjsNodes) {
      result.push(applyOverlay(n, overlay.get(n.id)));
    }
    pendingTasks.forEach((entry) => {
      if (yjsIds.has(entry.node.id)) return; // Yjs wins if both present
      result.push(applyOverlay(entry.node, overlay.get(entry.node.id)));
    });
    return result;
  }, [yjsNodes, pendingTasks, overlay]);

  // Mirror `nodes` so async callers (action hook's new-node paths)
  // can snapshot latest merged state without waiting for a re-render.
  const nodesRef = useRef<Node[]>(nodes);
  useEffect(() => {
    nodesRef.current = nodes;
  }, [nodes]);

  const getMaxZIndex = useCallback((): number => {
    let max = 0;
    for (const n of nodesRef.current) {
      const z = (n as Node & { zIndex?: number }).zIndex;
      if (typeof z === 'number' && z > max) max = z;
    }
    return max;
  }, []);

  const nodesById = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);

  const selectedNodeId = useMemo(() => {
    for (const n of nodes) {
      if (n.selected) return n.id;
    }
    return null;
  }, [nodes]);

  const hostNodeIdValue = hostNodeId ?? null;
  const pendingTaskCount = pendingTasks.size;
  const hasPendingTasks = pendingTaskCount > 0;

  const value = useMemo<MixedEditorDataContextValue>(
    () => ({
      manager,
      hostNodeId: hostNodeIdValue,
      nodes,
      edges,
      nodesById,
      selectedNodeId,
      loading,
      syncError,
      hasPendingTasks,
      pendingTaskCount,
      applyLocalNodeChanges,
      setNodeLocalData,
      clearNodeLocalState,
      setNodeDraggable,
      setNodeZIndex,
      getMaxZIndex,
      addPendingTask,
      removePendingTask,
      getPendingTask,
    }),
    [
      manager,
      hostNodeIdValue,
      nodes,
      edges,
      nodesById,
      selectedNodeId,
      loading,
      syncError,
      hasPendingTasks,
      pendingTaskCount,
      applyLocalNodeChanges,
      setNodeLocalData,
      clearNodeLocalState,
      setNodeDraggable,
      setNodeZIndex,
      getMaxZIndex,
      addPendingTask,
      removePendingTask,
      getPendingTask,
    ],
  );

  return (
    <MixedEditorDataContext.Provider value={value}>
      {children}
    </MixedEditorDataContext.Provider>
  );
}

/** Read mixed editor state from the nearest {@link MixedEditorDataProvider}. */
export function useMixedEditorData(): MixedEditorDataContextValue {
  const ctx = useContext(MixedEditorDataContext);
  if (!ctx) {
    throw new Error('useMixedEditorData must be used within a MixedEditorDataProvider');
  }
  return ctx;
}

/**
 * Shared internal accessor for non-hook consumers (e.g.
 * `useMixedEditorActions` reaches in for the manager + overlay setters).
 * Exported separately so `useMixedEditorData` can keep a narrow read
 * API while writers get the full bundle.
 */
export function useMixedEditorDataInternal(): MixedEditorDataContextValue {
  return useMixedEditorData();
}
