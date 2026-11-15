// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Putting an exported video on a canvas (#1490 design §9.1, §13.4, the table whose one writer is
 * `transitionCanvasPlacement`). The button waits from the choice until the receipt; every cell is one case.
 */

import { describe, expect, it } from 'vitest';

import {
  transitionCanvasPlacement, type CanvasPlacementEvent, type CanvasPlacementState,
} from '@web/spaces/web-animation/canvas-placement';

const CANVAS = 'c0000000-0000-4000-8000-000000000001';
const NODE = 'n0000000-0000-4000-8000-000000000002';

const IDLE: CanvasPlacementState = { status: 'idle' };
const CONNECTING: CanvasPlacementState = { status: 'connecting', canvasId: CANVAS };
const WRITING: CanvasPlacementState = { status: 'writing', canvasId: CANVAS };
const AWAITING: CanvasPlacementState = { status: 'awaiting_receipt', canvasId: CANVAS, nodeId: NODE };

const choose: CanvasPlacementEvent = { type: 'choose', canvasId: CANVAS };
const synced: CanvasPlacementEvent = { type: 'synced' };
const timeout: CanvasPlacementEvent = { type: 'sync_timeout' };
const refused: CanvasPlacementEvent = { type: 'size_refused' };
const written: CanvasPlacementEvent = { type: 'written', nodeId: NODE };
const receipt: CanvasPlacementEvent = { type: 'receipt' };
const leave: CanvasPlacementEvent = { type: 'leave' };

describe('transitionCanvasPlacement', () => {
  it('connects to the chosen canvas from idle', () => {
    expect(transitionCanvasPlacement(IDLE, choose)).toEqual({ state: CONNECTING, effects: [{ type: 'connect', canvasId: CANVAS }] });
  });

  it.each([synced, timeout, refused, written, receipt, leave])('stays idle on %o', (event) => {
    expect(transitionCanvasPlacement(IDLE, event)).toEqual({ state: IDLE, effects: [] });
  });

  it('writes the node once the canvas has synced', () => {
    expect(transitionCanvasPlacement(CONNECTING, synced)).toEqual({ state: WRITING, effects: [{ type: 'write' }] });
  });

  it('gives up and says the canvas could not be reached when the sync times out', () => {
    expect(transitionCanvasPlacement(CONNECTING, timeout)).toEqual({ state: IDLE, effects: [{ type: 'release' }, { type: 'toast_unreachable' }] });
  });

  it.each([CONNECTING, WRITING, AWAITING])('ignores a second choice while busy (%o)', (state) => {
    expect(transitionCanvasPlacement(state, choose)).toEqual({ state, effects: [] });
  });

  it.each([CONNECTING, WRITING, AWAITING])('warns that a placement is in progress when the user leaves (%o)', (state) => {
    expect(transitionCanvasPlacement(state, leave)).toEqual({ state, effects: [{ type: 'warn_in_progress' }] });
  });

  it('gives up and says the canvas is full when the size gate refuses the node', () => {
    expect(transitionCanvasPlacement(WRITING, refused)).toEqual({ state: IDLE, effects: [{ type: 'release' }, { type: 'toast_canvas_full' }] });
  });

  it('waits for the receipt once written, saying it is placed with a way to view it', () => {
    expect(transitionCanvasPlacement(WRITING, written)).toEqual({ state: AWAITING, effects: [{ type: 'toast_placed', canvasId: CANVAS, nodeId: NODE }] });
  });

  it('releases the canvas once the receipt arrives', () => {
    expect(transitionCanvasPlacement(AWAITING, receipt)).toEqual({ state: IDLE, effects: [{ type: 'release' }] });
  });

  it.each([
    [CONNECTING, [refused, written, receipt]],
    [WRITING, [synced, timeout, receipt]],
    [AWAITING, [synced, timeout, refused, written]],
  ] as const)('ignores events that cannot happen in %o', (state, events) => {
    for (const event of events) expect(transitionCanvasPlacement(state, event)).toEqual({ state, effects: [] });
  });
});
