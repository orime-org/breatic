/**
 * Canvas data context — provides nodes, edges, and toast notifications
 * to all components within the project page tree.
 *
 * This is the **read cache** layer between Yjs (source of truth) and
 * React components. Write operations go through {@link useCanvasActions}.
 *
 * ```
 * Yjs (source of truth)
 *   ↓  useCanvasYjs (incremental observe)
 * CanvasDataContext (read cache: nodes, edges, toasts)
 *   ↓  useCanvasData()
 * ReactFlow / RightPanel / AiChatPanel / ...
 * ```
 */

import {
  createContext,
  useContext,
  useState,
  useCallback,
  useMemo,
  useEffect,
  useRef,
  type ReactNode,
} from 'react';
import { nanoid } from 'nanoid';
import type { Node, Edge } from '@xyflow/react';
import type { CanvasSpaceManager } from '@/data/yjs/canvas-space';
import { useCanvasSpace } from '@/hooks/useCanvasSpace';

// ── Toast types ────────────────────────────────────────────────

export interface CanvasToast {
  id: string;
  nodeId: string;
  nodeName: string;
  type: 'completed' | 'failed';
  timestamp: number;
}

const TOAST_MAX = 5;
const TOAST_TTL = 5000;

// ── Context value ──────────────────────────────────────────────

export interface CanvasDataContextValue {
  nodes: Node[];
  edges: Edge[];
  /** O(1) node lookup by ID. */
  nodesById: Map<string, Node>;
  /** True while waiting for server sync to complete. */
  loading: boolean;
  /** Non-null if sync failed (timeout / auth error). */
  syncError: string | null;
  toasts: CanvasToast[];
  dismissToast: (id: string) => void;
  /** Apply local-only node changes (select, dimensions) without Yjs. */
  applyLocalNodeChanges: (changes: import('@xyflow/react').NodeChange[]) => void;
}

const CanvasDataContext = createContext<CanvasDataContextValue | null>(null);

// ── Provider ───────────────────────────────────────────────────

interface CanvasDataProviderProps {
  /**
   * The active canvas Space manager (v10 multi-doc — one
   * `project-{pid}/canvas-{spaceId}` doc per Space). Comes from
   * `useSpaceManagerPool` upstream; null while bootstrapping or
   * between Space switches.
   */
  manager: CanvasSpaceManager | null;
  children: ReactNode;
}

export function CanvasDataProvider({ manager, children }: CanvasDataProviderProps) {
  // ── Toast state ──
  const [toasts, setToasts] = useState<CanvasToast[]>([]);
  const timersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const pushToast = useCallback((toast: Omit<CanvasToast, 'id' | 'timestamp'>) => {
    const id = nanoid(8);
    const entry: CanvasToast = { ...toast, id, timestamp: Date.now() };

    setToasts((prev) => {
      const next = [...prev, entry];
      // Keep at most TOAST_MAX
      return next.length > TOAST_MAX ? next.slice(next.length - TOAST_MAX) : next;
    });

    // Auto-dismiss after TTL
    const timer = setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
      timersRef.current.delete(id);
    }, TOAST_TTL);
    timersRef.current.set(id, timer);
  }, []);

  const dismissToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
    const timer = timersRef.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timersRef.current.delete(id);
    }
  }, []);

  // Clean up timers on unmount
  useEffect(() => {
    return () => {
      timersRef.current.forEach((timer) => clearTimeout(timer));
      timersRef.current.clear();
    };
  }, []);

  // ── Yjs → nodes/edges (v10 canvas-{spaceId} doc) ──
  const { nodes, edges, loading, syncError, applyLocalNodeChanges } = useCanvasSpace(manager, pushToast);

  const nodesById = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);

  const value = useMemo<CanvasDataContextValue>(
    () => ({ nodes, edges, nodesById, loading, syncError, toasts, dismissToast, applyLocalNodeChanges }),
    [nodes, edges, nodesById, loading, syncError, toasts, dismissToast, applyLocalNodeChanges],
  );

  return (
    <CanvasDataContext.Provider value={value}>
      {children}
    </CanvasDataContext.Provider>
  );
}

// ── Consumer hook ──────────────────────────────────────────────

/**
 * Read canvas nodes, edges, and toasts from the CanvasDataContext.
 *
 * Must be called within a {@link CanvasDataProvider}.
 */
export function useCanvasData(): CanvasDataContextValue {
  const ctx = useContext(CanvasDataContext);
  if (!ctx) {
    throw new Error('useCanvasData must be used within a CanvasDataProvider');
  }
  return ctx;
}
