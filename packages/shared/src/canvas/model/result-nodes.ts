// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Where the nodes a run's results land on are placed before the run is asked
 * for, and what they are built as: a mini-tool's results a step right of the
 * node it runs on, and the text node an understanding or a transcription
 * writes. The browser builds them at the press, and collab builds them for an
 * external agent (breatic#1488 §10.2), from this one planner.
 */

import type { CanvasNodeFields } from '@shared/types/canvas-node.js';
import { outputTemplateOf, type MiniToolSpec } from '@shared/mini-tools/index.js';
import { NODE_STEP } from '@shared/canvas/model/drop-layout.js';
import { planGroupAround, type GroupCreationPlan } from '@shared/canvas/model/group-creation.js';
import { MODALITY_LABEL } from '@shared/canvas/model/modality-label.js';
import { createEmptyNode } from '@shared/canvas/model/node-factory.js';
import { outputPlacementOf, plannedOutputSizes, type PlacedOutput } from '@shared/canvas/model/output-placement.js';

/** A point on the canvas. */
interface Point {
  x: number;
  y: number;
}

/** Where a node is: its stored position, and the origin of the group holding it. */
export interface StoredPlacement {
  /** Its stored position, group-relative when it sits in one. */
  position: Point;
  /** The origin of the group holding it, or null when top-level. */
  groupOrigin: Point | null;
}

/** What a mini-tool's results are planned from about the node it runs on. */
export interface MiniToolResultSource {
  /** What the user calls it; the results are named after it. */
  name: string | undefined;
  /** Its picture's pixel width, when known. */
  width?: number | undefined;
  /** Its picture's pixel height, when known. */
  height?: number | undefined;
}

/**
 * Where a run's results start: one neighbour-step right of the node they
 * come from, level with it, measured on the canvas (a group's origin added),
 * since the results are top-level.
 * @param at - Where the node is.
 * @returns The absolute top-left the results are laid out from.
 */
export function resultBaseOf(at: StoredPlacement): Point {
  return {
    x: at.position.x + (at.groupOrigin?.x ?? 0) + NODE_STEP.x,
    y: at.position.y + (at.groupOrigin?.y ?? 0),
  };
}

/**
 * The result nodes a mini-tool run is built with, laid out from the sizes the
 * results will have (inner#1303 §6.7): each named for its output and the
 * source, and built at its planned picture size so it holds its place at the
 * size it will have; the result's own media fields replace it when it lands.
 * @param spec - The tool.
 * @param params - The run's params.
 * @param source - The node it runs on.
 * @param base - Where the results start ({@link resultBaseOf}).
 * @param createdBy - Who the nodes are created by.
 * @returns The nodes, with fresh ids, and each one's placement, in result order.
 */
export function planMiniToolResults(
  spec: MiniToolSpec,
  params: Record<string, unknown>,
  source: MiniToolResultSource,
  base: Point,
  createdBy: string,
): { nodes: CanvasNodeFields[]; placements: PlacedOutput[] } {
  const placements = outputPlacementOf(spec, params, plannedOutputSizes(spec, params, source), source.name);
  const nodes = placements.map((placed) => {
    const built = createEmptyNode(placed.output.modality, { x: base.x + placed.x, y: base.y + placed.y }, createdBy);
    const size = placed.size === undefined ? {} : { mediaWidth: placed.size.width, mediaHeight: placed.size.height };
    return { ...built, data: { ...built.data, name: placed.name, ...size } };
  });
  return { nodes, placements };
}

/**
 * The Group a tool that groups its results puts them in, and its name.
 * @param spec - The tool.
 * @param nodes - The result nodes.
 * @param placements - Each one's placement, in the same order.
 * @param sourceName - The source node's name.
 * @param groupId - The Group's id.
 * @returns The Group's plan and name, or null when there is nothing to frame.
 */
export function planMiniToolResultGroup(
  spec: MiniToolSpec,
  nodes: ReadonlyArray<{ id: string; type: string; position: Point }>,
  placements: readonly PlacedOutput[],
  sourceName: string | undefined,
  groupId: string,
): { plan: GroupCreationPlan; name: string } | null {
  const plan = planGroupAround(
    nodes.map((node, index) => ({
      id: node.id,
      type: node.type,
      position: node.position,
      width: placements[index]?.width,
      height: placements[index]?.height,
    })),
    groupId,
  );
  if (plan === null) return null;
  const output = outputTemplateOf(spec);
  return { plan, name: `${output.namePrefix}-${sourceName ?? MODALITY_LABEL[output.modality]}` };
}

/**
 * Where the text node an understanding or a transcription writes to goes.
 *
 * One neighbour-step to the right of the node it reads, level with it, with
 * no search for a free spot: a second run lands on the first, and the user
 * sorts out the stack (user 2026-09-19). One press produces one node, and
 * nothing here knows which press this is.
 * @param source - The read node's stored position.
 * @param source.x - Its stored x.
 * @param source.y - Its stored y.
 * @param groupOrigin - The origin of the group holding it, or null when it is top-level.
 * @returns The absolute position for the new node.
 */
export function understandNodePosition(source: Point, groupOrigin: Point | null): Point {
  return resultBaseOf({ position: source, groupOrigin });
}
