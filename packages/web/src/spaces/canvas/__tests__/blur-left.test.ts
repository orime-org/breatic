// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, it, expect, vi, afterEach } from 'vitest';

import { whenBlurLeaves } from '@web/spaces/canvas/blur-left';

/**
 * A box inside a Space outlet, attached to the page.
 * @returns The outlet and the box.
 */
function boxInSpace(): { outlet: HTMLElement; box: HTMLElement } {
  const outlet = document.createElement('div');
  outlet.setAttribute('data-space-outlet', 's1');
  const box = document.createElement('div');
  outlet.appendChild(box);
  document.body.appendChild(outlet);
  return { outlet, box };
}

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('whenBlurLeaves', () => {
  it('leaves when focus moves elsewhere on the page', async () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    const { box } = boxInSpace();
    const leave = vi.fn();
    whenBlurLeaves(box, leave);
    await Promise.resolve();
    expect(leave).toHaveBeenCalledTimes(1);
  });

  it('stays when the whole window lost focus', async () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(false);
    const { box } = boxInSpace();
    const leave = vi.fn();
    whenBlurLeaves(box, leave);
    await Promise.resolve();
    expect(leave).not.toHaveBeenCalled();
  });

  it('stays when its Space is hidden by a switch of Space', async () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    const { outlet, box } = boxInSpace();
    const leave = vi.fn();
    whenBlurLeaves(box, leave);
    // The editor's DOM is moved out as the Space is hidden.
    box.remove();
    outlet.style.setProperty('display', 'none', 'important');
    await Promise.resolve();
    expect(leave).not.toHaveBeenCalled();
  });

  it('leaves when the box is taken off a Space that stays on screen', async () => {
    // A node deleted, or culled out of view, while the reader was in it.
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    const { box } = boxInSpace();
    const leave = vi.fn();
    whenBlurLeaves(box, leave);
    box.remove();
    await Promise.resolve();
    expect(leave).toHaveBeenCalledTimes(1);
  });
});
