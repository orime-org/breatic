// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, it, expect, vi, afterEach } from 'vitest';

import { whenBlurLeaves } from '@web/spaces/canvas/blur-left';

/**
 * Puts a Space outlet on the page.
 * @param spaceId - The Space.
 * @returns The outlet.
 */
function outlet(spaceId: string): HTMLElement {
  const el = document.createElement('div');
  el.setAttribute('data-space-outlet', spaceId);
  document.body.appendChild(el);
  return el;
}

/**
 * Settles the microtask the decision waits for.
 * @returns Nothing.
 */
const settle = (): Promise<void> => Promise.resolve();

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('whenBlurLeaves', () => {
  it('leaves when focus moves elsewhere on the page', async () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    outlet('s1');
    const leave = vi.fn();
    whenBlurLeaves('s1', leave);
    await settle();
    expect(leave).toHaveBeenCalledTimes(1);
  });

  it('stays when the whole window lost focus', async () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(false);
    outlet('s1');
    const leave = vi.fn();
    whenBlurLeaves('s1', leave);
    await settle();
    expect(leave).not.toHaveBeenCalled();
  });

  it('stays when its Space is hidden by a switch of Space', async () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    const space = outlet('s1');
    const leave = vi.fn();
    whenBlurLeaves('s1', leave);
    space.style.setProperty('display', 'none', 'important');
    await settle();
    expect(leave).not.toHaveBeenCalled();
  });

  it('stays for a box in a popover outside the Space when that Space is hidden', async () => {
    // A popover renders under <body>, not in the Space outlet; which Space it
    // belongs to is the canvas's, not the DOM's.
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    const space = outlet('s1');
    const popoverBox = document.body.appendChild(document.createElement('input'));
    const leave = vi.fn();
    whenBlurLeaves('s1', leave);
    popoverBox.remove();
    space.style.setProperty('display', 'none', 'important');
    await settle();
    expect(leave).not.toHaveBeenCalled();
  });

  it('leaves when its Space stays on screen though the box was taken off it', async () => {
    // A node deleted, or culled out of view, while the reader was in it.
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    outlet('s1');
    const leave = vi.fn();
    whenBlurLeaves('s1', leave);
    await settle();
    expect(leave).toHaveBeenCalledTimes(1);
  });
});
