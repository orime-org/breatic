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
