// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * Where a mini-tool run's results land and what they are called (inner#1303).
 *
 * The whole batch is placed in one call because a grid's rows are as tall as
 * their tallest tile, which needs every tile's size at once.
 */

import {
  gridShapeOf,
  isModelTool,
  outputsOf,
  pickedCellsOf,
  type MiniToolOutput,
  type MiniToolSpec,
} from '@breatic/shared/mini-tools';

import { EMPTY_NODE_SIZE, MEDIA_FRAME_PX, PLANNED_BODY_MIN_PX, mediaNodeHeight } from '@web/spaces/canvas/group-geometry';
import { GAP_PX, NODE_STEP } from '@web/spaces/canvas/drop-layout';
import { gridTileRects } from '@web/spaces/canvas/mini-tool/grid-export';
import { MODALITY_LABEL } from '@web/spaces/canvas/nodes/_shared/modality';

/** A result's pixel size, when the run already knows it. */
export interface OutputSize {
  width: number;
  height: number;
}

/** One result's name and footprint, relative to where the batch starts. */
export interface PlacedOutput {
  output: MiniToolOutput;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  /** The result's pixel size, when the run plans it; its node is built with it. */
  size?: OutputSize;
}

/**
 * How tall a node is with this picture in it, drawn at the node's width, and
 * never shorter than its body while it waits for the picture.
 * @param size - The picture's pixels, when known.
 * @returns The node's height in flow coordinates.
 */
function nodeHeight(size: OutputSize | undefined): number {
  if (!size || size.width <= 0 || size.height <= 0) return EMPTY_NODE_SIZE.height;
  return Math.max(mediaNodeHeight(size.width, size.height), PLANNED_BODY_MIN_PX + MEDIA_FRAME_PX);
}

/**
 * Whether a tool's result is its source redrawn at its own size: the adjust
 * redraws it through its filters, the markup draws over it. Its node is built
 * at that size, so the panel reads the size before the run.
 * @param spec - The tool.
 * @returns True for those tools.
 */
export function keepsSourceSize(spec: MiniToolSpec): boolean {
  // A browser tool's result is drawn here; a server tool's size is the server's.
  if (isModelTool(spec) || spec.run.kind !== 'browser') return false;
  return spec.markup === true || spec.params.some((param) => param.kind === 'adjust');
}

/**
 * The pixel sizes a run's results will have, as far as they are known before
 * the browser makes them, so the nodes can be built at the press (inner#1303
 * §6.7): a grid's come from the source's size by the export's own cut, one per
 * cell of the whole grid; an adjust's and a markup's are the source's own; no
 * other tool's are known before its result exists.
 * @param spec - The tool.
 * @param params - The run's params.
 * @param source - The source's pixel size, where its node knows it.
 * @param source.width - Its width.
 * @param source.height - Its height.
 * @returns One size per grid cell, the source's size for a result as large, or none.
 */
export function plannedOutputSizes(
  spec: MiniToolSpec,
  params: Record<string, unknown>,
  source: { width?: number | undefined; height?: number | undefined },
): OutputSize[] {
  if (source.width === undefined || source.height === undefined) return [];
  if (keepsSourceSize(spec)) return [{ width: source.width, height: source.height }];
  const shape = gridShapeOf(spec, params);
  if (shape === null) return [];
  return gridTileRects(source.width, source.height, shape.rows, shape.cols).map(({ width, height }) => ({ width, height }));
}

/**
 * Build the shared footprint and name of one output in a complete layout.
 * @param output - Its registry descriptor.
 * @param label - The plan's optional index or grid-cell label.
 * @param sourceName - The source node's name.
 * @param x - Its horizontal offset within the batch.
 * @param y - Its vertical offset within the batch.
 * @param size - Known output pixels.
 * @returns The output's name and node footprint.
 * @throws {never} Never.
 */
export function placeMiniToolOutput(output: MiniToolOutput, label: string, sourceName: string | undefined, x: number, y: number, size: OutputSize | undefined): PlacedOutput {
  return {
    output,
    name: `${output.namePrefix}-${label}${sourceName ?? MODALITY_LABEL[output.modality]}`,
    x, y, width: EMPTY_NODE_SIZE.width, height: nodeHeight(size),
    ...(size !== undefined && size.width > 0 && size.height > 0 && { size }),
  };
}

/**
 * Lays a run's results out: a column for every tool, except a `"grid"` tool,
 * whose results each sit at their own cell's row and column. Every row is as
 * tall as its tallest tile across the whole grid, picked or not, so a row
 * nobody picked between two that are keeps its height; the rows and columns
 * before the first picked one are closed up.
 * @param spec - The tool.
 * @param params - The run's params.
 * @param sizes - Each result's pixel size, where the run knows it: in result
 *   order, or for a `"grid"` tool, one per cell of the whole grid by row-major index.
 * @param sourceName - The source node's name.
 * @returns One placement per result, in order.
 */
export function outputPlacementOf(
  spec: MiniToolSpec,
  params: Record<string, unknown>,
  sizes: readonly (OutputSize | undefined)[],
  sourceName: string | undefined,
): PlacedOutput[] {
  const outputs = outputsOf(spec, params);
  const shape = gridShapeOf(spec, params);
  if (shape === null) {
    return outputs.map((output, index) =>
      placeMiniToolOutput(output, spec.output ? `${index + 1}-` : '', sourceName, 0, index * NODE_STEP.y, sizes[index]),
    );
  }

  const { rows, cols } = shape;
  const cells = pickedCellsOf(spec, params) ?? [];
  if (cells.length === 0) return [];
  const firstRow = Math.floor(Math.min(...cells) / cols);
  const firstCol = Math.min(...cells.map((cell) => cell % cols));
  const tops: number[] = [];
  let top = 0;
  for (let row = firstRow; row < rows; row++) {
    tops[row] = top;
    const heights = Array.from({ length: cols }, (_, col) => nodeHeight(sizes[row * cols + col]));
    top += Math.max(...heights) + GAP_PX;
  }
  return cells.map((cell, index) => {
    const row = Math.floor(cell / cols);
    const col = cell % cols;
    return placeMiniToolOutput(
      outputs[index]!,
      `r${row + 1}c${col + 1}-`,
      sourceName,
      (col - firstCol) * NODE_STEP.x,
      tops[row]!,
      sizes[cell],
    );
  });
}
