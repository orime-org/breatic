// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { beforeEach, describe, expect, it } from 'vitest';

import { canvasSessions } from '@web/stores/canvas-session';
import { resetProjectUiStores } from '@web/stores/reset-project-ui';

/**
 * Whether the canvas is waiting for somebody to say where the note goes.
 * @returns The placement flag as it stands.
 */
const placing = (): boolean => canvasSessions.of('s').getState().placingAnnotation;

describe('placement mode, between the left menu and the canvas click', () => {
  beforeEach(() => {
    canvasSessions.clear();
  });

  it('starts inactive', () => {
    expect(placing()).toBe(false);
  });

  it('arms on the left menu, and a second press changes nothing', () => {
    // The left menu's buttons are fire-and-forget — none of them holds a
    // pressed state — so pressing this one again is not a way out. Escape is,
    // and so is putting the note down.
    canvasSessions.of('s').getState().startAnnotationPlacement();
    expect(placing()).toBe(true);
    canvasSessions.of('s').getState().startAnnotationPlacement();
    expect(placing()).toBe(true);
  });

  it('disarms once the note has a place to go', () => {
    canvasSessions.of('s').getState().startAnnotationPlacement();
    canvasSessions.of('s').getState().endAnnotationPlacement();
    expect(placing()).toBe(false);
  });

  it('disarming while inactive changes nothing', () => {
    canvasSessions.of('s').getState().endAnnotationPlacement();
    expect(placing()).toBe(false);
  });

  it('is dropped when the project resets', () => {
    // Leaving a project with the tool still armed would arm it again on the
    // way back in, and the next click anywhere would drop a note.
    canvasSessions.of('s').getState().startAnnotationPlacement();
    resetProjectUiStores('p');
    expect(placing()).toBe(false);
  });
});

describe('placement mode and picking, which cannot both be on', () => {
  beforeEach(() => {
    canvasSessions.clear();
  });

  it('arming the note tool puts a pick session down', () => {
    canvasSessions.of('s').getState().startReferencePick('n1');
    canvasSessions.of('s').getState().startAnnotationPlacement();
    expect(canvasSessions.of('s').getState().pickSession).toBeNull();
    expect(placing()).toBe(true);
  });

  // The other direction, which the canvas answers first: `takeAnnotationDrop`
  // runs ahead of the pick in both click handlers, so a pick started while the
  // tool is armed had its clicks swallowed and one Escape closed both modes.
  it.each([
    ['reference', () => canvasSessions.of('s').getState().startReferencePick('n1')],
    ['first frame', () => canvasSessions.of('s').getState().startFirstFramePick('n1')],
    ['end frame', () => canvasSessions.of('s').getState().startEndFramePick('n1')],
  ])('starting a %s pick puts the note tool down', (_name, start) => {
    canvasSessions.of('s').getState().startAnnotationPlacement();
    start();
    expect(placing()).toBe(false);
    expect(canvasSessions.of('s').getState().pickSession).not.toBeNull();
  });
});
