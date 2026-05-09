/**
 * `useOutsidePanelClose` — close the active LeftFloatingMenu panel on
 * three triggers (spec/02 §4.3 v13):
 *   1. Mouse down anywhere outside both the panel and the trigger button
 *   2. Pressing the matching menu icon a second time (toggle — handled
 *      by the menu component itself, not here)
 *   3. ESC
 *
 * Why "outside trigger" too: without it, clicking the same trigger to
 * dismiss the panel would race the document-level outside-close — the
 * panel closes before the button's `onClick` fires, then the click
 * re-opens it = toggle never closes. Skipping closes when the click
 * lands inside any element marked `[data-panel-trigger]` lets the
 * trigger button handle the toggle cleanly.
 */
import { useEffect, useRef } from 'react';

/**
 * @param panelKey - The trigger button is expected to carry
 *   `data-panel-trigger="<panelKey>"`. Closes are skipped when the
 *   mousedown target is inside *any* trigger button (string match on
 *   the dataset value), so re-clicking the same trigger toggles
 *   instead of closing-then-reopening.
 * @param onClose - Invoked when an outside click or ESC fires.
 *
 * @returns A ref to attach to the panel root element. The hook reads
 *   `mousedown.target` and ignores events inside `panelRef.current`.
 */
export function useOutsidePanelClose(
  panelKey: string,
  onClose: () => void,
) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const handleMouseDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (!target) return;
      if (panelRef.current && panelRef.current.contains(target)) return;
      // Click landed inside *any* panel trigger button — let the
      // trigger's own onClick toggle the panel; don't close here.
      if (target.closest('[data-panel-trigger]')) return;
      onCloseRef.current();
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCloseRef.current();
    };
    document.addEventListener('mousedown', handleMouseDown);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('mousedown', handleMouseDown);
      document.removeEventListener('keydown', handleKey);
    };
    // panelKey is unused at runtime but kept in the API so callers
    // self-document which trigger to ignore (and so future polish
    // can enforce that the trigger element exists).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [panelKey]);

  return panelRef;
}
