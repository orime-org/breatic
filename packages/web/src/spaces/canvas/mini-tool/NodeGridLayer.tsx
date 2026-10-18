// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { useStore } from '@xyflow/react';
import * as React from 'react';

import { gridShapeOf, miniToolById, pickedCellsOf } from '@breatic/shared/mini-tools';

import { Checkbox } from '@web/components/ui/checkbox';
import { useCanvasSession } from '@web/spaces/canvas/canvas-context';
import { miniToolOpenOn } from '@web/stores/canvas-session';
import { OUTSIDE_DIM, handleScale } from '@web/spaces/canvas/crop/crop-geometry';

/** A frame inside the tile whose checkbox has the keyboard focus, one line wide in each tone. */
const FOCUS_FRAME = [
  'has-[:focus-visible]:after:content-[\'\']',
  'has-[:focus-visible]:after:pointer-events-none',
  'has-[:focus-visible]:after:absolute',
  'has-[:focus-visible]:after:[inset:calc(var(--grid-line)*4)]',
  'has-[:focus-visible]:after:border-solid',
  'has-[:focus-visible]:after:border-foreground',
  'has-[:focus-visible]:after:[border-width:var(--grid-line)]',
  'has-[:focus-visible]:after:outline',
  'has-[:focus-visible]:after:outline-background',
  'has-[:focus-visible]:after:[outline-width:var(--grid-line)]',
].join(' ');

/** The ring of a tile's mark, white on the picture in either theme. */
const MARK_RING = 'rgb(255 255 255)';
import { useMediaGeometry } from '@web/spaces/canvas/crop/media-geometry';
import { TOOL_LAYER_CLASS, stopNodeClick } from '@web/spaces/canvas/mini-tool/tool-layer-input';
import { gridCuts } from '@web/spaces/canvas/mini-tool/grid-export';

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
 * Where the export cuts a side, as fractions of it; an even split while the
 * side's pixels are not known.
 * @param side - The side in pixels, when known.
 * @param parts - How many parts.
 * @returns The cuts from 0 to 1.
 */
function cutFractions(side: number | undefined, parts: number): number[] {
  const length = side ?? parts;
  return gridCuts(length, parts).map((cut) => cut / length);
}

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
  // Read only while the layer shows, so a zoom does not re-render it on every node.
  const zoom = useStore((s) => (shape === null ? 1 : s.transform[2]));
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
  // The lines sit where the export cuts the source (§6.4); an even split until
  // the source's pixels are known.
  const natural = geometry.natural;
  const xs = cutFractions(natural?.width, cols);
  const ys = cutFractions(natural?.height, rows);
  const line = 'absolute bg-background outline outline-foreground';
  const roomy =
    (geometry.box.width / cols) * zoom >= CHECK_ROOM_PX && (geometry.box.height / rows) * zoom >= CHECK_ROOM_PX;
  return (
    // eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions -- the click is only kept from the node
    <div
      data-testid='mini-tool-grid-layer'
      className={`${TOOL_LAYER_CLASS} absolute grid`}
      onClick={stopNodeClick}
      style={{
        left: geometry.at.x,
        top: geometry.at.y,
        width: geometry.box.width,
        height: geometry.box.height,
        // A line's width at this zoom, for the tile that holds the focus.
        ['--grid-line' as string]: `${scale}px`,
        gridTemplateColumns: xs.slice(1).map((x, i) => `${x - (xs[i] ?? 0)}fr`).join(' '),
        gridTemplateRows: ys.slice(1).map((y, i) => `${y - (ys[i] ?? 0)}fr`).join(' '),
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
            // The tile whose checkbox has the keyboard focus is framed in the
            // cut lines' two tones, inset from the cuts so the two never
            // overlap, and the focus shows on any picture.
            className={`nodrag nopan relative cursor-pointer ${FOCUS_FRAME}`}
            style={on ? undefined : { backgroundColor: OUTSIDE_DIM }}
            onClick={() => toggle(cell)}
          >
            {roomy ? (
              <Checkbox
                data-testid={`mini-tool-grid-check-${cell}`}
                checked={on}
                onClick={(event) => event.stopPropagation()}
                onCheckedChange={() => toggle(cell)}
                // The mark sits on the picture, so it looks the same in both
                // themes, as OUTSIDE_DIM does: picked is a dark disc with a
                // white tick, left out an empty white ring; both carry a
                // shadow that lifts them off any pixel. The white ring is the
                // same in both states, so it is no selected-state border.
                className='absolute rounded-full bg-[rgb(0_0_0/0.25)] shadow-[0_1px_3px_rgb(0_0_0/0.45)] focus-visible:ring-0 data-[state=checked]:bg-[rgb(30_30_30)] data-[state=checked]:text-white'
                style={{
                  borderColor: MARK_RING,
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
          style={{ left: `${(xs[i + 1] ?? 0) * 100}%`, width: scale, outlineWidth: scale }}
        />
      ))}
      {Array.from({ length: rows - 1 }, (_, i) => (
        <div
          key={`r${i}`}
          data-testid='mini-tool-grid-row'
          className={`${line} pointer-events-none inset-x-0`}
          style={{ top: `${(ys[i + 1] ?? 0) * 100}%`, height: scale, outlineWidth: scale }}
        />
      ))}
    </div>
  );
}
