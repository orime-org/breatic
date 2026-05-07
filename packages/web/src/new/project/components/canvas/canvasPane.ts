import type { XYPosition } from '@xyflow/react';

/** Root wrapper on the local project canvas (`ProjectCanvas` outer shell). */
const localCanvasFlowRootSelector = '[data-project-canvas-flow-root]';

/**
 * Client-space center of the local canvas pane, or `null` if missing / not laid out.
 */
export function getLocalCanvasPaneClientCenter(): { x: number; y: number } | null {
  const root = typeof document !== 'undefined' ? document.querySelector(localCanvasFlowRootSelector) : null;
  if (!root) return null;
  const r = root.getBoundingClientRect();
  if (r.width < 4 || r.height < 4) return null;
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}

/**
 * Converts the canvas pane center to flow coordinates, or uses `fallback` screen point when the pane is unavailable.
 *
 * @param screenToFlowPosition - From `useReactFlow()` inside the local canvas.
 * @param fallback - Screen coordinates passed to `screenToFlowPosition` if the pane is missing.
 */
export function flowCenterFromCanvasPane(
  screenToFlowPosition: (p: XYPosition) => XYPosition,
  fallback: { x: number; y: number },
): XYPosition {
  const c = getLocalCanvasPaneClientCenter();
  return screenToFlowPosition(c ?? fallback);
}
