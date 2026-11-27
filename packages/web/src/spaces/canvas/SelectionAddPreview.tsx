// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

import { Position, ViewportPortal, getBezierPath, useStore, type ReactFlowState } from '@xyflow/react';
import * as React from 'react';

import { boundsOf, placedNodes, previewWires, type SelectionAddNode } from '@web/spaces/canvas/selection-add';
import { SELECTION_ADD_PREVIEW_Z } from '@web/spaces/canvas/viewport-layers';

interface SelectionAddPreviewProps {
  /** The nodes the plus sits beside. */
  anchorIds: readonly string[];
  /** The nodes a pick would wire in. */
  sourceIds: readonly string[];
}

/** What the preview draws from: the nodes' geometry and the zoom. */
interface PreviewGeometry {
  anchors: SelectionAddNode[];
  sources: SelectionAddNode[];
  zoom: number;
}

/**
 * Whether two geometry reads draw the same picture, so the preview re-renders
 * only when a node it wires moves, resizes or the zoom changes.
 * @param a - The previous read.
 * @param b - The next read.
 * @returns Whether they are the same.
 * @throws {never} Never.
 */
function sameGeometry(a: PreviewGeometry, b: PreviewGeometry): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * The preview wires drawn while the selection plus's menu is open
 * (inner#2216): one from each node a pick would wire in, from its right
 * connection point to the plus, in the plain edge colour and under every
 * node and edge (`SELECTION_ADD_PREVIEW_Z`). Nothing is written to the
 * document and nothing takes the pointer.
 * @param root0 - Component props.
 * @param root0.anchorIds - The nodes the plus sits beside.
 * @param root0.sourceIds - The nodes a pick would wire in.
 * @returns The preview layer.
 */
export const SelectionAddPreview = React.memo(function SelectionAddPreview({
  anchorIds,
  sourceIds,
}: SelectionAddPreviewProps): React.JSX.Element {
  const selector = React.useCallback(
    (state: ReactFlowState): PreviewGeometry => ({
      anchors: placedNodes(anchorIds, (id) => state.nodeLookup.get(id)),
      sources: placedNodes(sourceIds, (id) => state.nodeLookup.get(id)),
      zoom: state.transform[2],
    }),
    [anchorIds, sourceIds],
  );
  const geometry = useStore(selector, sameGeometry);
  const bounds = boundsOf(geometry.anchors);
  const wires = bounds ? previewWires(geometry.sources, bounds, geometry.zoom) : [];
  return (
    <ViewportPortal>
      <svg
        data-testid='selection-add-preview'
        aria-hidden='true'
        className='pointer-events-none absolute left-0 top-0 overflow-visible'
        width={1}
        height={1}
        style={{ zIndex: SELECTION_ADD_PREVIEW_Z }}
      >
        {wires.map((wire) => {
          const [path] = getBezierPath({
            sourceX: wire.from.x,
            sourceY: wire.from.y,
            sourcePosition: Position.Right,
            targetX: wire.to.x,
            targetY: wire.to.y,
            targetPosition: Position.Left,
          });
          return (
            <path
              key={wire.sourceId}
              d={path}
              fill='none'
              stroke='var(--xy-edge-stroke-default)'
              strokeWidth={1}
            />
          );
        })}
      </svg>
    </ViewportPortal>
  );
});
