/**
 * Yjs manager for one canvas Space doc (v10 §5.3.2).
 *
 * Replaces the pre-v10 `yjsProjectManager` (which used a single
 * `project-{id}/canvas` doc with a `canvas` wrapper Y.Map). v10
 * splits each Space into its own doc:
 *
 *   project-{projectId}/canvas-{spaceId}
 *     ├── nodesMap: Y.Map<nodeId, Y.Map>   ← top level (no wrapper)
 *     └── edges:    Y.Map<edgeId, Y.Map>
 *
 * `nodesMap` and `edges` are initialized on first access after
 * server sync. Before sync, accessing them is allowed (Yjs
 * gracefully creates an empty Y.Map at the requested key) but the
 * UndoManager is only constructed once we've seen the server's
 * version, to avoid tracking pre-sync placeholder writes as undoable
 * user operations.
 */

import * as Y from 'yjs';
// Subpath import (not the `@breatic/shared` barrel) keeps the web
// bundle from pulling the i18n module's `node:fs` / `node:path`
// imports — Vite's `__vite-browser-external` rejects those.
import { canvasSpaceDocName } from '@breatic/shared/yjs-doc-names';
import {
  createYjsManager,
  type YjsManager as BaseYjsManager,
  type YjsManagerConfig,
} from "./manager";

/** Transactions tagged with this origin are excluded from UndoManager. */
export const noHistoryOrigin = Symbol('no-history');

/**
 * Origin tag for transactions that count as user-undoable ops.
 *
 * Per-user so collaborators can't undo each other's operations
 * (Y.UndoManager filters by origin set). Set via
 * {@link createCanvasSpaceManager}'s `userId` config; defaults to
 * `'canvas-user'` when no user id is provided.
 */
let _userOrigin = 'canvas-user';
export function getUserOrigin(): string {
  return _userOrigin;
}

export interface CanvasSpaceManagerConfig
  extends Omit<YjsManagerConfig, 'docName'> {
  projectId: string;
  spaceId: string;
  /** Optional — used to derive a per-user origin tag for UndoManager. */
  userId?: string;
  /** Called once after the server sync completes. */
  onSynced?: () => void;
}

export interface CanvasSpaceManager {
  doc: Y.Doc;
  /** Y.Map<nodeId, Y.Map> — top-level on the canvas-{spaceId} doc. */
  nodesMap: Y.Map<unknown>;
  /** Y.Map<edgeId, Y.Map> — top-level on the canvas-{spaceId} doc. */
  edgesMap: Y.Map<unknown>;
  awareness: BaseYjsManager['awareness'];
  /** Constructed after the server sync completes. */
  undoManager: Y.UndoManager;
  /** True after sync + UndoManager initialization. */
  synced: boolean;
  /** Register a callback for when sync + initialization completes. */
  onSynced: (cb: () => void) => () => void;
  undo: () => boolean;
  redo: () => boolean;
  canUndo: () => boolean;
  canRedo: () => boolean;
  /** Run a function in a Y.Doc transaction tagged with `noHistoryOrigin`. */
  transactWithoutHistory: (fn: () => void) => void;
  destroy: () => void;
}

const UNDO_STACK_MAX = 50;

/**
 * Build a manager bound to one canvas Space doc.
 *
 * The doc name is derived from `projectId + spaceId` via
 * {@link canvasSpaceDocName} — never assembled by string
 * concatenation at the call site.
 */
export const createCanvasSpaceManager = (
  config: CanvasSpaceManagerConfig,
): CanvasSpaceManager => {
  const { projectId, spaceId, userId } = config;

  _userOrigin = userId ? `canvas-user:${userId}` : 'canvas-user';

  const base = createYjsManager({
    docName: canvasSpaceDocName(projectId, spaceId),
    token: config.token,
    websocketProvider: config.websocketProvider,
    wsUrl: config.wsUrl,
    onAuthFailed: config.onAuthFailed,
  });

  const { doc } = base;

  // v10 layout: nodesMap + edges sit at the top level of the
  // canvas-{spaceId} doc. Y.Doc.getMap is idempotent — the maps are
  // created on first call, so they exist before sync; only contents
  // populate after sync.
  const nodesMap = doc.getMap('nodesMap') as Y.Map<unknown>;
  const edgesMap = doc.getMap('edges') as Y.Map<unknown>;

  let undoManager: Y.UndoManager | null = null;
  let synced = false;
  const syncCallbacks = new Set<() => void>();

  function initAfterSync() {
    // UndoManager is constructed after sync so the initial-load
    // diff doesn't enter the undo stack as a user op.
    undoManager = new Y.UndoManager([nodesMap, edgesMap], {
      trackedOrigins: new Set([_userOrigin]),
      captureTimeout: 500,
    });

    undoManager.on('stack-item-added', () => {
      while (undoManager!.undoStack.length > UNDO_STACK_MAX) {
        undoManager!.undoStack.shift();
      }
    });

    // Discard anything that may have landed before sync completed.
    undoManager.clear();
  }

  base.onSynced(() => {
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
    return () => {
      syncCallbacks.delete(cb);
    };
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

  const canUndo = (): boolean =>
    undoManager ? undoManager.undoStack.length > 0 : false;
  const canRedo = (): boolean =>
    undoManager ? undoManager.redoStack.length > 0 : false;

  const transactWithoutHistory = (fn: () => void) => {
    doc.transact(fn, noHistoryOrigin);
  };

  const destroy = () => {
    undoManager?.destroy();
    base.destroy();
    synced = false;
  };

  return {
    doc,
    nodesMap,
    edgesMap,
    awareness: base.awareness,
    get undoManager() {
      return undoManager!;
    },
    get synced() {
      return synced;
    },
    onSynced,
    undo,
    redo,
    canUndo,
    canRedo,
    transactWithoutHistory,
    destroy,
  };
};
