// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import * as React from 'react';
import * as Y from 'yjs';
import type { CanvasNodeFields, NodeType } from '@breatic/shared';

import { docName, getDoc } from '@web/data/yjs/manager';
import type { NodeKind, NodeView } from '@web/spaces/canvas/types/node-view';
import { toNodeView } from '@web/spaces/canvas/types/node-view';

/**
 * Canvas-space Yjs document — single source of truth for one canvas
 * space's nodes + edges.
 *
 * Wire layout (aligned with the backend — see collab `task-listener.ts`
 * and the shared `CanvasNodeFields` contract):
 *   - top-level `Y.Map("nodesMap")` of node `Y.Map`s. Each node Y.Map has
 *     `{ id, type, position, data }` where **`data` is itself a Y.Map**
 *     holding the `CanvasNodeFields['data']` fields.
 *   - top-level `Y.Map("edgesMap")` of edge `Y.Map`s.
 *
 * The nested `data` Y.Map is load-bearing: collab's task-listener reaches
 * `nodesMap.get(nodeId).get("data")` and asserts `instanceof Y.Map` before
 * writing the worker's result back. A plain object there (the pre-#1269
 * frontend bug) is silently skipped, so results never reach the canvas.
 *
 * Frontend owns node create / delete / position + edges. Backend (Worker
 * via Collab) only sets state fields inside the node's `data` Y.Map.
 *
 * Read side projects each wire node through `toNodeView`, returning
 * ReactFlow-ready `CanvasNodeView`s (only nodes with a dirty / unknown
 * `type` or a missing `data` Y.Map are skipped).
 */

/** A render-ready canvas node: identity + position + the narrowed view. */
export interface CanvasNodeView {
  id: string;
  /** ReactFlow node type = the view kind (the `NODE_TYPES` registry key). */
  type: NodeKind;
  position: { x: number; y: number };
  /**
   * Containing Group id (group redesign 2026-06-23) — present on a member
   * node so `toFlowNode` can hand ReactFlow a parented node. Absent for
   * top-level nodes.
   */
  parentId?: string;
  data: NodeView;
}

/**
 * A canvas connection. Its data meaning IS a reference relationship: an edge
 * `source → target` means `source` is a reference input for `target`'s
 * generation. (The former `kind: 'primary' | 'reference'` discriminant was
 * removed — every connection is a reference; there is no other edge kind.)
 * `toolId` is optional lineage metadata stamped by a mini-tool that created
 * the target node.
 */
export interface CanvasEdge {
  id: string;
  source: string;
  target: string;
  toolId?: string;
  /**
   * Epoch ms when the connection was drawn (stamped by {@link addEdge}). The
   * reference rail orders rows by it — Y.Map iteration is struct-store order
   * (clientID + clock), which diverges from insertion order after reload /
   * cross-client sync. Absent on legacy edges, which sort as oldest.
   */
  createdAt?: number;
}

interface CanvasSpaceState {
  nodes: ReadonlyArray<CanvasNodeView>;
  edges: ReadonlyArray<CanvasEdge>;
  /** Undo the last tracked structural / metadata / name edit by this client. */
  undo: () => void;
  /** Redo the last undone edit by this client. */
  redo: () => void;
  /** Whether an undo is currently available (drives the toolbar button). */
  canUndo: boolean;
  /** Whether a redo is currently available (drives the toolbar button). */
  canRedo: boolean;
}

const NODES_KEY = 'nodesMap';
const EDGES_KEY = 'edgesMap';

/**
 * Tracked transaction origin for canvas undo. Every frontend structural /
 * metadata / name write below runs in `doc.transact(fn, CANVAS_UNDO)` so the
 * per-space `Y.UndoManager` captures it. Backend content writes use a
 * different origin (`'node-state-update'`, see collab `task-listener`) and so
 * are naturally excluded from the undo stack.
 */
export const CANVAS_UNDO = Symbol('canvas-undo');

/**
 * Origin for frontend content writes (upload completion / failure). Excluded
 * from the undo manager's `trackedOrigins` so a content arrival does NOT enter
 * the undo stack (spec §5: node content is NOT canvas-undo-tracked). Undoing an
 * upload removes the node itself (its `addNode` IS tracked), and never strands
 * it back in `handling` with no content — the stuck-skeleton bug (#8).
 */
export const CONTENT_WRITE = Symbol('content-write');

/** Max canvas undo stack depth — oldest entries are dropped past this. */
export const MAX_UNDO_DEPTH = 50;

/**
 * Create a per-space canvas undo manager scoped to the node + edge maps.
 * Captures only `CANVAS_UNDO`-origin transactions (this client's own
 * structural / metadata / name edits); remote collaborator writes carry the
 * sync provider as origin and are excluded, so undo is per-client.
 *
 * `captureTimeout: 0` disables time-based merging so two unrelated actions
 * never collapse into one undo step. A single drag gesture can still emit
 * several writes (a position change PLUS a group-membership change, across N
 * marquee-dragged nodes), so the canvas commits a whole drag-stop inside one
 * {@link runCanvasUndoBatch} transaction — one gesture stays one atomic undo
 * entry. Without that, `captureTimeout: 0` split a drag-out into separate
 * "move" + "dissolve" steps, and undoing restored the group before the
 * member's position reverted → a phantom oversized empty group.
 *
 * The stack is capped at {@link MAX_UNDO_DEPTH} by trimming the oldest in
 * place on each push (Y.UndoManager has no native maxDepth). The dropped
 * tail's `keepItem` flags are not released (no public API) — a bounded,
 * accepted leak (design doc §3 / §9.1, decision B.1).
 * @param doc - The canvas-space Y.Doc whose nodes + edges to track.
 * @returns A Y.UndoManager bound to the doc's node and edge maps.
 */
export function createCanvasUndoManager(doc: Y.Doc): Y.UndoManager {
  const nodesMap = doc.getMap<Y.Map<unknown>>(NODES_KEY);
  const edgesMap = doc.getMap<Y.Map<unknown>>(EDGES_KEY);
  const undoManager = new Y.UndoManager([nodesMap, edgesMap], {
    trackedOrigins: new Set([CANVAS_UNDO]),
    captureTimeout: 0,
  });
  undoManager.on('stack-item-added', () => {
    while (undoManager.undoStack.length > MAX_UNDO_DEPTH) {
      undoManager.undoStack.shift();
    }
  });
  return undoManager;
}

/**
 * Process-wide cache of canvas undo managers, keyed by canvas-space document
 * name. The undo stack lives only in the manager instance's memory (it is NOT
 * persisted in the Y.Doc), so to survive a tab switch — which remounts the
 * `SpaceOutlet` via `key={activeSpace.id}` and thus remounts `useCanvasSpace` —
 * the manager must outlive the component. Binding it to the space DOC (same
 * lifetime as `getDoc`'s cached Y.Doc) rather than the React component is the
 * fix: switching tabs re-fetches the same manager with its stack intact;
 * closing a tab evicts it ({@link evictCanvasUndoManager}) so a reopened space
 * starts with a clean, empty history.
 */
const undoManagers = new Map<string, Y.UndoManager>();

/**
 * Get-or-create the cached canvas undo manager for a space document. The first
 * call for a name creates one bound to that doc; subsequent calls return the
 * same instance (so its undo stack survives tab switches). Pass the SAME `doc`
 * that `getDoc(name)` returns — the manager observes that doc instance.
 * @param doc - The canvas-space Y.Doc to bind a newly created manager to.
 * @param name - The canonical canvas-space document name (cache key).
 * @returns The cached (or newly created) undo manager for that space doc.
 */
export function getCanvasUndoManager(doc: Y.Doc, name: string): Y.UndoManager {
  let manager = undoManagers.get(name);
  // Heal a stale binding: if the cached manager was created for a different
  // (now-recreated) doc instance, it observes a dead doc. Rebind to the live
  // one. Guards against a future `destroyDoc` caller that forgets to evict.
  if (manager && manager.doc !== doc) {
    manager.destroy();
    manager = undefined;
  }
  if (!manager) {
    manager = createCanvasUndoManager(doc);
    undoManagers.set(name, manager);
  }
  return manager;
}

/**
 * Evict (destroy + drop) the cached undo manager for a space document. Called
 * when a tab CLOSES (`ProjectPage`'s `onCloseTab`) so the space's undo / redo
 * history is cleared — reopening that space then get-or-creates a fresh, empty
 * manager. No-op for an unknown name (e.g. a non-canvas space or one never
 * opened). The space's Y.Doc itself is left in `manager.ts`'s cache untouched,
 * so reopening the tab is still instant (no re-handshake).
 * @param name - The canonical canvas-space document name to evict.
 */
export function evictCanvasUndoManager(name: string): void {
  const manager = undoManagers.get(name);
  if (!manager) return;
  manager.destroy();
  undoManagers.delete(name);
}

/**
 * Evict undo managers for open tabs whose space no longer exists. A space
 * leaves the user's open tabs two ways: an explicit tab close (handled by
 * `ProjectPage.onCloseTab` → {@link evictCanvasUndoManager}) OR a deletion —
 * local or by a collaborator — which drops the tab via ProjectPage's `openTabs`
 * filter WITHOUT a close call. This reconcile covers the deletion path so
 * "the space left the user → its undo history is cleared" holds for BOTH paths,
 * preventing a leaked manager and a stale pre-delete undo stack resurfacing if
 * the space is restored under the same id. Idempotent (evict is a no-op once
 * gone). Safe to run on the active just-deleted space: ProjectPage recomputes
 * `activeSpace` in the same render, so that space's `useCanvasSpace` has already
 * unmounted (and nulled its manager ref) before this effect runs.
 * @param projectId - Project the open tabs belong to.
 * @param openTabIds - This user's open-tab space ids.
 * @param liveSpaceIds - The set of space ids that still exist in the project.
 */
export function evictUndoForVanishedSpaces(
  projectId: string,
  openTabIds: ReadonlyArray<string>,
  liveSpaceIds: ReadonlySet<string>,
): void {
  for (const id of openTabIds) {
    if (!liveSpaceIds.has(id)) {
      evictCanvasUndoManager(docName.canvasSpace(projectId, id));
    }
  }
}

/** Reset the undo-manager cache (test helper — not for production use). */
export function _resetCanvasUndoCacheForTests(): void {
  undoManagers.forEach((m) => m.destroy());
  undoManagers.clear();
}

/**
 * Commit several canvas mutations as ONE atomic undo entry — frontend-owned.
 * Each individual binding (`setNodePosition`, `moveGroup`, `removeFromGroup`,
 * …) opens its own `CANVAS_UNDO` transaction; Yjs nests a transaction opened
 * while one is already active into the outer one, so calling them inside this
 * outer `doc.transact(fn, CANVAS_UNDO)` collapses every write into a single
 * undo step. The whole-gesture wrapper a drag-stop needs: one drag = one undo,
 * even when it moves N nodes and changes group membership (see
 * {@link createCanvasUndoManager} for why `captureTimeout: 0` makes this
 * explicit batching necessary).
 * @param projectId - Project the canvas space belongs to.
 * @param spaceId - Canvas space whose doc to mutate.
 * @param fn - Runs the individual mutations; their writes join this one transaction.
 */
export function runCanvasUndoBatch(
  projectId: string,
  spaceId: string,
  fn: () => void,
): void {
  const doc = getDoc(docName.canvasSpace(projectId, spaceId));
  doc.transact(fn, CANVAS_UNDO);
}

/**
 * Subscribe to a canvas-space document. Observes the cached Y.Doc only — the
 * document is kept attached to the shared collab socket by its open tab's
 * `SpaceDocSync`, so this hook never opens its own connection (attach follows
 * tab open / close, not the active render).
 * @param projectId - Project the canvas space belongs to.
 * @param spaceId - Canvas space whose nodes and edges to observe.
 * @returns The current nodes, edges, and per-space undo controls.
 */
export function useCanvasSpace(
  projectId: string,
  spaceId: string,
): CanvasSpaceState {
  const name = docName.canvasSpace(projectId, spaceId);
  const doc = React.useMemo(() => getDoc(name), [name]);
  const [nodes, setNodes] = React.useState<ReadonlyArray<CanvasNodeView>>(() =>
    readNodes(doc),
  );
  const [edges, setEdges] = React.useState<ReadonlyArray<CanvasEdge>>(() =>
    readEdges(doc),
  );

  React.useEffect(() => {
    const nodesMap = doc.getMap<Y.Map<unknown>>(NODES_KEY);
    const edgesMap = doc.getMap<Y.Map<unknown>>(EDGES_KEY);
    /**
     * Re-read all nodes from the doc into React state.
     * @returns Nothing.
     */
    const updateNodes = (): void => setNodes(readNodes(doc));
    /**
     * Re-read all edges from the doc into React state.
     * @returns Nothing.
     */
    const updateEdges = (): void => setEdges(readEdges(doc));
    nodesMap.observeDeep(updateNodes);
    edgesMap.observeDeep(updateEdges);
    updateNodes();
    updateEdges();
    return () => {
      nodesMap.unobserveDeep(updateNodes);
      edgesMap.unobserveDeep(updateEdges);
    };
  }, [doc]);

  // Per-space undo manager, fetched from the doc-keyed cache (NOT created +
  // destroyed with this component). The cache binds the manager's lifetime to
  // the space DOC, so a tab switch — which remounts this hook via
  // `key={activeSpace.id}` — re-fetches the SAME manager with its undo stack
  // intact (the cross-space-preservation fix). Closing the tab evicts it
  // (`ProjectPage.onCloseTab` → `evictCanvasUndoManager`) so a reopened space
  // starts empty; a page refresh is a new JS context so the cache is empty by
  // construction. This effect only attaches / detaches the availability
  // listeners — it must NOT destroy the manager on unmount. `canUndo` /
  // `canRedo` are mirrored into React state both from the manager's stack
  // events AND imperatively after each undo / redo — see `syncAvailability`
  // for why the events alone are not enough.
  const undoManagerRef = React.useRef<Y.UndoManager | null>(null);
  const [canUndo, setCanUndo] = React.useState(false);
  const [canRedo, setCanRedo] = React.useState(false);

  // Mirror the manager's undo / redo availability into React state. Called
  // from the manager's stack events AND directly after every undo() / redo().
  // The latter is load-bearing: yjs's undo()/redo() can DRAIN "dead" stack
  // items (whose target node / edge a collaborator deleted) without emitting
  // any 'stack-item-popped' event — popStackItem pops them but, since undoing
  // a remotely-deleted item performs no change, never reports a popped item.
  // An events-only mirror would then go stale (button stuck enabled, clickable
  // forever). Re-reading after the call reflects the now-drained stack.
  const syncAvailability = React.useCallback((): void => {
    const manager = undoManagerRef.current;
    setCanUndo(manager ? manager.canUndo() : false);
    setCanRedo(manager ? manager.canRedo() : false);
  }, []);

  React.useEffect(() => {
    const undoManager = getCanvasUndoManager(doc, name);
    undoManagerRef.current = undoManager;
    undoManager.on('stack-item-added', syncAvailability);
    undoManager.on('stack-item-popped', syncAvailability);
    undoManager.on('stack-cleared', syncAvailability);
    syncAvailability();
    return () => {
      // Detach this component's listeners but DO NOT destroy the manager — it
      // is owned by the doc-keyed cache and must outlive this remount so the
      // undo stack survives a tab switch. Eviction happens on tab close.
      undoManager.off('stack-item-added', syncAvailability);
      undoManager.off('stack-item-popped', syncAvailability);
      undoManager.off('stack-cleared', syncAvailability);
      undoManagerRef.current = null;
    };
  }, [doc, name, syncAvailability]);

  const undo = React.useCallback((): void => {
    undoManagerRef.current?.undo();
    syncAvailability();
  }, [syncAvailability]);
  const redo = React.useCallback((): void => {
    undoManagerRef.current?.redo();
    syncAvailability();
  }, [syncAvailability]);

  return { nodes, edges, undo, redo, canUndo, canRedo };
}

/**
 * Build the nested `data` Y.Map for a node from a plain wire data object.
 * Each defined field becomes a Y.Map entry (plain values — strings,
 * numbers, booleans, plain arrays / objects — matching how the backend
 * reads `operationLocks` via `Array.isArray` and `handlingBy` as a plain
 * object). Undefined fields are omitted.
 * @param data - The plain wire data fields to write.
 * @returns A Y.Map populated with the defined data fields.
 */
function buildDataMap(data: CanvasNodeFields['data']): Y.Map<unknown> {
  const map = new Y.Map<unknown>();
  for (const [key, value] of Object.entries(data)) {
    if (value !== undefined) map.set(key, value);
  }
  return map;
}

/**
 * Add a node — frontend-owned operation. Stores the wire `CanvasNodeFields`
 * shape (a node Y.Map with a nested `data` Y.Map) under `nodesMap`.
 * @param projectId - Project the canvas space belongs to.
 * @param spaceId - Canvas space to add the node to.
 * @param node - The wire node fields (id, type, position, data) to insert.
 */
export function addNode(
  projectId: string,
  spaceId: string,
  node: CanvasNodeFields,
): void {
  const doc = getDoc(docName.canvasSpace(projectId, spaceId));
  const nodesMap = doc.getMap<Y.Map<unknown>>(NODES_KEY);
  doc.transact(() => {
    const map = new Y.Map<unknown>();
    map.set('id', node.id);
    map.set('type', node.type);
    // Group containment: persist the member→Group link as a top-level field
    // (alongside position), only when set so top-level nodes carry no key.
    if (node.parentId !== undefined) map.set('parentId', node.parentId);
    map.set('position', node.position);
    map.set('data', buildDataMap(node.data));
    nodesMap.set(node.id, map);
  }, CANVAS_UNDO);
}

/**
 * Within an open transaction, release a Group's members before it is deleted:
 * clear each member's `parentId` and convert its parent-relative position back
 * to absolute. Deleting a Group never deletes its members — they become
 * top-level nodes. No-op when the group has no resolvable position.
 * @param nodesMap - The canvas-space `nodesMap` (call inside a transaction).
 * @param groupId - The Group node being deleted.
 */
function releaseGroupMembers(
  nodesMap: Y.Map<Y.Map<unknown>>,
  groupId: string,
): void {
  const group = nodesMap.get(groupId);
  if (!(group instanceof Y.Map)) return;
  const groupPos = group.get('position') as { x: number; y: number } | undefined;
  nodesMap.forEach((node) => {
    if (!(node instanceof Y.Map) || node.get('parentId') !== groupId) return;
    if (groupPos) {
      const p = node.get('position') as { x: number; y: number } | undefined;
      if (p) node.set('position', { x: p.x + groupPos.x, y: p.y + groupPos.y });
    }
    node.delete('parentId');
  });
}

/**
 * Delete a node by id — frontend-owned operation. Deleting a Group (group)
 * first releases its members (clears `parentId`, restores absolute position) so
 * they survive as top-level nodes (the canvas-level "delete group" cascade that
 * removes the members too is a separate, higher-level action).
 * @param projectId - Project the canvas space belongs to.
 * @param spaceId - Canvas space to remove the node from.
 * @param nodeId - Id of the node to delete.
 */
export function removeNode(
  projectId: string,
  spaceId: string,
  nodeId: string,
): void {
  const doc = getDoc(docName.canvasSpace(projectId, spaceId));
  const nodesMap = doc.getMap<Y.Map<unknown>>(NODES_KEY);
  doc.transact(() => {
    const node = nodesMap.get(nodeId);
    if (node instanceof Y.Map && node.get('type') === 'group') {
      releaseGroupMembers(nodesMap, nodeId);
    }
    nodesMap.delete(nodeId);
  }, CANVAS_UNDO);
}

/**
 * Update node position (drag end) — frontend-owned operation.
 * @param projectId - Project the canvas space belongs to.
 * @param spaceId - Canvas space containing the node.
 * @param nodeId - Id of the node to reposition.
 * @param position - The node's new canvas coordinates.
 * @param position.x - New x coordinate.
 * @param position.y - New y coordinate.
 */
export function setNodePosition(
  projectId: string,
  spaceId: string,
  nodeId: string,
  position: { x: number; y: number },
): void {
  const doc = getDoc(docName.canvasSpace(projectId, spaceId));
  const nodesMap = doc.getMap<Y.Map<unknown>>(NODES_KEY);
  const node = nodesMap.get(nodeId);
  if (!node) return;
  doc.transact(() => node.set('position', position), CANVAS_UNDO);
}

/**
 * Rename a node (name-header edit) — frontend-owned operation. Writes into
 * the nested `data` Y.Map so the change merges field-wise with concurrent
 * collaborator / backend writes.
 * @param projectId - Project the canvas space belongs to.
 * @param spaceId - Canvas space containing the node.
 * @param nodeId - Id of the node to rename.
 * @param name - The node's new display name.
 */
export function setNodeName(
  projectId: string,
  spaceId: string,
  nodeId: string,
  name: string,
): void {
  const doc = getDoc(docName.canvasSpace(projectId, spaceId));
  const nodesMap = doc.getMap<Y.Map<unknown>>(NODES_KEY);
  const node = nodesMap.get(nodeId);
  if (!node) return;
  const data = node.get('data');
  if (!(data instanceof Y.Map)) return;
  doc.transact(() => data.set('name', name), CANVAS_UNDO);
}

/**
 * Lock / unlock a node — frontend-owned operation. Writes into the nested
 * `data` Y.Map so the flag merges field-wise with concurrent collaborator /
 * backend writes.
 * @param projectId - Project the canvas space belongs to.
 * @param spaceId - Canvas space containing the node.
 * @param nodeId - Id of the node to lock / unlock.
 * @param locked - The node's new lock state.
 */
export function setNodeLocked(
  projectId: string,
  spaceId: string,
  nodeId: string,
  locked: boolean,
): void {
  const doc = getDoc(docName.canvasSpace(projectId, spaceId));
  const nodesMap = doc.getMap<Y.Map<unknown>>(NODES_KEY);
  const node = nodesMap.get(nodeId);
  if (!node) return;
  const data = node.get('data');
  if (!(data instanceof Y.Map)) return;
  doc.transact(() => data.set('locked', locked), CANVAS_UNDO);
}

/**
 * Set a content node's Generate model params (aspect ratio, resolution, …).
 * Written as a whole plain object into the nested `data` Y.Map — a scalar,
 * last-write-wins field (concurrent param edits replace the whole object; an
 * acceptable trade-off for these low-frequency picks). Frontend-owned.
 * @param projectId - Project the canvas space belongs to.
 * @param spaceId - Canvas space containing the node.
 * @param nodeId - Id of the node whose params to set.
 * @param params - The model-specific params object.
 */
export function setNodeParams(
  projectId: string,
  spaceId: string,
  nodeId: string,
  params: Record<string, unknown>,
): void {
  const doc = getDoc(docName.canvasSpace(projectId, spaceId));
  const nodesMap = doc.getMap<Y.Map<unknown>>(NODES_KEY);
  const node = nodesMap.get(nodeId);
  if (!node) return;
  const data = node.get('data');
  if (!(data instanceof Y.Map)) return;
  doc.transact(() => data.set('params', params), CANVAS_UNDO);
}

/**
 * Switch a content node's Generate model, writing the new model id, the
 * reconciled params, AND recording it as the active mode's remembered model —
 * all in ONE transaction so collaborators never observe a torn state.
 * `modelByMode` is a whole-object last-write-wins field (like `params`): the
 * user picking a model in mode `mode` stores `modelByMode[mode] = model`, so a
 * later toggle back to that mode restores it (see {@link setNodeMode}).
 * Frontend-owned.
 * @param projectId - Project the canvas space belongs to.
 * @param spaceId - Canvas space containing the node.
 * @param nodeId - Id of the node whose model to switch.
 * @param mode - The active generation sub-mode this pick belongs to (e.g. 't2i').
 * @param model - The new model id.
 * @param params - The params reconciled for the new model (see resolveParamsForModel).
 */
export function setNodeModel(
  projectId: string,
  spaceId: string,
  nodeId: string,
  mode: string,
  model: string,
  params: Record<string, unknown>,
): void {
  const doc = getDoc(docName.canvasSpace(projectId, spaceId));
  const nodesMap = doc.getMap<Y.Map<unknown>>(NODES_KEY);
  const node = nodesMap.get(nodeId);
  if (!node) return;
  const data = node.get('data');
  if (!(data instanceof Y.Map)) return;
  doc.transact(() => {
    data.set('model', model);
    data.set('params', params);
    const prev = data.get('modelByMode');
    const base =
      prev != null && typeof prev === 'object'
        ? (prev as Record<string, string>)
        : {};
    data.set('modelByMode', { ...base, [mode]: model });
  }, CANVAS_UNDO);
}

/**
 * Switch a content node's generation sub-mode (the manual t2i / i2i toggle),
 * writing the new `mode` together with the model + params resolved for that
 * mode — all in ONE transaction so collaborators never see the new mode paired
 * with the old mode's model. The caller resolves `model` (the mode's remembered
 * pick via `modelByMode`, else the first available — see resolveModelForMode)
 * and reconciles `params` before calling. Does NOT touch `modelByMode`: a
 * toggle is not an explicit pick, so only {@link setNodeModel} records the
 * per-mode memory. Frontend-owned.
 * @param projectId - Project the canvas space belongs to.
 * @param spaceId - Canvas space containing the node.
 * @param nodeId - Id of the node whose mode to switch.
 * @param mode - The new generation sub-mode (e.g. 't2i' / 'i2i').
 * @param model - The model to select for the new mode.
 * @param params - The params reconciled for that model.
 */
export function setNodeMode(
  projectId: string,
  spaceId: string,
  nodeId: string,
  mode: string,
  model: string,
  params: Record<string, unknown>,
): void {
  const doc = getDoc(docName.canvasSpace(projectId, spaceId));
  const nodesMap = doc.getMap<Y.Map<unknown>>(NODES_KEY);
  const node = nodesMap.get(nodeId);
  if (!node) return;
  const data = node.get('data');
  if (!(data instanceof Y.Map)) return;
  doc.transact(() => {
    data.set('mode', mode);
    data.set('model', model);
    data.set('params', params);
  }, CANVAS_UNDO);
}

/**
 * Get (or lazily create) the Y.XmlFragment backing a content node's Generate
 * prompt. The collaborative prompt editor (TipTap + Collaboration) binds to
 * this fragment so collaborators see keystrokes live. Created empty on first
 * open with the content-write origin so the init does NOT enter the canvas undo
 * stack (prompt edits carry the y-sync origin and are excluded too). Returns
 * null when the node or its data map is missing.
 * @param projectId - Project the canvas space belongs to.
 * @param spaceId - Canvas space containing the node.
 * @param nodeId - Id of the node whose prompt fragment to get / create.
 * @returns The prompt Y.XmlFragment, or null when the node is missing.
 */
export function getOrCreatePromptFragment(
  projectId: string,
  spaceId: string,
  nodeId: string,
): Y.XmlFragment | null {
  const doc = getDoc(docName.canvasSpace(projectId, spaceId));
  const nodesMap = doc.getMap<Y.Map<unknown>>(NODES_KEY);
  const node = nodesMap.get(nodeId);
  if (!node) return null;
  const data = node.get('data');
  if (!(data instanceof Y.Map)) return null;
  const existing = data.get('prompt');
  if (existing instanceof Y.XmlFragment) return existing;
  const fragment = new Y.XmlFragment();
  doc.transact(() => data.set('prompt', fragment), CONTENT_WRITE);
  return fragment;
}

/**
 * Reads a node's current persistent lease counter (`data.leaseGen`). The
 * Generate execute path sends `gen = leaseGen + 1` in the task payload so the
 * backend's handling-open + the worker's write-back CAS fence out stale
 * generations (#1580). Read fresh at execute time (not from the reactive view,
 * which omits `leaseGen`) to avoid racing a render. Absent / non-numeric = 0.
 * @param projectId - Project the canvas space belongs to.
 * @param spaceId - Canvas space containing the node.
 * @param nodeId - Id of the node whose lease counter to read.
 * @returns The current leaseGen, or 0 when the node or counter is absent.
 */
export function readNodeLeaseGen(
  projectId: string,
  spaceId: string,
  nodeId: string,
): number {
  const doc = getDoc(docName.canvasSpace(projectId, spaceId));
  const nodesMap = doc.getMap<Y.Map<unknown>>(NODES_KEY);
  const node = nodesMap.get(nodeId);
  if (!node) return 0;
  const data = node.get('data');
  if (!(data instanceof Y.Map)) return 0;
  const gen = data.get('leaseGen');
  return typeof gen === 'number' ? gen : 0;
}

/**
 * Whether a node currently exists in the canvas, read FRESH from live Yjs (not
 * a React closure). The Generate execute path calls this at click time so a
 * node a collaborator deleted between the last render and the click can't slip
 * a task through against a non-existent node.
 * @param projectId - Project the canvas space belongs to.
 * @param spaceId - Canvas space containing the node.
 * @param nodeId - Id of the node to check.
 * @returns True when the node is present in the live document.
 */
export function nodeExists(
  projectId: string,
  spaceId: string,
  nodeId: string,
): boolean {
  const doc = getDoc(docName.canvasSpace(projectId, spaceId));
  return doc.getMap<Y.Map<unknown>>(NODES_KEY).has(nodeId);
}

/**
 * Whether a node is currently locked, read FRESH from live Yjs. The Generate
 * flow calls this at click / execute time so a node a collaborator locked after
 * the context menu opened (or after the panel opened) can't have a task
 * submitted against it — a locked node is frozen.
 * @param projectId - Project the canvas space belongs to.
 * @param spaceId - Canvas space containing the node.
 * @param nodeId - Id of the node to check.
 * @returns True when the node exists and is locked.
 */
export function isNodeLocked(
  projectId: string,
  spaceId: string,
  nodeId: string,
): boolean {
  const doc = getDoc(docName.canvasSpace(projectId, spaceId));
  const node = doc.getMap<Y.Map<unknown>>(NODES_KEY).get(nodeId);
  if (!node) return false;
  const data = node.get('data');
  if (!(data instanceof Y.Map)) return false;
  return data.get('locked') === true;
}

/**
 * Write a node's content + mark it idle — the "content arrived" transition
 * (frontend-owned upload completion). Sets `content`, flips `state` to `'idle'`
 * and clears any prior `errorMessage`, all in one transaction so collaborators
 * see the node go from handling → content in a single update.
 * @param projectId - Project the canvas space belongs to.
 * @param spaceId - Canvas space containing the node.
 * @param nodeId - Id of the node to fill.
 * @param content - The node's content (an asset URL, or text body).
 */
export function setNodeContent(
  projectId: string,
  spaceId: string,
  nodeId: string,
  content: string,
): void {
  const doc = getDoc(docName.canvasSpace(projectId, spaceId));
  const nodesMap = doc.getMap<Y.Map<unknown>>(NODES_KEY);
  const node = nodesMap.get(nodeId);
  if (!node) return;
  const data = node.get('data');
  if (!(data instanceof Y.Map)) return;
  doc.transact(() => {
    data.set('content', content);
    data.set('state', 'idle');
    data.delete('errorMessage');
  }, CONTENT_WRITE);
}

/**
 * The owner triple a frontend handling opener holds (#1580 #7 unified gen).
 * `setNodeHandling` returns it; the leased write-backs
 * ({@link completeNodeHandling} / {@link failNodeHandling}) verify the live
 * `handlingBy` still matches ALL THREE fields before landing — when two
 * clients race the same gen, Yjs converges `handlingBy` to one owner and
 * only that owner's result lands (node's final content = final owner's).
 */
export interface LeaseToken {
  /** Fencing generation taken from the node's `leaseGen` counter + 1. */
  gen: number;
  /** Yjs clientID of the opening connection (tells two tabs apart). */
  clientId: number;
  /** User who opened the handling. */
  userId: string;
}

/**
 * Read a node's live `handlingBy` and check it against a lease token.
 * @param data - The node's data Y.Map.
 * @param lease - The caller's owner triple.
 * @returns True when the live lease matches all three token fields.
 */
function ownsLease(data: Y.Map<unknown>, lease: LeaseToken): boolean {
  const hb = data.get('handlingBy');
  if (hb === null || typeof hb !== 'object') return false;
  const actor = hb as { gen?: number; clientId?: number; userId?: string };
  return (
    actor.gen === lease.gen &&
    actor.clientId === lease.clientId &&
    actor.userId === lease.userId
  );
}

/**
 * Mark an existing node `handling` — the start of a fill-from-file (double-click
 * / Upload-menu) on a node that already exists. Like content / error writes it
 * uses the `CONTENT_WRITE` origin so it stays OUT of the undo stack (a transient
 * in-flight state must never become an undo entry, #8). Clears any prior error.
 *
 * #1580 #7 unified gen: takes `gen = leaseGen + 1` from the node's persistent
 * counter, advances the counter in the same transaction, and stamps the owner
 * triple (`gen` + `userId` + `clientId` = this doc connection's Yjs clientID)
 * onto `handlingBy`. The returned {@link LeaseToken} is what
 * {@link completeNodeHandling} / {@link failNodeHandling} verify against —
 * a superseded opener's late write-back must not clobber the live owner.
 * The collab sweeper still measures HANDLING_TIMEOUT_MS from `startedAt`
 * (crash backstop, #1569).
 * @param projectId - Project the canvas space belongs to.
 * @param spaceId - Canvas space containing the node.
 * @param nodeId - Id of the node to mark in-flight.
 * @param userId - Current user driving the fill (the lease holder).
 * @returns The owner triple for the opened lease, or `undefined` when the
 *   node does not exist.
 */
export function setNodeHandling(
  projectId: string,
  spaceId: string,
  nodeId: string,
  userId: string,
): LeaseToken | undefined {
  const doc = getDoc(docName.canvasSpace(projectId, spaceId));
  const nodesMap = doc.getMap<Y.Map<unknown>>(NODES_KEY);
  const node = nodesMap.get(nodeId);
  if (!node) return undefined;
  const data = node.get('data');
  if (!(data instanceof Y.Map)) return undefined;
  const currentLeaseGen = data.get('leaseGen');
  const gen = (typeof currentLeaseGen === 'number' ? currentLeaseGen : 0) + 1;
  const clientId = doc.clientID;
  doc.transact(() => {
    data.set('state', 'handling');
    data.set('handlingBy', {
      userId,
      type: 'frontend',
      startedAt: Date.now(),
      gen,
      clientId,
    });
    data.set('leaseGen', gen);
    data.delete('errorMessage');
  }, CONTENT_WRITE);
  return { gen, clientId, userId };
}

/**
 * Complete a leased handling with its result content — the upload-done
 * write-back (#1580 #7). Verifies the caller still OWNS the live lease
 * (all three token fields match `handlingBy`) before writing; a superseded
 * opener (another user / tab re-opened the node, or the sweeper reclaimed
 * it) gets `false` and writes nothing — the node's final content belongs to
 * the final lease owner. On success: content + `state: 'idle'`, clears the
 * lease and any prior error, in one transaction (CONTENT_WRITE origin —
 * never an undo entry).
 * @param projectId - Project the canvas space belongs to.
 * @param spaceId - Canvas space containing the node.
 * @param nodeId - Id of the node to fill.
 * @param content - The node's content (an asset URL, or extracted text).
 * @param lease - The owner triple returned by {@link setNodeHandling} (or
 *   derived from a factory-created handling node).
 * @returns True when the write landed; false when the lease was superseded.
 */
export function completeNodeHandling(
  projectId: string,
  spaceId: string,
  nodeId: string,
  content: string,
  lease: LeaseToken,
): boolean {
  const doc = getDoc(docName.canvasSpace(projectId, spaceId));
  const nodesMap = doc.getMap<Y.Map<unknown>>(NODES_KEY);
  const node = nodesMap.get(nodeId);
  if (!node) return false;
  const data = node.get('data');
  if (!(data instanceof Y.Map)) return false;
  if (!ownsLease(data, lease)) return false;
  doc.transact(() => {
    data.set('content', content);
    data.set('state', 'idle');
    data.delete('handlingBy');
    data.delete('errorMessage');
  }, CONTENT_WRITE);
  return true;
}

/**
 * Fail a leased handling with an inline error message — the upload-failure
 * write-back (#1580 #7). Same owner verification as
 * {@link completeNodeHandling}; on success sets `errorMessage` + `state:
 * 'idle'` (derived status `error`) and clears the lease. The error text is
 * a fixed-English wire string (shared doc — never freeze a locale into it).
 * @param projectId - Project the canvas space belongs to.
 * @param spaceId - Canvas space containing the node.
 * @param nodeId - Id of the failed node.
 * @param errorMessage - The error text shown on the node (include the filename).
 * @param lease - The owner triple returned by {@link setNodeHandling}.
 * @returns True when the write landed; false when the lease was superseded.
 */
export function failNodeHandling(
  projectId: string,
  spaceId: string,
  nodeId: string,
  errorMessage: string,
  lease: LeaseToken,
): boolean {
  const doc = getDoc(docName.canvasSpace(projectId, spaceId));
  const nodesMap = doc.getMap<Y.Map<unknown>>(NODES_KEY);
  const node = nodesMap.get(nodeId);
  if (!node) return false;
  const data = node.get('data');
  if (!(data instanceof Y.Map)) return false;
  if (!ownsLease(data, lease)) return false;
  doc.transact(() => {
    data.set('errorMessage', errorMessage);
    data.set('state', 'idle');
    data.delete('handlingBy');
  }, CONTENT_WRITE);
  return true;
}

/**
 * Busy-gate primitive (#1580 #7, user decision 2026-07-03): the UI refuses
 * a second upload / AIGC trigger on a node that is already handling —
 * whoever holds the lease keeps it until they finish or the sweeper
 * reclaims. Missing nodes read as not-handling.
 * @param projectId - Project the canvas space belongs to.
 * @param spaceId - Canvas space containing the node.
 * @param nodeId - Id of the node to check.
 * @returns True when the node is currently in the handling state.
 */
export function isNodeHandling(
  projectId: string,
  spaceId: string,
  nodeId: string,
): boolean {
  const doc = getDoc(docName.canvasSpace(projectId, spaceId));
  const nodesMap = doc.getMap<Y.Map<unknown>>(NODES_KEY);
  const node = nodesMap.get(nodeId);
  if (!node) return false;
  const data = node.get('data');
  if (!(data instanceof Y.Map)) return false;
  return data.get('state') === 'handling';
}

/**
 * The Yjs clientID of this browser's connection to a canvas doc — the
 * third field of the owner triple for nodes CREATED already-handling
 * (upload drop creates the node with its first lease inline; the factory
 * is pure, so the caller injects this).
 * @param projectId - Project the canvas space belongs to.
 * @param spaceId - Canvas space the node will be added to.
 * @returns The doc connection's Yjs clientID.
 */
export function getCanvasClientId(projectId: string, spaceId: string): number {
  return getDoc(docName.canvasSpace(projectId, spaceId)).clientID;
}

/**
 * Set (or clear) a group's background tint — frontend-owned. Passing
 * `undefined` clears the field (no color → neutral dashed group). No-op when the
 * group does not exist.
 * @param projectId - Project the canvas space belongs to.
 * @param spaceId - Canvas space containing the group.
 * @param groupId - Id of the group to tint.
 * @param color - The new background token, or `undefined` to clear it.
 */
export function setGroupBackground(
  projectId: string,
  spaceId: string,
  groupId: string,
  color: string | undefined,
): void {
  const doc = getDoc(docName.canvasSpace(projectId, spaceId));
  const nodesMap = doc.getMap<Y.Map<unknown>>(NODES_KEY);
  const group = nodesMap.get(groupId);
  if (!(group instanceof Y.Map) || group.get('type') !== 'group') return;
  const data = group.get('data');
  if (!(data instanceof Y.Map)) return;
  doc.transact(() => {
    if (color === undefined) data.delete('backgroundColor');
    else data.set('backgroundColor', color);
  }, CANVAS_UNDO);
}

/**
 * Create a Group around a selection — frontend-owned (group redesign).
 * In one transaction it inserts the Group node (carrying its authoritative
 * width/height in `data`) and binds each member: sets the member's top-level
 * `parentId` to the Group and its new parent-relative position. One atomic undo
 * entry — undoing removes the Group and unbinds the members together.
 * @param projectId - Project the canvas space belongs to.
 * @param spaceId - Canvas space to create the Group in.
 * @param group - The Group node's wire fields (id, position, `data.width/height`).
 * @param members - The members to bind, each with its parent-relative position.
 */
export function createGroup(
  projectId: string,
  spaceId: string,
  group: CanvasNodeFields,
  members: ReadonlyArray<{ id: string; position: { x: number; y: number } }>,
): void {
  const doc = getDoc(docName.canvasSpace(projectId, spaceId));
  const nodesMap = doc.getMap<Y.Map<unknown>>(NODES_KEY);
  doc.transact(() => {
    const map = new Y.Map<unknown>();
    map.set('id', group.id);
    map.set('type', group.type);
    if (group.parentId !== undefined) map.set('parentId', group.parentId);
    map.set('position', group.position);
    map.set('data', buildDataMap(group.data));
    nodesMap.set(group.id, map);
    for (const member of members) {
      const node = nodesMap.get(member.id);
      if (!(node instanceof Y.Map)) continue;
      node.set('parentId', group.id);
      node.set('position', member.position);
    }
  }, CANVAS_UNDO);
}

/**
 * Reparent a node — frontend-owned (group redesign). Sets (or clears, when
 * `parentId` is null) the node's top-level `parentId` and writes its new
 * position in one transaction. The caller supplies the right coordinate space:
 * parent-relative when joining a Group, absolute when leaving one. No-op when
 * the node does not exist.
 * @param projectId - Project the canvas space belongs to.
 * @param spaceId - Canvas space containing the node.
 * @param nodeId - Id of the node to reparent.
 * @param parentId - The new parent Group id, or null to make the node top-level.
 * @param position - The node's new position (relative when joining, absolute when leaving).
 * @param position.x - New x coordinate.
 * @param position.y - New y coordinate.
 */
export function setNodeParent(
  projectId: string,
  spaceId: string,
  nodeId: string,
  parentId: string | null,
  position: { x: number; y: number },
): void {
  const doc = getDoc(docName.canvasSpace(projectId, spaceId));
  const nodesMap = doc.getMap<Y.Map<unknown>>(NODES_KEY);
  const node = nodesMap.get(nodeId);
  if (!(node instanceof Y.Map)) return;
  doc.transact(() => {
    if (parentId === null) node.delete('parentId');
    else node.set('parentId', parentId);
    node.set('position', position);
  }, CANVAS_UNDO);
}

/**
 * Resize a Group — frontend-owned (group redesign). Writes the Group's new
 * top-left position and authoritative `data.width`/`data.height` in one
 * transaction (members are not rescaled). No-op when the group does not exist.
 * @param projectId - Project the canvas space belongs to.
 * @param spaceId - Canvas space containing the Group.
 * @param groupId - Id of the Group to resize.
 * @param position - The Group's new top-left.
 * @param position.x - New x coordinate.
 * @param position.y - New y coordinate.
 * @param width - The Group's new width.
 * @param height - The Group's new height.
 */
export function resizeGroup(
  projectId: string,
  spaceId: string,
  groupId: string,
  position: { x: number; y: number },
  width: number,
  height: number,
): void {
  const doc = getDoc(docName.canvasSpace(projectId, spaceId));
  const nodesMap = doc.getMap<Y.Map<unknown>>(NODES_KEY);
  const group = nodesMap.get(groupId);
  if (!(group instanceof Y.Map) || group.get('type') !== 'group') return;
  const data = group.get('data');
  if (!(data instanceof Y.Map)) return;
  doc.transact(() => {
    group.set('position', position);
    data.set('width', width);
    data.set('height', height);
  }, CANVAS_UNDO);
}

/**
 * Grow a Group to a new rect AND reanchor its members so their ABSOLUTE
 * positions stay put (group redesign). Used by auto-expand: when an
 * in-group member's body overflows, the Group grows around it. If the Group's
 * top-left moves, every member's parent-relative position is shifted by the
 * inverse delta so the members don't visually move. One atomic transaction.
 * No-op when the group does not exist.
 * @param projectId - Project the canvas space belongs to.
 * @param spaceId - Canvas space containing the Group.
 * @param groupId - Id of the Group to grow.
 * @param position - The Group's new top-left.
 * @param position.x - New x coordinate.
 * @param position.y - New y coordinate.
 * @param width - The Group's new width.
 * @param height - The Group's new height.
 */
export function expandGroup(
  projectId: string,
  spaceId: string,
  groupId: string,
  position: { x: number; y: number },
  width: number,
  height: number,
): void {
  const doc = getDoc(docName.canvasSpace(projectId, spaceId));
  const nodesMap = doc.getMap<Y.Map<unknown>>(NODES_KEY);
  const group = nodesMap.get(groupId);
  if (!(group instanceof Y.Map) || group.get('type') !== 'group') return;
  const data = group.get('data');
  if (!(data instanceof Y.Map)) return;
  const oldPos = group.get('position') as { x: number; y: number } | undefined;
  const dx = oldPos ? oldPos.x - position.x : 0;
  const dy = oldPos ? oldPos.y - position.y : 0;
  doc.transact(() => {
    group.set('position', position);
    data.set('width', width);
    data.set('height', height);
    if (dx !== 0 || dy !== 0) {
      nodesMap.forEach((node) => {
        if (!(node instanceof Y.Map) || node.get('parentId') !== groupId) return;
        const p = node.get('position') as { x: number; y: number } | undefined;
        if (p) node.set('position', { x: p.x + dx, y: p.y + dy });
      });
    }
  }, CANVAS_UNDO);
}

/**
 * Add an edge (a connection = a reference relationship). Rejected (no-op) for a
 * self-loop or when either endpoint is absent from the live document.
 * @param projectId - Project the canvas space belongs to.
 * @param spaceId - Canvas space to add the edge to.
 * @param edge - The edge to insert (id, source, target, optional toolId).
 * @returns True when the edge landed; false when it was rejected.
 */
export function addEdge(
  projectId: string,
  spaceId: string,
  edge: CanvasEdge,
): boolean {
  // A connection IS a reference: a self-loop is meaningless. Cheap, Yjs-free
  // check up front.
  if (edge.source === edge.target) return false;
  const doc = getDoc(docName.canvasSpace(projectId, spaceId));
  const nodesMap = doc.getMap<Y.Map<unknown>>(NODES_KEY);
  const edgesMap = doc.getMap<Y.Map<unknown>>(EDGES_KEY);
  let added = false;
  doc.transact(() => {
    // Validate BOTH endpoints against live Yjs state inside the transaction —
    // this is the airtight write boundary. A caller's guard reads its React
    // closure, which goes stale the instant a collaborator deletes a node
    // (Yjs applies the deletion before React re-creates the handler), so the
    // only race-free place to reject an orphaned edge is here, atomically with
    // the write. Returns whether the edge landed so the caller can surface
    // feedback (a silently-rejected edge must not read as success in the UI).
    if (!nodesMap.has(edge.source) || !nodesMap.has(edge.target)) return;
    // Deterministic ids make a duplicate drag map onto the EXISTING entry —
    // rewriting it would replace createdAt (the reference silently jumps to
    // the rail's end) and push a spurious undo entry. Idempotent success.
    if (edgesMap.has(edge.id)) {
      added = true;
      return;
    }
    const map = new Y.Map<unknown>();
    map.set('id', edge.id);
    map.set('source', edge.source);
    map.set('target', edge.target);
    if (edge.toolId) map.set('toolId', edge.toolId);
    // Connection time drives reference-rail order (undo re-inserts the map
    // with its original stamp, so an undone+redone edge keeps its place).
    map.set('createdAt', edge.createdAt ?? Date.now());
    edgesMap.set(edge.id, map);
    added = true;
  }, CANVAS_UNDO);
  return added;
}

/**
 * Reads the canvas graph (nodes + edges) FRESH from live Yjs, by project /
 * space. Write-callbacks (execute, model / param change) call this at click
 * time so they never build on a stale render-closure view-model — a
 * collaborator's edit that React has batched-but-not-rendered is already
 * visible in the live document.
 * @param projectId - Project the canvas space belongs to.
 * @param spaceId - Canvas space to read.
 * @returns The current node views and edges.
 */
export function readCanvasGraph(
  projectId: string,
  spaceId: string,
): {
  nodes: ReadonlyArray<CanvasNodeView>;
  edges: ReadonlyArray<CanvasEdge>;
} {
  const doc = getDoc(docName.canvasSpace(projectId, spaceId));
  return { nodes: readNodes(doc), edges: readEdges(doc) };
}

/**
 * Delete an edge by id — frontend-owned operation.
 * @param projectId - Project the canvas space belongs to.
 * @param spaceId - Canvas space to remove the edge from.
 * @param edgeId - Id of the edge to delete.
 */
export function removeEdge(
  projectId: string,
  spaceId: string,
  edgeId: string,
): void {
  const doc = getDoc(docName.canvasSpace(projectId, spaceId));
  const edgesMap = doc.getMap<Y.Map<unknown>>(EDGES_KEY);
  doc.transact(() => {
    edgesMap.delete(edgeId);
  }, CANVAS_UNDO);
}

/**
 * Delete nodes and edges together in a single tracked transaction — frontend-
 * owned. Deleting a node cascades its connected edges (ReactFlow surfaces both
 * sets in one `onDelete`); doing it in one transaction makes it ONE undo
 * entry, so a single undo restores the node AND its edges (separate
 * removeNode / removeEdge calls would be two entries, restoring only one).
 * @param projectId - Project the canvas space belongs to.
 * @param spaceId - Canvas space to delete from.
 * @param nodeIds - Node ids to delete.
 * @param edgeIds - Edge ids to delete.
 */
export function removeElements(
  projectId: string,
  spaceId: string,
  nodeIds: ReadonlyArray<string>,
  edgeIds: ReadonlyArray<string>,
): void {
  const doc = getDoc(docName.canvasSpace(projectId, spaceId));
  const nodesMap = doc.getMap<Y.Map<unknown>>(NODES_KEY);
  const edgesMap = doc.getMap<Y.Map<unknown>>(EDGES_KEY);
  doc.transact(() => {
    nodeIds.forEach((id) => {
      const node = nodesMap.get(id);
      if (node instanceof Y.Map && node.get('type') === 'group') {
        releaseGroupMembers(nodesMap, id);
      }
      nodesMap.delete(id);
    });
    edgeIds.forEach((id) => edgesMap.delete(id));
  }, CANVAS_UNDO);
}

/**
 * Read all nodes from `nodesMap` into render-ready views. Each node's wire
 * fields are projected through `toNodeView`; nodes with a dirty / unknown
 * `type` or a missing `data` Y.Map are skipped.
 * @param doc - The canvas-space Y.Doc to read from.
 * @returns The current renderable canvas nodes.
 */
export function readNodes(doc: Y.Doc): ReadonlyArray<CanvasNodeView> {
  const nodesMap = doc.getMap<Y.Map<unknown>>(NODES_KEY);
  const out: CanvasNodeView[] = [];
  nodesMap.forEach((nodeMap) => {
    if (!(nodeMap instanceof Y.Map)) return;
    const dataMap = nodeMap.get('data');
    if (!(dataMap instanceof Y.Map)) return;
    const fields: CanvasNodeFields = {
      id: String(nodeMap.get('id') ?? ''),
      type: nodeMap.get('type') as NodeType,
      position: (nodeMap.get('position') as { x: number; y: number }) ?? {
        x: 0,
        y: 0,
      },
      data: dataMap.toJSON() as CanvasNodeFields['data'],
    };
    const view = toNodeView(fields);
    if (!view) return;
    const parentId = nodeMap.get('parentId');
    out.push({
      id: fields.id,
      type: view.kind,
      position: fields.position,
      ...(typeof parentId === 'string' ? { parentId } : {}),
      data: view,
    });
  });
  return out;
}

/**
 * Read all edges from `edgesMap` into a ReactFlow-ready array.
 * @param doc - The canvas-space Y.Doc to read from.
 * @returns The current canvas edges, with defaults applied for missing fields.
 */
export function readEdges(doc: Y.Doc): ReadonlyArray<CanvasEdge> {
  const edgesMap = doc.getMap<Y.Map<unknown>>(EDGES_KEY);
  const out: CanvasEdge[] = [];
  edgesMap.forEach((map) => {
    if (!(map instanceof Y.Map)) return;
    // createdAt is untrusted collaborative data (same convention as
    // readNodeLeaseGen): a corrupt stamp (string / NaN) would make the rail
    // sort comparator return NaN, which TimSort treats as "equal" — silently
    // un-sorting HEALTHY edges around it. Drop anything non-finite.
    const rawCreatedAt = map.get('createdAt');
    out.push({
      id: String(map.get('id') ?? ''),
      source: String(map.get('source') ?? ''),
      target: String(map.get('target') ?? ''),
      toolId: (map.get('toolId') as string | undefined) ?? undefined,
      createdAt:
        typeof rawCreatedAt === 'number' && Number.isFinite(rawCreatedAt)
          ? rawCreatedAt
          : undefined,
    });
  });
  return out;
}
