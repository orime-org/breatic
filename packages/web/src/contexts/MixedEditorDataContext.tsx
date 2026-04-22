/**
 * Mixed editor data + runtime context — read layer between the
 * per-node editor Y.Doc and React components, plus the manager handle
 * and UI-only overlay state (select, dimensions, pickState).
 *
 * Mirrors the main canvas' {@link CanvasDataContext} but additionally
 * owns the overlay so that `useMixedEditorActions` can route pickState
 * writes to component-local state instead of Yjs — pickState is a
 * per-user UI mode (image cropping / compose region picking) and must
 * not replicate to collaborators.
 *
 * ```
 * Yjs node editor Y.Doc (source of truth)
 *   ↓  useMixedEditorYjsInternal (incremental observe of `flow` Y.Map)
 * MixedEditorDataContext (read cache + local overlay + manager)
 *   ↓  useMixedEditorData()      ← read
 *   ↓  useMixedEditorActions()   ← write (reaches manager via context)
 * MixedEditor ReactFlow / toolbar / Apply button
 * ```
 */

import {
  createContext,
  useContext,
  useMemo,
  useState,
  useCallback,
  type ReactNode,
} from 'react';
import type { Node, Edge, NodeChange } from '@xyflow/react';
import type { YjsNodeEditorManager } from '@/utils/yjsNodeEditorManager';
import { useMixedEditorYjsInternal } from '@/hooks/useMixedEditorYjsInternal';

/** Per-node UI-only overlay merged on top of the Yjs-authoritative node. */
export interface MixedEditorNodeLocalState {
  selected?: boolean;
  measured?: { width: number; height: number };
  /** Anything under `data.*` that should NOT replicate via Yjs (pickState, other ephemeral UI). */
  dataOverlay?: Record<string, unknown>;
}

export interface MixedEditorDataContextValue {
  /** The Yjs node editor manager backing this editor (null while connecting). */
  manager: YjsNodeEditorManager | null;

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
}

const MixedEditorDataContext = createContext<MixedEditorDataContextValue | null>(null);

interface MixedEditorDataProviderProps {
  manager: YjsNodeEditorManager | null;
  children: ReactNode;
}

export function MixedEditorDataProvider({ manager, children }: MixedEditorDataProviderProps) {
  const { nodes: yjsNodes, edges, loading, syncError } = useMixedEditorYjsInternal(manager);

  // Local overlay for UI-only state (select, dimensions, pickState).
  // Keyed by node id; survives as long as the provider is mounted.
  const [overlay, setOverlay] = useState<Map<string, MixedEditorNodeLocalState>>(new Map());

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

  // Merge Yjs nodes with overlay
  const nodes = useMemo(() => {
    if (overlay.size === 0) return yjsNodes;
    return yjsNodes.map((node) => {
      const o = overlay.get(node.id);
      if (!o) return node;
      const merged: Node = { ...node };
      if (o.selected != null) merged.selected = o.selected;
      if (o.measured) merged.measured = o.measured;
      if (o.dataOverlay) {
        merged.data = { ...(node.data ?? {}), ...o.dataOverlay };
      }
      return merged;
    });
  }, [yjsNodes, overlay]);

  const nodesById = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);

  const selectedNodeId = useMemo(() => {
    for (const n of nodes) {
      if (n.selected) return n.id;
    }
    return null;
  }, [nodes]);

  const value = useMemo<MixedEditorDataContextValue>(
    () => ({
      manager,
      nodes,
      edges,
      nodesById,
      selectedNodeId,
      loading,
      syncError,
      applyLocalNodeChanges,
      setNodeLocalData,
      clearNodeLocalState,
    }),
    [manager, nodes, edges, nodesById, selectedNodeId, loading, syncError, applyLocalNodeChanges, setNodeLocalData, clearNodeLocalState],
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
