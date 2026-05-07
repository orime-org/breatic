import { createContext, useContext, useState, useCallback, type ReactNode } from 'react';

/**
 * A node that's pending in the local user's browser only — not yet in Yjs.
 *
 * Lifecycle:
 *  1. User clicks operation; frontend creates LocalPendingNode (in this provider)
 *  2. For Cat A (frontend-instant): on success, frontend creates Yjs node + edge,
 *     then removes the LocalPendingNode entry
 *  3. For Cat B (backend-async): once POST returns 202 + task_id, frontend creates
 *     Yjs node with state='handling', creates edge, then removes the LocalPendingNode
 *  4. Browser close: provider unmounts; localPending entries are gone (Yjs has no record)
 *
 * Per spec §3.3.
 */
export interface LocalPendingNode {
  /** UUID v4 (the eventual Yjs nodeId). */
  id: string;
  /** Node type string (e.g. '1002' for image). */
  type: string;
  /** Parent node id when mini-tool produced this node. */
  sourceNodeId?: string;
  /** Canvas coordinates for when the node is promoted to Yjs. */
  position: { x: number; y: number };
  /** Optional partial data fields to seed on promotion. */
  partialData?: { name?: string; operation?: string; operationParams?: Record<string, unknown> };
  /** Error when the frontend operation failed before the node was written to Yjs. */
  errorMessage?: string;
  /** Epoch ms — for stale detection if needed. */
  startedAt: number;
}

interface LocalPendingContextValue {
  pending: Map<string, LocalPendingNode>;
  addPending: (node: LocalPendingNode) => void;
  updatePending: (id: string, patch: Partial<LocalPendingNode>) => void;
  removePending: (id: string) => void;
  getPending: (id: string) => LocalPendingNode | undefined;
}

const LocalPendingContext = createContext<LocalPendingContextValue | null>(null);

/**
 * Provider for local-only pending node state.
 *
 * Mount this at the project page layout root so all canvas components can
 * access it. The provider is intentionally lightweight — it only tracks
 * in-flight node creation before the node enters Yjs.
 *
 * Rendering of LocalPendingNodes on the canvas (visual feedback to the local
 * user) is PR-C+ scope. This provider just sets up storage + lifecycle hooks.
 */
export function LocalPendingProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<Map<string, LocalPendingNode>>(() => new Map());

  const addPending = useCallback((node: LocalPendingNode) => {
    setPending((prev) => {
      const next = new Map(prev);
      next.set(node.id, node);
      return next;
    });
  }, []);

  const updatePending = useCallback((id: string, patch: Partial<LocalPendingNode>) => {
    setPending((prev) => {
      const existing = prev.get(id);
      if (!existing) return prev;
      const next = new Map(prev);
      next.set(id, { ...existing, ...patch });
      return next;
    });
  }, []);

  const removePending = useCallback((id: string) => {
    setPending((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Map(prev);
      next.delete(id);
      return next;
    });
  }, []);

  const getPending = useCallback((id: string) => pending.get(id), [pending]);

  return (
    <LocalPendingContext.Provider value={{ pending, addPending, updatePending, removePending, getPending }}>
      {children}
    </LocalPendingContext.Provider>
  );
}

/**
 * Access the local pending node store.
 *
 * @throws Error when used outside of {@link LocalPendingProvider}.
 */
export function useLocalPending(): LocalPendingContextValue {
  const ctx = useContext(LocalPendingContext);
  if (!ctx) throw new Error('useLocalPending must be used inside <LocalPendingProvider>');
  return ctx;
}
