// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import {
  NodeResizeControl,
  ResizeControlVariant,
  type ControlPosition,
} from '@xyflow/react';
import * as React from 'react';

import type { GroupResizeBound } from '@web/spaces/canvas/group-geometry';

/** The 4 edge-line control positions (the rest are corner handles). */
const LINE_POSITIONS = new Set<string>(['top', 'right', 'bottom', 'left']);

interface GroupResizerProps {
  /**
   * Per-control minimum size (from `groupResizeBounds`) so ReactFlow's native
   * clamp hard-stops each edge / corner at "members + padding". One entry per
   * control; each control fixes its opposite edge, so the min is a true
   * per-edge hard-stop (no `shouldResize` veto, no post-commit repair).
   */
  bounds: ReadonlyArray<GroupResizeBound>;
  /**
   * Commit the resize result. ReactFlow's clamp guarantees the params already
   * respect every member's padding (even on a fast release), so the canvas
   * persists the rect verbatim.
   */
  onResizeEnd: (
    event: unknown,
    params: { x: number; y: number; width: number; height: number },
  ) => void;
}

/**
 * The Group's manual-resize chrome: 8 individually-bounded `NodeResizeControl`s
 * (4 edge lines + 4 corner handles), one per `bounds` entry. We render the
 * controls ourselves instead of `<NodeResizer>` because `<NodeResizer>` forces a
 * single shared min across all 8 — but a hard-stop that keeps members ≥ padding
 * inside needs a DIFFERENT min per edge (the dragged edge's min depends on which
 * opposite edge is anchored). Each control's min is the native ReactFlow clamp's
 * lever, which subtracts overshoot from pointer travel every frame → a true
 * hard-stop that is fast-drag-safe by construction. Styling (transparent line +
 * mode-aware corner squares + enlarged hit area) is inherited from the
 * `.react-flow__resize-control` rules in index.css.
 * @param root0 - Component props.
 * @param root0.bounds - Per-control minimum sizes from `groupResizeBounds`.
 * @param root0.onResizeEnd - Commit handler, pre-bound to the group id by the wrapper.
 * @returns The 8 resize controls.
 */
export function GroupResizer({
  bounds,
  onResizeEnd,
}: GroupResizerProps): React.JSX.Element {
  return (
    <>
      {bounds.map((bound) => (
        <NodeResizeControl
          key={bound.position}
          position={bound.position as ControlPosition}
          variant={
            LINE_POSITIONS.has(bound.position)
              ? ResizeControlVariant.Line
              : ResizeControlVariant.Handle
          }
          minWidth={bound.minWidth}
          minHeight={bound.minHeight}
          onResizeEnd={onResizeEnd}
        />
      ))}
    </>
  );
}
