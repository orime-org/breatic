// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Where a mini-tool run's results land and what they are called (inner#1303).
 *
 * The whole batch is placed in one call because a grid's rows are as tall as
 * their tallest tile, which needs every tile's size at once.
 */

import { defaultParamsOf, outputsOf, type MiniToolOutput, type MiniToolSpec } from '@breatic/shared/mini-tools';

import { EMPTY_NODE_SIZE } from '@web/spaces/canvas/group-geometry';
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
}

// What a media node draws around its picture: the shell's 1px border
// (`NodeShell`) and `NodeMediaInset`'s `p-1`, on each side.
const MEDIA_FRAME_PX = 2 * 1 + 2 * 4;

/**
 * How tall a node is with this picture in it, drawn at the node's width.
 * @param size - The picture's pixels, when known.
 * @returns The node's height in flow coordinates.
 */
function nodeHeight(size: OutputSize | undefined): number {
  if (!size || size.width <= 0 || size.height <= 0) return EMPTY_NODE_SIZE.height;
  return ((EMPTY_NODE_SIZE.width - MEDIA_FRAME_PX) * size.height) / size.width + MEDIA_FRAME_PX;
}

/**
 * The pixel sizes a run's results will have, as far as they are known before
 * the browser makes them, so the nodes can be built at the press (inner#1303
 * §6.7): a grid's tiles come from the source's size by the export's own cut;
 * every other tool's layout does not depend on its results' sizes.
 * @param spec - The tool.
 * @param params - The run's params.
 * @param source - The source's pixel size, where its node knows it.
 * @param source.width - Its width.
 * @param source.height - Its height.
 * @returns One size per result, or none when they are not known yet.
 */
export function plannedOutputSizes(
  spec: MiniToolSpec,
  params: Record<string, unknown>,
  source: { width?: number | undefined; height?: number | undefined },
): OutputSize[] {
  if (spec.outputLayout !== 'grid' || source.width === undefined || source.height === undefined) return [];
  const { rows, cols } = { ...defaultParamsOf(spec), ...params } as { rows: number; cols: number };
  return gridTileRects(source.width, source.height, rows, cols).map(({ width, height }) => ({ width, height }));
}

/**
 * Lays a run's results out: a column for every tool, except a `"grid"` tool
 * whose results go rows by columns with each row as tall as its tallest tile.
 * @param spec - The tool.
 * @param params - The run's params.
 * @param sizes - Each result's pixel size, in order, where the run knows it.
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
  const heights = outputs.map((_, index) => nodeHeight(sizes[index]));
  /**
   * One result's placement.
   * @param output - The result.
   * @param index - Its place in the batch.
   * @param label - What goes between the prefix and the source name.
   * @param x - Its left, from the batch's.
   * @param y - Its top, from the batch's.
   * @returns The placement.
   */
  const placed = (output: MiniToolOutput, index: number, label: string, x: number, y: number): PlacedOutput => ({
    output,
    name: `${output.namePrefix}-${label}${sourceName ?? MODALITY_LABEL[output.modality]}`,
    x,
    y,
    width: EMPTY_NODE_SIZE.width,
    height: heights[index]!,
  });

  if (spec.outputLayout !== 'grid') {
    return outputs.map((output, index) =>
      placed(output, index, spec.output ? `${index + 1}-` : '', 0, index * NODE_STEP.y),
    );
  }

  const cols = outputs.length / gridRows(spec, params);
  const result: PlacedOutput[] = [];
  let top = 0;
  for (let start = 0; start < outputs.length; start += cols) {
    const row = start / cols + 1;
    for (let col = 0; col < cols; col++) {
      result.push(placed(outputs[start + col]!, start + col, `r${row}c${col + 1}-`, col * NODE_STEP.x, top));
    }
    top += Math.max(...heights.slice(start, start + cols)) + GAP_PX;
  }
  return result;
}

/**
 * A grid tool's row count: its result count with every factor but the first
 * (rows) held at one, so a missing param falls back the way `outputsOf` does.
 * @param spec - The tool.
 * @param params - The run's params.
 * @returns The rows.
 * @throws {Error} When the tool's count is not a product.
 */
function gridRows(spec: MiniToolSpec, params: Record<string, unknown>): number {
  if (spec.outputCount?.kind !== 'product') throw new Error(`${spec.id} lays out a grid without a product count`);
  const [, ...others] = spec.outputCount.params;
  return outputsOf(spec, { ...params, ...Object.fromEntries(others.map((key) => [key, 1])) }).length;
}
