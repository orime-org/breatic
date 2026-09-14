// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { beforeEach, describe, expect, it } from 'vitest';

import { useCanvasStore } from '@web/stores/canvas';

/**
 * Whether the canvas is waiting for somebody to say where the note goes.
 * @returns The placement flag as it stands.
 */
const placing = (): boolean => useCanvasStore.getState().placingAnnotation;

describe('placement mode, between the left menu and the canvas click', () => {
  beforeEach(() => {
    useCanvasStore.getState().reset();
  });

  it('starts inactive', () => {
    expect(placing()).toBe(false);
  });

  it('arms on the left menu, and a second press changes nothing', () => {
    // The left menu's buttons are fire-and-forget — none of them holds a
    // pressed state — so pressing this one again is not a way out. Escape is,
    // and so is putting the note down.
    useCanvasStore.getState().startAnnotationPlacement();
    expect(placing()).toBe(true);
    useCanvasStore.getState().startAnnotationPlacement();
    expect(placing()).toBe(true);
  });

  it('disarms once the note has a place to go', () => {
    useCanvasStore.getState().startAnnotationPlacement();
    useCanvasStore.getState().endAnnotationPlacement();
    expect(placing()).toBe(false);
  });

  it('disarming while inactive changes nothing', () => {
    useCanvasStore.getState().endAnnotationPlacement();
    expect(placing()).toBe(false);
  });

  it('is dropped when the project resets', () => {
    // Leaving a project with the tool still armed would arm it again on the
    // way back in, and the next click anywhere would drop a note.
    useCanvasStore.getState().startAnnotationPlacement();
    useCanvasStore.getState().reset();
    expect(placing()).toBe(false);
  });
});

describe('placement mode and picking, which cannot both be on', () => {
  beforeEach(() => {
    useCanvasStore.getState().reset();
  });

  it('arming the note tool puts a pick session down', () => {
    useCanvasStore.getState().startReferencePick('n1');
    useCanvasStore.getState().startAnnotationPlacement();
    expect(useCanvasStore.getState().pickSession).toBeNull();
    expect(placing()).toBe(true);
  });

  // The other direction, which the canvas answers first: `takeAnnotationDrop`
  // runs ahead of the pick in both click handlers, so a pick started while the
  // tool is armed had its clicks swallowed and one Escape closed both modes.
  it.each([
    ['reference', () => useCanvasStore.getState().startReferencePick('n1')],
    ['style', () => useCanvasStore.getState().startStylePick('n1')],
    ['first frame', () => useCanvasStore.getState().startFirstFramePick('n1')],
    ['end frame', () => useCanvasStore.getState().startEndFramePick('n1')],
  ])('starting a %s pick puts the note tool down', (_name, start) => {
    useCanvasStore.getState().startAnnotationPlacement();
    start();
    expect(placing()).toBe(false);
    expect(useCanvasStore.getState().pickSession).not.toBeNull();
  });
});
