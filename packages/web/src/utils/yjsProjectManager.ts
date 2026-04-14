/**
 * Project-level Yjs manager.
 *
 * Creates the canvas Y.Doc with the Map-of-Maps structure:
 *
 *   canvas: Y.Map
 *     ├── nodesMap: Y.Map<nodeId, Y.Map>
 *     └── edges:    Y.Map<edgeId, Y.Map>
 *
 * Provides undo/redo scoped to canvas topology (node create/delete,
 * position, edges). Prompt undo is handled separately by TipTap.
 */

import * as Y from 'yjs';
import { createYjsManager, type YjsManager as BaseYjsManager } from './yjsManager';

/** Transactions with this origin are excluded from canvas UndoManager. */
export const noHistoryOrigin = Symbol('no-history');

/** Origin used for normal user operations (tracked by UndoManager). */
export const userOrigin = 'canvas-user';

export interface YjsProjectManagerConfig {
  workflowId: string;
  wsUrl?: string;
  onSynced?: () => void;
  onUpdate?: () => void;
}

export interface YjsProjectManager {
  doc: Y.Doc;
  canvasMap: Y.Map<unknown>;
  /** Y.Map<nodeId, Y.Map> — each node is an independent Y.Map. */
  nodesMap: Y.Map<unknown>;
  /** Y.Map<edgeId, Y.Map> — each edge is an independent Y.Map. */
  edgesMap: Y.Map<unknown>;
  imageEditorMap: Y.Map<unknown>;
  awareness: BaseYjsManager['awareness'];
  undoManager: Y.UndoManager;
  getSubdoc: (subdocId: string) => Y.Doc;
  getSubdocAwareness: (subdocId: string) => BaseYjsManager['awareness'] | undefined;
  createSnapshot: () => Uint8Array;
  restoreSnapshot: (binary: Uint8Array) => void;
  undo: () => boolean;
  redo: () => boolean;
  canUndo: () => boolean;
  canRedo: () => boolean;
  transactWithoutHistory: (fn: () => void) => void;
  destroy: () => void;
}

export const createYjsProjectManager = (config: YjsProjectManagerConfig): YjsProjectManager => {
  const { workflowId, wsUrl } = config;

  const baseManager = createYjsManager({ docId: `project-${workflowId}/canvas`, wsUrl });
  const doc = baseManager.doc;

  const canvasMap = doc.getMap('canvas');
  const imageEditorMap = doc.getMap('imageEditor');

  // nodesMap/edgesMap helper — gets or creates the Y.Map inside canvasMap.
  // NOT called eagerly during init to avoid creating Y.Maps that conflict
  // with the server state arriving via WebSocket sync.
  function getOrCreateSubMap(key: string): Y.Map<unknown> {
    let m = canvasMap.get(key);
    if (!(m instanceof Y.Map)) {
      m = new Y.Map();
      canvasMap.set(key, m);
    }
    return m as Y.Map<unknown>;
  }

  const snapshotOrigin = Symbol('snapshot-origin');

  // Canvas UndoManager — tracks topology changes (node create/delete,
  // position, name, edges). Does NOT track:
  // - Prompt edits (TipTap's own UndoManager on Y.XmlFragment)
  // - Attachment/params changes (use noHistoryOrigin)
  // - Collab/remote writes (remote origin, not in trackedOrigins)
  //
  // Only `userOrigin` is tracked — `null` is excluded to prevent
  // TipTap's y-prosemirror writes from polluting the canvas undo stack.
  const UNDO_STACK_MAX = 50;
  // UndoManager scoped to canvasMap — tracks all nested changes
  // (nodesMap + edgesMap) regardless of when they're created.
  const undoManager = new Y.UndoManager(
    [canvasMap],
    {
      trackedOrigins: new Set([userOrigin]),
      captureTimeout: 500,
    },
  );

  // Trim undo stack to prevent unbounded memory growth (1000+ nodes scenario).
  undoManager.on('stack-item-added', () => {
    while (undoManager.undoStack.length > UNDO_STACK_MAX) {
      undoManager.undoStack.shift();
    }
  });

  let isSynced = false;

  const restoreSnapshot = (binary: Uint8Array) => {
    const tempDoc = new Y.Doc();
    Y.applyUpdate(tempDoc, binary);
    doc.transact(() => {
      const merged = Y.encodeStateAsUpdate(tempDoc);
      Y.applyUpdate(doc, merged);
    }, snapshotOrigin);
    tempDoc.destroy();
  };

  const undo = (): boolean => {
    if (undoManager.undoStack.length === 0) return false;
    undoManager.undo();
    return true;
  };

  const redo = (): boolean => {
    if (undoManager.redoStack.length === 0) return false;
    undoManager.redo();
    return true;
  };

  const canUndo = (): boolean => undoManager.undoStack.length > 0;
  const canRedo = (): boolean => undoManager.redoStack.length > 0;

  const transactWithoutHistory = (fn: () => void) => {
    doc.transact(fn, noHistoryOrigin);
  };

  const checkSync = () => {
    if (!isSynced) {
      isSynced = true;
      if (undoManager.undoStack) undoManager.undoStack.length = 0;
      if (undoManager.redoStack) undoManager.redoStack.length = 0;
      baseManager.createSnapshot();
    }
  };

  if (baseManager.indexeddbProvider.synced) {
    checkSync();
    config.onSynced?.();
  } else {
    baseManager.indexeddbProvider.on('synced', () => {
      checkSync();
      config.onSynced?.();
    });
  }

  const handleUpdate = () => config.onUpdate?.();
  doc.on('update', handleUpdate);

  const destroy = () => {
    doc.off('update', handleUpdate);
    baseManager.destroy();
    isSynced = false;
  };

  return {
    doc,
    canvasMap,
    // Getter-based: always returns the fresh Y.Map from canvasMap,
    // avoiding stale references before WebSocket sync completes.
    get nodesMap() { return getOrCreateSubMap('nodesMap'); },
    get edgesMap() { return getOrCreateSubMap('edges'); },
    imageEditorMap,
    awareness: baseManager.awareness,
    undoManager,
    getSubdoc: baseManager.getSubdoc,
    getSubdocAwareness: baseManager.getSubdocAwareness,
    createSnapshot: baseManager.createSnapshot,
    restoreSnapshot,
    undo,
    redo,
    canUndo,
    canRedo,
    transactWithoutHistory,
    destroy,
  };
};

export type YjsManager = YjsProjectManager;
