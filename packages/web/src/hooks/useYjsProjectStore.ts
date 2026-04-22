/**
 * Project-level Yjs hook — creates the manager, wires undo/redo,
 * and tracks awareness state.
 *
 * The manager waits for server sync before initializing nodesMap,
 * edgesMap, and UndoManager. Undo/redo listeners are connected
 * after sync completes via manager.onSynced.
 */

import { useEffect, useRef, useCallback, useState } from 'react';
import { createYjsProjectManager, type YjsProjectManager } from '@/utils/yjsProjectManager';
import { setCanvasYjsManager } from '@/utils/canvasYjsRef';

export interface UseYjsStoreOptions {
  id: string;
  /** Session token for Hocuspocus auth. When empty, the hook refuses to start Yjs. */
  token: string;
  wsUrl?: string;
  enabled?: boolean;
  /**
   * Called when Hocuspocus rejects the token. Should clear localStorage
   * auth + redirect to /login. The manager disconnects automatically
   * to stop reconnect loops; this callback handles the UX side.
   */
  onAuthFailed?: (reason: string) => void;
}

export interface UseYjsStoreResult {
  manager: YjsProjectManager | null;
  awareness: YjsProjectManager['awareness'] | null;
  createSnapshot: () => Uint8Array;
  restoreSnapshot: (binary: Uint8Array) => void;
  undo: () => void;
  redo: () => void;
  canUndo: boolean;
  canRedo: boolean;
  edgeSelections: Map<string, { color: string }>;
  yjsUndo: () => void;
  yjsRedo: () => void;
  yjsCanUndo: boolean;
  yjsCanRedo: boolean;
  yjsEnabled: boolean;
  yjsLoading: boolean;
}

export const useYjsStore = (options: UseYjsStoreOptions): UseYjsStoreResult => {
  const { id, token, wsUrl, enabled = true, onAuthFailed } = options;

  const [manager, setManager] = useState<YjsProjectManager | null>(null);
  const managerRef = useRef<YjsProjectManager | null>(null);
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);
  const [yjsLoading, setYjsLoading] = useState(false);
  const [edgeSelections, setEdgeSelections] = useState<Map<string, { color: string }>>(new Map());

  useEffect(() => {
    // Do not start Yjs when unauthenticated — there is no valid session
    // token to pass to Hocuspocus. Starting without a token would trigger
    // an infinite reconnect loop (server rejects empty token → close →
    // client reconnects). Upstream should pass enabled=false or empty
    // token before login completes.
    if (!enabled || !id || !token) {
      managerRef.current = null;
      setManager(null);
      setCanUndo(false);
      setCanRedo(false);
      setYjsLoading(false);
      setEdgeSelections(new Map());
      return;
    }

    setYjsLoading(true);

    const mgr = createYjsProjectManager({
      workflowId: id,
      token,
      wsUrl,
      onAuthFailed,
    });

    managerRef.current = mgr;
    setCanvasYjsManager(mgr);
    setManager(mgr);

    let undoCleanup: (() => void) | null = null;

    // Wire undo/redo listeners AFTER sync (UndoManager created after sync)
    const unsubSynced = mgr.onSynced(() => {
      setYjsLoading(false);

      const um = mgr.undoManager;
      const updateUndoRedoState = () => {
        setCanUndo(mgr.canUndo());
        setCanRedo(mgr.canRedo());
      };

      const onStackChange = () => updateUndoRedoState();
      um.on('stack-item-added', onStackChange);
      um.on('stack-item-popped', onStackChange);
      updateUndoRedoState();

      undoCleanup = () => {
        um.off('stack-item-added', onStackChange);
        um.off('stack-item-popped', onStackChange);
      };
    });

    // Awareness — track other users' edge selections.
    const updateAwareness = () => {
      const states = mgr.awareness.getStates();
      const next = new Map<string, { color: string }>();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      states.forEach((state: any, clientID: number) => {
        if (state.user && clientID !== mgr.awareness.clientID && state.user.selectedEdgeId) {
          next.set(state.user.selectedEdgeId, { color: state.user.color || '#000000' });
        }
      });
      setEdgeSelections(next);
    };
    mgr.awareness.on('change', updateAwareness);
    updateAwareness();

    return () => {
      unsubSynced();
      if (undoCleanup) undoCleanup();
      mgr.awareness.off('change', updateAwareness);
      mgr.destroy();
      managerRef.current = null;
      setCanvasYjsManager(null);
      setManager(null);
      setYjsLoading(false);
    };
    // onAuthFailed intentionally omitted from deps — it should be stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, token, wsUrl, enabled]);

  const createSnapshot = useCallback(() => managerRef.current?.createSnapshot() || new Uint8Array(0), []);
  const restoreSnapshot = useCallback((binary: Uint8Array) => managerRef.current?.restoreSnapshot(binary), []);

  const undo = useCallback(() => {
    const m = managerRef.current;
    if (m?.undo()) {
      setCanUndo(m.canUndo());
      setCanRedo(m.canRedo());
    }
  }, []);

  const redo = useCallback(() => {
    const m = managerRef.current;
    if (m?.redo()) {
      setCanUndo(m.canUndo());
      setCanRedo(m.canRedo());
    }
  }, []);

  return {
    manager: managerRef.current,
    awareness: managerRef.current?.awareness || null,
    createSnapshot,
    restoreSnapshot,
    undo,
    redo,
    canUndo,
    canRedo,
    edgeSelections,
    yjsUndo: undo,
    yjsRedo: redo,
    yjsCanUndo: canUndo,
    yjsCanRedo: canRedo,
    yjsEnabled: !!id && enabled,
    yjsLoading,
  };
};
