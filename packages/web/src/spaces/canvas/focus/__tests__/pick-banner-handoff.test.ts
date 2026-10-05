// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, it, expect, afterEach } from 'vitest';

import { canvasRootOf } from '@web/spaces/canvas/canvas-context';
import { handOffFocusToPickBanner } from '@web/spaces/canvas/focus/FocusCropOverlay';

/**
 * Puts a Space outlet holding a pick banner on the page.
 * @param spaceId - The Space.
 * @param hidden - Whether the Space is switched away from.
 * @returns The banner.
 */
function spaceWithBanner(spaceId: string, hidden: boolean): HTMLElement {
  const outlet = document.createElement('div');
  outlet.setAttribute('data-space-outlet', spaceId);
  if (hidden) outlet.style.setProperty('display', 'none', 'important');
  const banner = document.createElement('div');
  banner.setAttribute('data-testid', 'reference-pick-banner');
  banner.tabIndex = -1;
  outlet.appendChild(banner);
  document.body.appendChild(outlet);
  return banner;
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('handOffFocusToPickBanner', () => {
  it('gives focus to the banner of its own canvas when another is kept hidden', () => {
    spaceWithBanner('hidden', true);
    const own = spaceWithBanner('shown', false);

    handOffFocusToPickBanner(null, canvasRootOf('shown'));

    expect(document.activeElement).toBe(own);
  });
});
