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

export interface CanvasEdge {
  id: string;
  source: string;
  target: string;
  kind: 'primary' | 'reference';
  toolId?: string;
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
 * Mark an existing node `handling` — the start of a fill-from-file (double-click
 * / Upload-menu) on a node that already exists. Like content / error writes it
 * uses the `CONTENT_WRITE` origin so it stays OUT of the undo stack (a transient
 * in-flight state must never become an undo entry, #8). Clears any prior error.
 * @param projectId - Project the canvas space belongs to.
 * @param spaceId - Canvas space containing the node.
 * @param nodeId - Id of the node to mark in-flight.
 */
export function setNodeHandling(
  projectId: string,
  spaceId: string,
  nodeId: string,
): void {
  const doc = getDoc(docName.canvasSpace(projectId, spaceId));
  const nodesMap = doc.getMap<Y.Map<unknown>>(NODES_KEY);
  const node = nodesMap.get(nodeId);
  if (!node) return;
  const data = node.get('data');
  if (!(data instanceof Y.Map)) return;
  doc.transact(() => {
    data.set('state', 'handling');
    data.delete('errorMessage');
  }, CONTENT_WRITE);
}

/**
 * Mark a node as failed with an inline error message (frontend-owned upload
 * failure). Sets `errorMessage` and ensures `state` is `'idle'` so the derived
 * status is `error` (a lingering `handling` would mask it). Collaborators see
 * the inline error on the node.
 * @param projectId - Project the canvas space belongs to.
 * @param spaceId - Canvas space containing the node.
 * @param nodeId - Id of the failed node.
 * @param errorMessage - The error text shown on the node (include the filename).
 */
export function setNodeError(
  projectId: string,
  spaceId: string,
  nodeId: string,
  errorMessage: string,
): void {
  const doc = getDoc(docName.canvasSpace(projectId, spaceId));
  const nodesMap = doc.getMap<Y.Map<unknown>>(NODES_KEY);
  const node = nodesMap.get(nodeId);
  if (!node) return;
  const data = node.get('data');
  if (!(data instanceof Y.Map)) return;
  doc.transact(() => {
    data.set('errorMessage', errorMessage);
    data.set('state', 'idle');
  }, CONTENT_WRITE);
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
 * Add an edge (e.g. mini-tool primary edge).
 * @param projectId - Project the canvas space belongs to.
 * @param spaceId - Canvas space to add the edge to.
 * @param edge - The edge to insert (id, source, target, kind, optional toolId).
 */
export function addEdge(
  projectId: string,
  spaceId: string,
  edge: CanvasEdge,
): void {
  const doc = getDoc(docName.canvasSpace(projectId, spaceId));
  const edgesMap = doc.getMap<Y.Map<unknown>>(EDGES_KEY);
  doc.transact(() => {
    const map = new Y.Map<unknown>();
    map.set('id', edge.id);
    map.set('source', edge.source);
    map.set('target', edge.target);
    map.set('kind', edge.kind);
    if (edge.toolId) map.set('toolId', edge.toolId);
    edgesMap.set(edge.id, map);
  }, CANVAS_UNDO);
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
    out.push({
      id: String(map.get('id') ?? ''),
      source: String(map.get('source') ?? ''),
      target: String(map.get('target') ?? ''),
      kind: (map.get('kind') as CanvasEdge['kind']) ?? 'primary',
      toolId: (map.get('toolId') as string | undefined) ?? undefined,
    });
  });
  return out;
}
