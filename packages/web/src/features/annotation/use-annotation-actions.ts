/**
 * `useAnnotationActions` — three-state annotation lifecycle hook.
 *
 * The pattern matches the LocalPending lifecycle from
 * `LocalPendingProvider`:
 *
 *   click 批注  →  addPending (composer renders)
 *   submit text →  createDataNode (Yjs)  +  removePending
 *   cancel      →  removePending
 *
 * `LocalPending` plays a second role beyond "stash composer state":
 * it's the **submission lock**. While there's an annotation pending,
 * a second click on 批注 is a no-op — the lock prevents two
 * composers fighting over the viewport. F6 caps the lock at one
 * pending annotation per user; multiple-pending UX is plausible
 * later but adds complexity (which composer steals focus? how to
 * disambiguate Esc?) we don't need today.
 *
 * Annotations are intentionally a Cat A (frontend-instant) flow —
 * `createDataNode` writes to Yjs synchronously inside a transact,
 * so the "pending" window is just the user's typing time. There is
 * no backend roundtrip; an annotation can never end up in a
 * `state: 'handling'` limbo.
 */
import { useCallback, useMemo } from 'react';
import { useCanvasActions } from '@/spaces/canvas/hooks/useCanvasActions';
import { useLocalPending } from '@/spaces/canvas/contexts/LocalPendingProvider';
import { getProjectCanvasViewportApi } from '@/spaces/canvas/types';

/** Yjs node-type id for annotation. Mirrors '1002' / '1003' / '1004' but kept named since annotation isn't part of the numbered modality family. */
export const ANNOTATION_NODE_TYPE = 'annotation';

interface UseAnnotationActionsResult {
  /**
   * The currently in-flight annotation, if any. `null` when no
   * annotation is being composed. The composer reads this to know
   * what to render; the LeftFloatingMenu reads this for the lock.
   */
  pendingAnnotation: {
    id: string;
    position: { x: number; y: number };
  } | null;
  /**
   * Drop a new annotation at the viewport center and open the
   * composer. No-op when an annotation is already pending (the
   * lock).
   *
   * @returns The new pending id, or `null` when blocked by the lock.
   */
  dropAnnotation: () => string | null;
  /**
   * Promote a pending annotation to Yjs with the given text.
   * Empty / whitespace-only text falls through to `cancelAnnotation`
   * — submitting nothing should leave no trace, not commit a blank
   * card.
   */
  submitAnnotation: (id: string, text: string) => void;
  /** Drop the pending entry without writing to Yjs. */
  cancelAnnotation: (id: string) => void;
}

/**
 * Hook over `LocalPendingProvider` + `useCanvasActions` that
 * implements the annotation lifecycle. Stateless from the outside —
 * all source-of-truth is in `LocalPendingProvider`'s map.
 */
export function useAnnotationActions(): UseAnnotationActionsResult {
  const { pending, addPending, removePending } = useLocalPending();
  const { createDataNode } = useCanvasActions();

  const pendingAnnotation = useMemo(() => {
    // Array.from over .values() avoids the downlevelIteration TS
    // gripe and reads cleanly enough — the map size is bounded at
    // 1 by the lock, so no perf concern.
    const items = Array.from(pending.values());
    for (const node of items) {
      if (node.type === ANNOTATION_NODE_TYPE) {
        return { id: node.id, position: node.position };
      }
    }
    return null;
  }, [pending]);

  const dropAnnotation = useCallback((): string | null => {
    if (pendingAnnotation) {
      // Lock engaged — caller already has one composer open; ignore
      // the second click rather than racing a new entry into the
      // map. The LeftFloatingMenu also disables the button visually,
      // but defensive guards are cheap and the visual feedback can
      // race a fast clicker.
      return null;
    }
    const center = getProjectCanvasViewportApi()?.getViewportCenterFlow();
    if (!center) {
      // Canvas not mounted (e.g. user is on document space). Drop
      // silently — annotation is a canvas-only affordance and the
      // entry-point button is hidden in that state.
      return null;
    }
    const id = crypto.randomUUID();
    addPending({
      id,
      type: ANNOTATION_NODE_TYPE,
      position: { x: center.x, y: center.y },
      partialData: { name: 'annotation' },
      startedAt: Date.now(),
    });
    return id;
  }, [pendingAnnotation, addPending]);

  const submitAnnotation = useCallback(
    (id: string, text: string) => {
      const trimmed = text.trim();
      if (!trimmed) {
        // Empty submit = cancel. We use `removePending` directly
        // rather than calling `cancelAnnotation` so this branch
        // doesn't turn into "submitAnnotation depends on
        // cancelAnnotation depends on submitAnnotation" if either
        // grows side effects later.
        removePending(id);
        return;
      }
      const entry = pending.get(id);
      if (!entry) {
        // Pending dropped beneath us (rare race — second tab cancelled
        // via memory pressure). Skip the Yjs write; nothing to do.
        return;
      }
      createDataNode({
        type: ANNOTATION_NODE_TYPE,
        position: entry.position,
        data: {
          name: entry.partialData?.name ?? 'annotation',
          content: trimmed,
        },
      });
      removePending(id);
    },
    [pending, createDataNode, removePending],
  );

  const cancelAnnotation = useCallback(
    (id: string) => {
      removePending(id);
    },
    [removePending],
  );

  return {
    pendingAnnotation,
    dropAnnotation,
    submitAnnotation,
    cancelAnnotation,
  };
}
