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
import { overlayCounterScale } from '@web/spaces/canvas/overlay-scale';

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
 * Yjs `removeEdge`, which is undo-tracked). The button counter-scales to a
 * constant screen size down to a floor zoom (then shrinks with the canvas) via
 * the shared `overlayCounterScale`, matching the node name header.
 * @param props - ReactFlow edge props; endpoints, `selected`, and `data` (which carries the viewer `readOnly` flag).
 * @returns The edge path plus the conditional scissors overlay.
 */
export const ScissorsEdge = React.memo(function ScissorsEdge(props: EdgeProps): React.JSX.Element {
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
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px) scale(${overlayCounterScale(zoom)})`,
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
});
