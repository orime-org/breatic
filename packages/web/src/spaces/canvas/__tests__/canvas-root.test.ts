// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, it, expect, vi, afterEach } from 'vitest';

import { canvasRootOf } from '@web/spaces/canvas/canvas-context';
import { observeViewportTransform } from '@web/spaces/canvas/viewport-observer';

/**
 * Puts a Space outlet holding a canvas viewport on the page.
 * @param spaceId - The Space the outlet is for.
 * @returns The canvas's viewport element.
 */
function spaceWithCanvas(spaceId: string): HTMLElement {
  const outlet = document.createElement('div');
  outlet.setAttribute('data-space-outlet', spaceId);
  const viewport = document.createElement('div');
  viewport.className = 'react-flow__viewport';
  outlet.appendChild(viewport);
  document.body.appendChild(outlet);
  return viewport;
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('canvasRootOf', () => {
  it('is the outlet of the Space asked for, not the first canvas on the page', () => {
    spaceWithCanvas('hidden');
    const shown = spaceWithCanvas('shown');
    expect(canvasRootOf('shown').querySelector('.react-flow__viewport')).toBe(shown);
  });

  it('is the page when the canvas is not inside a Space', () => {
    expect(canvasRootOf('')).toBe(document);
  });
});

describe('observeViewportTransform', () => {
  it('hears its own canvas move and not another kept on the page', async () => {
    const other = spaceWithCanvas('hidden');
    const own = spaceWithCanvas('shown');
    const onChange = vi.fn();
    const stop = observeViewportTransform(canvasRootOf('shown'), onChange);
    other.style.transform = 'translate(1px, 0px)';
    await Promise.resolve();
    expect(onChange).not.toHaveBeenCalled();
    own.style.transform = 'translate(2px, 0px)';
    await Promise.resolve();
    expect(onChange).toHaveBeenCalledTimes(1);
    stop();
  });
});
