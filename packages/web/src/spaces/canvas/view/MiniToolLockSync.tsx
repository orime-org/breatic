/**
 * `MiniToolLockSync` — bridge component that mirrors `MiniToolContext`
 * state into Yjs `data.operationLocks` on the relevant source node.
 *
 * Why a separate component
 * ─────────────────────────
 * `MiniToolContext` lives in `features/mini-tools`, which the layered
 * architecture forbids from importing `spaces/canvas` hooks
 * (`features` < `spaces`). The Yjs operation-lock writers live on
 * `useCanvasActions` (in `spaces/canvas`). This bridge sits inside the
 * `spaces/canvas` tree, observes the context, and calls the writers —
 * the layering stays clean.
 *
 * Lifecycle
 * ─────────
 *   1. User picks a tool in `NodeFloatMenu`
 *      → `MiniToolContext.pickTool` sets `active`
 *      → this effect fires
 *      → `addOperationLock(nodeId, toolId)` writes to Yjs
 *   2. User clicks Apply / Cancel
 *      → `MiniToolContext.clear` sets `active = null`
 *      → effect fires, releases the previous lock
 *   3. User switches tool on the same node
 *      → context replaces `active`
 *      → effect releases the old `(nodeId, toolId)`, acquires the new one
 *
 * Renders nothing. Mounted once inside `ProjectCanvasContent`.
 */
import { useEffect, useRef } from 'react';

import { useMiniTool } from '@/features/mini-tools';
import { useCanvasActions } from '@/spaces/canvas/hooks/useCanvasActions';

const MiniToolLockSync: React.FC = () => {
  const { active } = useMiniTool();
  const { addOperationLock, removeOperationLock } = useCanvasActions();

  // Track the previous (nodeId, toolId) so the effect can release the
  // old lock when switching tools or clearing.
  const prev = useRef<{ nodeId: string; toolId: string } | null>(null);

  useEffect(() => {
    const previous = prev.current;
    const next = active ? { nodeId: active.nodeId, toolId: active.toolId } : null;

    // Release the previous lock when it differs from the next.
    if (
      previous &&
      (!next || previous.nodeId !== next.nodeId || previous.toolId !== next.toolId)
    ) {
      removeOperationLock(previous.nodeId, previous.toolId);
    }

    // Acquire the new lock (idempotent — writer skips if already held).
    if (next && (!previous || previous.nodeId !== next.nodeId || previous.toolId !== next.toolId)) {
      addOperationLock(next.nodeId, next.toolId);
    }

    prev.current = next;
  }, [active, addOperationLock, removeOperationLock]);

  // Component-unmount safety: if the canvas itself is torn down while
  // a tool is active, release the held lock so the source node isn't
  // stuck. Collab's disconnect hook is the eventual safety net for the
  // truly-leaves-the-doc case, but releasing here is cheap and avoids
  // a redundant Yjs round-trip for in-tab navigation.
  useEffect(() => {
    return () => {
      if (prev.current) {
        removeOperationLock(prev.current.nodeId, prev.current.toolId);
      }
    };
  }, [removeOperationLock]);

  return null;
};

export default MiniToolLockSync;
