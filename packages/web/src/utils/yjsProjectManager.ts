/**
 * Project-level Yjs manager.
 *
 * Creates the canvas Y.Doc and waits for server sync before
 * initializing nodesMap/edgesMap/UndoManager. This ensures we
 * always work with the server's version of the data — no CRDT
 * conflict, no zombie references, no race conditions.
 *
 * Canvas structure (after sync):
 *   canvas: Y.Map
 *     ├── nodesMap: Y.Map<nodeId, Y.Map>
 *     └── edges:    Y.Map<edgeId, Y.Map>
 */

import * as Y from 'yjs';
import { createYjsManager, type YjsManager as BaseYjsManager } from './yjsManager';

/** Transactions with this origin are excluded from canvas UndoManager. */
export const noHistoryOrigin = Symbol('no-history');

/**
 * Origin used for normal user operations (tracked by UndoManager).
 * Per-user so collaborators can't undo each other's operations.
 * Set via createYjsProjectManager config; defaults to 'canvas-user'.
 */
let _userOrigin = 'canvas-user';
export function getUserOrigin(): string { return _userOrigin; }
/** @deprecated Use getUserOrigin() — this is kept for backward compat. */
export const userOrigin = 'canvas-user';

export interface YjsProjectManagerConfig {
  workflowId: string;
  /** Session token for Hocuspocus auth. See YjsManagerConfig.token. */
  token: string;
  wsUrl?: string;
  userId?: string;
  onSynced?: () => void;
  /** Called when server rejects the session token; clear session + redirect. */
  onAuthFailed?: (reason: string) => void;
}

export interface YjsProjectManager {
  doc: Y.Doc;
  canvasMap: Y.Map<unknown>;
  /** Y.Map<nodeId, Y.Map> — available after sync. */
  nodesMap: Y.Map<unknown>;
  /** Y.Map<edgeId, Y.Map> — available after sync. */
  edgesMap: Y.Map<unknown>;
  imageEditorMap: Y.Map<unknown>;
  awareness: BaseYjsManager['awareness'];
  undoManager: Y.UndoManager;
  /** True after server sync completes and nodesMap/edgesMap are initialized. */
  synced: boolean;
  /** Register a callback for when sync + initialization completes. */
  onSynced: (cb: () => void) => () => void;
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
  const { workflowId, token, wsUrl, userId, onAuthFailed } = config;

  // Set per-user origin for UndoManager tracking
  _userOrigin = userId ? `canvas-user:${userId}` : 'canvas-user';

  const baseManager = createYjsManager({
    docId: `project-${workflowId}/canvas`,
    token,
    wsUrl,
    onAuthFailed,
  });
  const doc = baseManager.doc;

  const canvasMap = doc.getMap('canvas');
  const imageEditorMap = doc.getMap('imageEditor');

  // nodesMap, edgesMap, and UndoManager are initialized AFTER sync.
  // Before sync, these are null — consumers must check `synced` or
  // use `onSynced` before accessing them.
  let nodesMap: Y.Map<unknown> | null = null;
  let edgesMap: Y.Map<unknown> | null = null;
  let undoManager: Y.UndoManager | null = null;

  const UNDO_STACK_MAX = 50;

  function initAfterSync() {
    // Get or create sub-maps. Safe to create here because sync is
    // complete — no CRDT conflict will occur.
    let nm = canvasMap.get('nodesMap');
    if (!(nm instanceof Y.Map)) {
      nm = new Y.Map();
      canvasMap.set('nodesMap', nm);
    }
    nodesMap = nm as Y.Map<unknown>;

    let em = canvasMap.get('edges');
    if (!(em instanceof Y.Map)) {
      em = new Y.Map();
      canvasMap.set('edges', em);
    }
    edgesMap = em as Y.Map<unknown>;

    // UndoManager scoped to nodesMap + edgesMap (precise scope).
    undoManager = new Y.UndoManager(
      [nodesMap, edgesMap],
      {
        trackedOrigins: new Set([_userOrigin]),
        captureTimeout: 500,
      },
    );

    undoManager.on('stack-item-added', () => {
      while (undoManager!.undoStack.length > UNDO_STACK_MAX) {
        undoManager!.undoStack.shift();
      }
    });

    // Clear undo stack — don't let users undo the initial sync load.
    undoManager.clear();
  }

  // Sync tracking
  let synced = false;
  const syncCallbacks = new Set<() => void>();

  baseManager.onSynced(() => {
    initAfterSync();
    synced = true;
    syncCallbacks.forEach((cb) => cb());
    syncCallbacks.clear();
    config.onSynced?.();
  });

  const onSynced = (cb: () => void): (() => void) => {
    if (synced) {
      cb();
      return () => {};
    }
    syncCallbacks.add(cb);
    return () => { syncCallbacks.delete(cb); };
  };

  const snapshotOrigin = Symbol('snapshot-origin');

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
    if (!undoManager || undoManager.undoStack.length === 0) return false;
    undoManager.undo();
    return true;
  };

  const redo = (): boolean => {
    if (!undoManager || undoManager.redoStack.length === 0) return false;
    undoManager.redo();
    return true;
  };

  const canUndo = (): boolean => undoManager ? undoManager.undoStack.length > 0 : false;
  const canRedo = (): boolean => undoManager ? undoManager.redoStack.length > 0 : false;

  const transactWithoutHistory = (fn: () => void) => {
    doc.transact(fn, noHistoryOrigin);
  };

  const destroy = () => {
    baseManager.destroy();
    synced = false;
  };

  return {
    doc,
    canvasMap,
    get nodesMap() { return nodesMap!; },
    get edgesMap() { return edgesMap!; },
    imageEditorMap,
    awareness: baseManager.awareness,
    get undoManager() { return undoManager!; },
    get synced() { return synced; },
    onSynced,
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
