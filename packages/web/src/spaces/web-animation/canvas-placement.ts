// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Putting an exported video on a canvas (#1490 design §9.1, §13.4). The one writer is `transitionCanvasPlacement`; the
 * button waits from the choice until the receipt.
 */

/** The placement's state. */
export type CanvasPlacementState =
  | { status: 'idle' }
  | { status: 'connecting'; canvasId: string }
  | { status: 'writing'; canvasId: string }
  | { status: 'awaiting_receipt'; canvasId: string; nodeId: string };

/** What can happen to a placement. */
export type CanvasPlacementEvent =
  | { type: 'choose'; canvasId: string }
  | { type: 'synced' }
  | { type: 'sync_timeout' }
  | { type: 'size_refused' }
  | { type: 'written'; nodeId: string }
  | { type: 'receipt' };

/** What the Space does after a transition. */
export type CanvasPlacementEffect =
  | { type: 'connect'; canvasId: string }
  | { type: 'write' }
  | { type: 'release' }
  | { type: 'toast_unreachable' }
  | { type: 'toast_canvas_full' }
  | { type: 'toast_placed'; canvasId: string; nodeId: string };

/** A transition's outcome. */
export interface CanvasPlacementTransition {
  state: CanvasPlacementState;
  effects: CanvasPlacementEffect[];
}

export const CANVAS_PLACEMENT_IDLE: CanvasPlacementState = { status: 'idle' };

/**
 * The placement after one event.
 * @param state - The placement now.
 * @param event - What happened.
 * @returns The placement after it and what the Space does next.
 * @throws {never} Never.
 */
export function transitionCanvasPlacement(state: CanvasPlacementState, event: CanvasPlacementEvent): CanvasPlacementTransition {
  const stay: CanvasPlacementTransition = { state, effects: [] };
  if (state.status === 'idle') {
    if (event.type !== 'choose') return stay;
    return { state: { status: 'connecting', canvasId: event.canvasId }, effects: [{ type: 'connect', canvasId: event.canvasId }] };
  }
  switch (state.status) {
    case 'connecting':
      if (event.type === 'synced') return { state: { status: 'writing', canvasId: state.canvasId }, effects: [{ type: 'write' }] };
      if (event.type === 'sync_timeout') return { state: CANVAS_PLACEMENT_IDLE, effects: [{ type: 'release' }, { type: 'toast_unreachable' }] };
      return stay;
    case 'writing':
      if (event.type === 'size_refused') return { state: CANVAS_PLACEMENT_IDLE, effects: [{ type: 'release' }, { type: 'toast_canvas_full' }] };
      if (event.type === 'written') {
        return {
          state: { status: 'awaiting_receipt', canvasId: state.canvasId, nodeId: event.nodeId },
          effects: [{ type: 'toast_placed', canvasId: state.canvasId, nodeId: event.nodeId }],
        };
      }
      return stay;
    case 'awaiting_receipt':
      if (event.type === 'receipt') return { state: CANVAS_PLACEMENT_IDLE, effects: [{ type: 'release' }] };
      return stay;
  }
}
