// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { useStore } from '@xyflow/react';
import * as React from 'react';

import { gridShapeOf, miniToolById, pickedCellsOf } from '@breatic/shared/mini-tools';

import { Checkbox } from '@web/components/ui/checkbox';
import { useCanvasSession } from '@web/spaces/canvas/canvas-context';
import { miniToolOpenOn } from '@web/stores/canvas-session';
import { OUTSIDE_DIM, handleScale } from '@web/spaces/canvas/crop/crop-geometry';
import { useMediaGeometry } from '@web/spaces/canvas/crop/media-geometry';

interface NodeGridLayerProps {
  /** The node this layer belongs to. */
  nodeId: string;
  /** The node's outer positioned wrapper; see `NodeCropLayer`. */
  wrapper: HTMLElement | null;
}

/** A tile's checkbox, in screen pixels: 16 across, 4 from the tile's corner. */
const CHECK_PX = 16;
const CHECK_INSET_PX = 4;
/** The smallest tile side on screen that holds the checkbox and its inset on both sides. */
const CHECK_ROOM_PX = CHECK_PX + 2 * CHECK_INSET_PX;

/**
 * The grid tool's layer over the node's picture while its panel is open on it
 * (inner#1303 §6.4, A15): the lines the picture is cut along, and one tile per
 * cell the reader picks or leaves out. The tile's checkbox is its one control
 * (Tab, Space); a click anywhere on the tile toggles it too. A tile left out is
 * dimmed; one too small on screen for its checkbox shows the dimming alone.
 * @param root0 - Component props.
 * @param root0.nodeId - The node.
 * @param root0.wrapper - The node's outer wrapper.
 * @returns The layer, or null when no grid tool is open on this node.
 */
export function NodeGridLayer({ nodeId, wrapper }: NodeGridLayerProps): React.JSX.Element | null {
  const draft = useCanvasSession(miniToolOpenOn(nodeId));
  const setMiniToolParam = useCanvasSession((s) => s.setMiniToolParam);
  const spec = draft === null ? undefined : miniToolById(draft.toolId);
  const shape = spec === undefined || draft === null ? null : gridShapeOf(spec, draft.params);
  const geometry = useMediaGeometry(wrapper, shape !== null);
  const zoom = useStore((s) => s.transform[2]);
  // The lines and checkboxes counter the zoom, as the crop frame's handles do.
  const scale = handleScale(zoom);
  const picked = React.useMemo(
    () => new Set(spec === undefined || draft === null ? [] : (pickedCellsOf(spec, draft.params) ?? [])),
    [spec, draft],
  );
  const skipKey = spec?.outputCount?.kind === 'product' ? spec.outputCount.except : undefined;
  const total = shape === null ? 0 : shape.rows * shape.cols;
  const toggle = React.useCallback(
    (cell: number): void => {
      if (skipKey === undefined || total === 0) return;
      const skipped = Array.from({ length: total }, (_, index) => index).filter(
        (index) => (index === cell) === picked.has(index),
      );
      setMiniToolParam(skipKey, skipped);
    },
    [skipKey, total, picked, setMiniToolParam],
  );
  if (shape === null || geometry === null) return null;
  const { rows, cols } = shape;
  const line = 'absolute bg-background outline outline-foreground';
  const roomy =
    (geometry.box.width / cols) * zoom >= CHECK_ROOM_PX && (geometry.box.height / rows) * zoom >= CHECK_ROOM_PX;
  return (
    <div
      data-testid='mini-tool-grid-layer'
      className='absolute grid'
      style={{
        left: geometry.at.x,
        top: geometry.at.y,
        width: geometry.box.width,
        height: geometry.box.height,
        gridTemplateColumns: `repeat(${cols}, 1fr)`,
        gridTemplateRows: `repeat(${rows}, 1fr)`,
      }}
    >
      {Array.from({ length: rows * cols }, (_, cell) => {
        const on = picked.has(cell);
        return (
          // The tile's checkbox is its control, focusable and toggled by
          // Space; a click on the rest of the tile is the larger target for
          // the same toggle, and a tile too small for its checkbox is reached
          // by zooming in.
          // eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions
          <div
            key={cell}
            data-testid={`mini-tool-grid-tile-${cell}`}
            data-picked={on}
            className='nodrag nopan relative cursor-pointer'
            style={on ? undefined : { backgroundColor: OUTSIDE_DIM }}
            onClick={() => toggle(cell)}
          >
            {roomy ? (
              <Checkbox
                data-testid={`mini-tool-grid-check-${cell}`}
                checked={on}
                onClick={(event) => event.stopPropagation()}
                onCheckedChange={() => toggle(cell)}
                className='absolute rounded-full'
                style={{
                  top: CHECK_INSET_PX * scale,
                  right: CHECK_INSET_PX * scale,
                  transform: `scale(${scale})`,
                  transformOrigin: 'top right',
                }}
              />
            ) : null}
          </div>
        );
      })}
      {Array.from({ length: cols - 1 }, (_, i) => (
        <div
          key={`c${i}`}
          data-testid='mini-tool-grid-col'
          className={`${line} pointer-events-none inset-y-0`}
          style={{ left: `${((i + 1) * 100) / cols}%`, width: scale, outlineWidth: scale }}
        />
      ))}
      {Array.from({ length: rows - 1 }, (_, i) => (
        <div
          key={`r${i}`}
          data-testid='mini-tool-grid-row'
          className={`${line} pointer-events-none inset-x-0`}
          style={{ top: `${((i + 1) * 100) / rows}%`, height: scale, outlineWidth: scale }}
        />
      ))}
    </div>
  );
}
