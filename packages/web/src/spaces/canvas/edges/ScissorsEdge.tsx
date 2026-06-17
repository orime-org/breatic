// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import {
  BaseEdge,
  EdgeLabelRenderer,
  getBezierPath,
  useStore,
  type EdgeProps,
} from '@xyflow/react';
import { Scissors } from 'lucide-react';
import * as React from 'react';

import { useTranslation } from '@web/i18n/use-translation';
import { useCanvasActions } from '@web/spaces/canvas/canvas-actions';

/**
 * Counter-scale factor that keeps an edge overlay (the scissors button) a
 * constant screen size at any canvas zoom: ReactFlow scales the whole edge
 * layer by `zoom`, so the overlay scales by `1 / zoom` against it — the same
 * mechanism the node name header uses (see `_shared/node-scale.ts`). Guards
 * the (never observed, defensive) non-positive case so the scale can't become
 * Infinity / negative.
 * @param zoom - The current canvas zoom (ReactFlow `transform[2]`).
 * @returns The `1 / zoom` overlay scale, or `1` when `zoom <= 0`.
 */
export function edgeOverlayScale(zoom: number): number {
  return zoom > 0 ? 1 / zoom : 1;
}

/**
 * Whether the delete-scissors button should render on an edge: only when the
 * edge is selected AND the canvas is editable (read-only viewers never see a
 * delete affordance).
 * @param selected - Whether the edge is currently selected.
 * @param readOnly - Whether the canvas is in read-only viewer mode.
 * @returns True when the scissors button should be shown.
 */
export function shouldShowScissors(selected: boolean, readOnly: boolean): boolean {
  return selected && !readOnly;
}

/**
 * Canvas edge with a delete affordance: the edge renders as a bezier line and,
 * when selected on an editable canvas, floats a scissors button at its
 * midpoint. Clicking the scissors deletes the edge (via the canvas actions →
 * Yjs `removeEdge`, which is undo-tracked). The button counter-scales by
 * `1 / zoom` so it stays a constant screen size at any zoom, matching the node
 * name header.
 * @param props - ReactFlow edge props; endpoints, `selected`, and `data` (which carries the viewer `readOnly` flag).
 * @returns The edge path plus the conditional scissors overlay.
 */
export function ScissorsEdge(props: EdgeProps): React.JSX.Element {
  const { id, selected, data } = props;
  const [edgePath, labelX, labelY] = getBezierPath({
    sourceX: props.sourceX,
    sourceY: props.sourceY,
    targetX: props.targetX,
    targetY: props.targetY,
    sourcePosition: props.sourcePosition,
    targetPosition: props.targetPosition,
  });
  const zoom = useStore((s) => s.transform[2]);
  const { deleteEdge } = useCanvasActions();
  const t = useTranslation();
  const readOnly = Boolean((data as { readOnly?: unknown } | undefined)?.readOnly);

  return (
    <>
      <BaseEdge id={id} path={edgePath} />
      {shouldShowScissors(Boolean(selected), readOnly) ? (
        <EdgeLabelRenderer>
          <button
            type='button'
            data-testid={`edge-scissors-${id}`}
            aria-label={t('canvas.edge.delete')}
            onClick={(event) => {
              event.stopPropagation();
              deleteEdge(id);
            }}
            style={{
              position: 'absolute',
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px) scale(${edgeOverlayScale(zoom)})`,
              pointerEvents: 'all',
            }}
            // `nopan nodrag` so pressing the scissors never pans the canvas or
            // starts a drag; rounded chip matching the viewport toolbar buttons.
            className='nopan nodrag inline-flex h-6 w-6 items-center justify-center rounded-full border border-border bg-popover text-muted-foreground shadow transition-colors hover:bg-accent hover:text-foreground'
          >
            <Scissors className='h-3.5 w-3.5' aria-hidden='true' />
          </button>
        </EdgeLabelRenderer>
      ) : null}
    </>
  );
}
