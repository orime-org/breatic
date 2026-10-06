// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * A Space switched away from lets go of words left selected in it: the reader
 * can no longer see them, and the page's copy and paste read the one page-wide
 * selection (inner#1235 A5).
 */

import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import * as React from 'react';
import { createPortal } from 'react-dom';

vi.mock('@web/pages/project/SpaceReadOnlyNotice', () => ({
  SpaceReadOnlyNotice: (): null => null,
}));

vi.mock('@web/spaces', () => ({
  SPACE_TYPES: {
    canvas: {
      bodyComponent: (): React.JSX.Element => (
        <div>
          <p data-testid='inline-words'>inline words</p>
          {createPortal(<p data-testid='portal-words'>portal words</p>, document.body)}
        </div>
      ),
    },
  },
}));

import { SpaceOutlet } from '@web/pages/project/SpaceOutlet';

/**
 * The outlet inside an Activity, the way an open tab holds it.
 * @param root0 - Props.
 * @param root0.active - Whether the Space is on screen.
 * @returns The element.
 */
function Tab({ active }: { active: boolean }): React.JSX.Element {
  return (
    <React.Activity mode={active ? 'visible' : 'hidden'}>
      <SpaceOutlet projectId='p' spaceId='s' type='canvas' />
    </React.Activity>
  );
}

/**
 * Selects all of an element's words.
 * @param element - The element.
 */
function selectWordsOf(element: HTMLElement): void {
  const range = document.createRange();
  range.selectNodeContents(element);
  document.getSelection()?.removeAllRanges();
  document.getSelection()?.addRange(range);
}

// jsdom has no layout, so visibility is read the way a browser would answer
// it for these trees: hidden when an ancestor is display:none.
beforeEach(() => {
  Element.prototype.checkVisibility = function checkVisibility(this: Element): boolean {
    const hidden = (at: Element | null): boolean =>
      at !== null &&
      ((at instanceof HTMLElement && at.style.display === 'none') || hidden(at.parentElement));
    return !hidden(this);
  };
});

afterEach(() => {
  delete (Element.prototype as { checkVisibility?: unknown }).checkVisibility;
  document.getSelection()?.removeAllRanges();
});

describe('SpaceOutlet — words selected in a hidden Space', () => {
  it.each(['inline-words', 'portal-words'])('lets go of words selected in %s', (words) => {
    const { rerender } = render(<Tab active />);
    selectWordsOf(screen.getByTestId(words));
    rerender(<Tab active={false} />);
    expect(document.getSelection()?.isCollapsed ?? true).toBe(true);
  });

  it('keeps words selected outside the Space', () => {
    const outside = document.createElement('p');
    outside.textContent = 'outside words';
    document.body.appendChild(outside);
    const { rerender } = render(<Tab active />);
    selectWordsOf(outside);
    rerender(<Tab active={false} />);
    expect(document.getSelection()?.toString()).toBe('outside words');
    outside.remove();
  });
});
