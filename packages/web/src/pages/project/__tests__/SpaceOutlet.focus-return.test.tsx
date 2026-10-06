// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * A Space switched away from and back gives the caret back to the box it was
 * in, whichever box that is — including one rendered into a portal
 * (inner#1235 A19).
 */

import { describe, it, expect, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
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
          <input data-testid='inline-box' />
          {createPortal(<input data-testid='portal-box' />, document.body)}
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

/** Lets the task the caret is put back on run. */
async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe('SpaceOutlet — the caret goes back where the Space was left', () => {
  it.each(['inline-box', 'portal-box'])('puts the caret back into %s', async (box) => {
    const { rerender } = render(<Tab active />);
    act(() => screen.getByTestId(box).focus());
    rerender(<Tab active={false} />);
    // Hiding takes the box off the page; focus leaves with it.
    act(() => (document.activeElement as HTMLElement | null)?.blur());
    rerender(<Tab active />);
    await flush();
    expect(document.activeElement).toBe(screen.getByTestId(box));
  });

  it('puts the caret back without scrolling to it', async () => {
    const { rerender } = render(<Tab active />);
    const box = screen.getByTestId('inline-box');
    act(() => box.focus());
    rerender(<Tab active={false} />);
    act(() => box.blur());
    const focus = vi.spyOn(box, 'focus');
    rerender(<Tab active />);
    await flush();
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
  });

  it('leaves the caret alone when it was outside the Space on hide', async () => {
    const outside = document.createElement('input');
    document.body.appendChild(outside);
    const { rerender } = render(<Tab active />);
    act(() => screen.getByTestId('inline-box').focus());
    act(() => outside.focus());
    rerender(<Tab active={false} />);
    rerender(<Tab active />);
    await flush();
    expect(document.activeElement).toBe(outside);
    outside.remove();
  });
});
