// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { render } from '@testing-library/react';
import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useAutosizeTextarea } from '../use-autosize-textarea';

/** What `scrollHeight` answers, and what the box's height was when asked. */
let contentHeight = 0;
let heightWhenMeasured: string[] = [];
/** Stands in for the layout the shrink causes; see {@link stubScrollHeight}. */
let clampWhileShort: (() => void) | null = null;

const original = Object.getOwnPropertyDescriptor(
  HTMLElement.prototype,
  'scrollHeight',
);

/**
 * Answer `scrollHeight` with a content height a test chooses.
 *
 * jsdom lays nothing out, so every element reports 0 and a height taken from
 * it would be `0px` no matter what is written. The getter also records the
 * height the box carried at the moment it was read, which is how the reset to
 * `auto` is observable at all.
 *
 * `clampWhileShort` stands in for the one part of that missing layout the hook
 * exists to survive: while the box is short its scroller's content is short
 * with it, so the browser clamps that scroller's position to what is left. A
 * jsdom that never lays out never clamps, and a test written on it would pass
 * with the restore deleted -- measured, that is exactly what happened.
 */
function stubScrollHeight(): void {
  Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
    configurable: true,
    get(this: HTMLElement) {
      if (this.tagName === 'TEXTAREA') {
        heightWhenMeasured.push(this.style.height);
        if (this.style.height === 'auto') clampWhileShort?.();
        return contentHeight;
      }
      return 0;
    },
  });
}

interface BoxProps {
  value: string;
  wrapper?: HTMLElement | null;
}

/**
 * A textarea sized by the hook under test.
 * @param root0 - Props.
 * @param root0.value - What is written in the box.
 * @returns The box.
 */
function Box({ value }: BoxProps): React.JSX.Element {
  const ref = React.useRef<HTMLTextAreaElement>(null);
  useAutosizeTextarea(ref, value);
  return <textarea ref={ref} readOnly value={value} data-testid='box' />;
}

describe('useAutosizeTextarea', () => {
  afterEach(() => {
    if (original !== undefined) {
      Object.defineProperty(HTMLElement.prototype, 'scrollHeight', original);
    }
    contentHeight = 0;
    heightWhenMeasured = [];
    clampWhileShort = null;
    vi.unstubAllGlobals();
  });

  it('gives the box the height of what is written in it', () => {
    stubScrollHeight();
    contentHeight = 84;
    const { getByTestId } = render(<Box value='four lines' />);
    expect(getByTestId('box').style.height).toBe('84px');
  });

  it('refits when the text changes', () => {
    stubScrollHeight();
    contentHeight = 40;
    const { getByTestId, rerender } = render(<Box value='one line' />);
    expect(getByTestId('box').style.height).toBe('40px');
    contentHeight = 120;
    rerender(<Box value='one line, then several more' />);
    expect(getByTestId('box').style.height).toBe('120px');
  });

  it('lets the box shrink again, by measuring it at its natural height', () => {
    stubScrollHeight();
    contentHeight = 200;
    const { getByTestId, rerender } = render(<Box value='a long draft' />);
    contentHeight = 30;
    rerender(<Box value='short' />);
    // Without the reset, `scrollHeight` on an element already given 200px
    // reports 200px and the box never comes back down.
    expect(heightWhenMeasured).toContain('auto');
    expect(getByTestId('box').style.height).toBe('30px');
  });

  it('puts an ancestor scroller back where it was after measuring', () => {
    stubScrollHeight();
    contentHeight = 300;
    const { getByTestId, rerender } = render(
      <div data-testid='scroller'>
        <Box value='a long draft' />
      </div>,
    );
    const scroller = getByTestId('scroller');
    // Where the browser had scrolled to -- in the real thing, to the caret it
    // put on screen as the key landed.
    scroller.scrollTop = 55;
    // The shrink empties it, the way a browser clamps a scroller whose content
    // just got shorter than its position.
    clampWhileShort = () => {
      scroller.scrollTop = 0;
    };
    contentHeight = 500;
    rerender(
      <div data-testid='scroller'>
        <Box value='a longer draft' />
      </div>,
    );
    expect(scroller.scrollTop).toBe(55);
  });

  it('stops watching the box when it goes away', () => {
    stubScrollHeight();
    const disconnect = vi.fn();
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe(): void {
          /* nothing to do */
        }
        disconnect = disconnect;
      },
    );
    const { unmount } = render(<Box value='x' />);
    unmount();
    expect(disconnect).toHaveBeenCalled();
  });
});
