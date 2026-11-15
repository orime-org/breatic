// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The type picker as one start-aligned row that scrolls (#1490 design §3.4): the first card at the left edge, an
 * arrow only on a side that can still scroll, an arrow click landing the next hidden card just inside the fade on that
 * side, a vertical wheel turned sideways, the arrow keys moving the selection, and a picked card brought into view.
 *
 * jsdom lays nothing out, so the row is given a geometry: a 472px viewport over five 120px cards 8px apart (632px of
 * content), with a 56px fade on each side that can still scroll.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { SpaceType } from '@breatic/shared';

import { SpaceKindPicker } from '@web/spaces/SpaceKindPicker';
import { renderWithTooltips as render } from '@web/test-utils/render-with-tooltips';

const ORDER: SpaceType[] = ['canvas', 'document', '3d', 'timeline', 'web_animation'];
const VIEW = 472;
const CARD = 120;
const STEP = 128;
const CONTENT = ORDER.length * STEP - 8;

let realScrollTo: PropertyDescriptor | undefined;

beforeEach(() => {
  realScrollTo = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTo');
  Element.prototype.scrollTo = vi.fn();
});

afterEach(() => {
  if (realScrollTo) Object.defineProperty(Element.prototype, 'scrollTo', realScrollTo);
  else delete (Element.prototype as unknown as Record<string, unknown>).scrollTo;
});

/**
 * Render the picker with the row scrolled to a position.
 * @param scrollLeft - Where the row starts.
 * @param value - The selected type.
 * @returns The viewport, its scrollTo spy and the change handler.
 */
function laidOut(scrollLeft: number, value: SpaceType = 'canvas'): { viewport: HTMLElement; scrollTo: ReturnType<typeof vi.fn>; onChange: ReturnType<typeof vi.fn> } {
  const onChange = vi.fn();
  render(<SpaceKindPicker value={value} onChange={onChange} />);
  const viewport = screen.getByTestId('space-kind-viewport');
  let left = scrollLeft;
  Object.defineProperty(viewport, 'scrollLeft', { configurable: true, get: () => left, set: (next: number) => { left = next; } });
  Object.defineProperty(viewport, 'scrollWidth', { configurable: true, value: CONTENT });
  Object.defineProperty(viewport, 'clientWidth', { configurable: true, value: VIEW });
  vi.spyOn(viewport, 'getBoundingClientRect').mockReturnValue(DOMRect.fromRect({ x: 0, y: 0, width: VIEW, height: 96 }));
  ORDER.forEach((type, index) => {
    const card = screen.getByTestId(`space-kind-${type}`);
    vi.spyOn(card, 'getBoundingClientRect').mockImplementation(() => DOMRect.fromRect({ x: index * STEP - left, y: 0, width: CARD, height: 96 }));
  });
  const scrollTo = vi.fn();
  viewport.scrollTo = scrollTo as unknown as typeof viewport.scrollTo;
  fireEvent.scroll(viewport);
  return { viewport, scrollTo, onChange };
}

describe('SpaceKindPicker as a scrolling row', () => {
  it('shows only the end arrow at the start of the row', () => {
    laidOut(0);
    expect(screen.queryByTestId('space-kind-scroll-start')).not.toBeInTheDocument();
    expect(screen.getByTestId('space-kind-scroll-end')).toBeInTheDocument();
  });

  it('shows only the start arrow at the end of the row', () => {
    laidOut(CONTENT - VIEW);
    expect(screen.getByTestId('space-kind-scroll-start')).toBeInTheDocument();
    expect(screen.queryByTestId('space-kind-scroll-end')).not.toBeInTheDocument();
  });

  it('lands the next cut-off card against the end fade on the end arrow', async () => {
    const { scrollTo } = laidOut(0);
    await userEvent.setup().click(screen.getByTestId('space-kind-scroll-end'));
    // Card 3 spans 384–504; the visible end, less the 56px fade, is 416.
    expect(scrollTo).toHaveBeenCalledWith({ left: 504 - (VIEW - 56), behavior: 'smooth' });
  });

  it('lands the last cut-off card against the start fade on the start arrow', async () => {
    const { scrollTo } = laidOut(CONTENT - VIEW);
    await userEvent.setup().click(screen.getByTestId('space-kind-scroll-start'));
    // Card 1 starts at 128 and the start fade covers 56px of the row.
    expect(scrollTo).toHaveBeenCalledWith({ left: 128 - 56, behavior: 'smooth' });
  });

  it('turns a vertical wheel into a sideways scroll of the row', () => {
    const { viewport } = laidOut(0);
    const event = new WheelEvent('wheel', { deltaY: 100, deltaMode: WheelEvent.DOM_DELTA_PIXEL, bubbles: true, cancelable: true });
    viewport.dispatchEvent(event);
    expect(viewport.scrollLeft).toBe(100);
    expect(event.defaultPrevented).toBe(true);
  });

  it('leaves a sideways trackpad swipe to the browser', () => {
    const { viewport } = laidOut(0);
    const event = new WheelEvent('wheel', { deltaX: 40, deltaY: 0, bubbles: true, cancelable: true });
    viewport.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  });

  it('moves the selection with the arrow keys and stops at the ends', async () => {
    const user = userEvent.setup();
    const { onChange } = laidOut(0, 'canvas');
    screen.getByTestId('space-kind-canvas').focus();
    await user.keyboard('{ArrowRight}');
    expect(onChange).toHaveBeenLastCalledWith('document');
    await user.keyboard('{ArrowLeft}');
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('brings a picked card that is cut off into view, just inside the fade', async () => {
    const { scrollTo } = laidOut(0);
    await userEvent.setup().click(screen.getByTestId('space-kind-timeline'));
    expect(scrollTo).toHaveBeenCalledWith({ left: 504 - (VIEW - 56), behavior: 'smooth' });
  });
});
