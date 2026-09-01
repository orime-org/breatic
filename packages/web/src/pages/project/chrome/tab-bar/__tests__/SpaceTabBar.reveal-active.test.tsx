// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The control that brings the current Space's tab back into view.
 *
 * Reordering deliberately does not chase the current tab (user 2026-08-30),
 * so a drag can leave it behind the arrows with nothing pointing at it. This
 * button is what the user has instead, and it is offered only when it has
 * somewhere to scroll to: the strip is not already showing as much of that tab
 * as it can hold. A tab wider than the strip counts as shown once it fills the
 * strip, so the button goes quiet there too.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render as rtlRender, screen, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type * as React from 'react';

import { SpaceTabBar } from '@web/pages/project/chrome/tab-bar/SpaceTabBar';
import type { ProjectSpace } from '@web/data/yjs/project-meta';
import { TooltipProvider } from '@web/components/ui/tooltip';
import { useUIStore } from '@web/stores';

const SPACES: ReadonlyArray<ProjectSpace> = [
  { id: 's1', name: 'First', type: 'canvas' },
  { id: 's2', name: 'Second', type: 'canvas' },
  { id: 's3', name: 'Third', type: 'canvas' },
];

/**
 * Providers the bar expects from App.tsx at runtime.
 * @param root0 - Wrapper props.
 * @param root0.children - The bar under test.
 * @returns The wrapped subtree.
 */
function Providers({
  children,
}: {
  children: React.ReactNode;
}): React.JSX.Element {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return (
    <QueryClientProvider client={client}>
      <TooltipProvider>{children}</TooltipProvider>
    </QueryClientProvider>
  );
}

/**
 * Render the bar with the given active Space and tab order.
 * @param activeSpaceId - Which Space the page is showing.
 * @param spaces - The tabs, in the order the strip renders them.
 * @returns The rerender function, for changing either of those.
 */
function setup(
  activeSpaceId = 's2',
  spaces: ReadonlyArray<ProjectSpace> = SPACES,
): (next: {
  activeSpaceId?: string;
  spaces?: ReadonlyArray<ProjectSpace>;
}) => void {
  const props = {
    allSpaces: SPACES,
    openTabIds: SPACES.map((s) => s.id),
    projectId: 'p1',
    onActivate: vi.fn(),
    onCreate: vi.fn(),
    onViewSpace: vi.fn(),
  };
  const view = rtlRender(
    <SpaceTabBar {...props} spaces={spaces} activeSpaceId={activeSpaceId} />,
    { wrapper: Providers },
  );
  return (next) => {
    act(() => {
      view.rerender(
        <SpaceTabBar
          {...props}
          spaces={next.spaces ?? spaces}
          activeSpaceId={next.activeSpaceId ?? activeSpaceId}
        />,
      );
    });
  };
}

/**
 * Give an element a horizontal extent, which jsdom otherwise reports as zero.
 * @param el - The element to measure.
 * @param rect - Its left and right edges.
 */
function mockRect(
  el: HTMLElement,
  rect: Pick<DOMRect, 'left' | 'right'>,
): void {
  vi.spyOn(el, 'getBoundingClientRect').mockReturnValue({
    ...rect,
    top: 0,
    bottom: 40,
    width: rect.right - rect.left,
    height: 40,
    x: rect.left,
    y: 0,
    toJSON: () => ({}),
  } as DOMRect);
}

/**
 * Give an element a place in the strip's layout, which jsdom reports as zero
 * and which a transform does not move.
 * @param el - The tab to place.
 * @param at - Where it sits and how wide it is, in scroll coordinates.
 */
function setLayout(
  el: HTMLElement,
  at: { left: number; width: number },
): void {
  Object.defineProperty(el, 'offsetLeft', {
    value: at.left,
    configurable: true,
  });
  Object.defineProperty(el, 'offsetWidth', {
    value: at.width,
    configurable: true,
  });
}

/**
 * Put the strip in the state where it scrolls, and hand back the scroller.
 * @param scrollLeft - How far along the strip is scrolled.
 * @returns The viewport that scrolls.
 */
function makeOverflow(scrollLeft = 0): HTMLElement {
  const scroller = screen
    .getByRole('tablist')
    .closest('[data-radix-scroll-area-viewport]');
  if (!(scroller instanceof HTMLElement)) {
    throw new Error('the tab row is not inside a scroll-area viewport');
  }
  Object.defineProperty(scroller, 'scrollWidth', {
    value: 600,
    configurable: true,
  });
  Object.defineProperty(scroller, 'clientWidth', {
    value: 200,
    configurable: true,
  });
  Object.defineProperty(scroller, 'scrollLeft', {
    value: scrollLeft,
    configurable: true,
    writable: true,
  });
  mockRect(scroller, { left: 0, right: 200 });
  return scroller;
}

/**
 * Recompute the strip's measurements, the way a scroll would.
 * @param scroller - The viewport that scrolls.
 */
function flush(scroller: HTMLElement): void {
  act(() => {
    scroller.dispatchEvent(new Event('scroll'));
  });
}

/**
 * The reveal button.
 * @returns That button.
 */
function revealButton(): HTMLElement {
  return screen.getByTestId('tabs-reveal-active');
}

describe('SpaceTabBar — bringing the current tab back into view', () => {
  // Every browser has `Element.scrollTo`; jsdom leaves the prototype without
  // it, so the strip throws here and nowhere else. Deleting when there was no
  // descriptor puts the prototype back as it was.
  const realScrollTo = Object.getOwnPropertyDescriptor(
    Element.prototype,
    'scrollTo',
  );

  beforeEach(() => {
    useUIStore.getState().setChatPanelCollapsed(false);
    Element.prototype.scrollTo = vi.fn();
  });

  afterEach(() => {
    if (realScrollTo) {
      Object.defineProperty(Element.prototype, 'scrollTo', realScrollTo);
    } else {
      delete (Element.prototype as unknown as Record<string, unknown>).scrollTo;
    }
  });

  it('is offered, and disabled, when every tab fits', () => {
    // Disabled rather than hidden (user 2026-08-30): a control that comes and
    // goes as tabs are opened is harder to find than one that is always there.
    setup();
    expect(revealButton()).toBeInTheDocument();
    expect(revealButton()).toBeDisabled();
  });

  it('is disabled while the current tab is fully in sight', () => {
    setup();
    const scroller = makeOverflow();
    setLayout(screen.getByTestId('space-tab-s2'), { left: 40, width: 100 });
    flush(scroller);

    expect(revealButton()).toBeDisabled();
  });

  it('is offered when the current tab runs past the right edge', () => {
    setup();
    const scroller = makeOverflow();
    setLayout(screen.getByTestId('space-tab-s2'), { left: 150, width: 130 });
    flush(scroller);

    expect(revealButton()).toBeEnabled();
  });

  it('is offered when the current tab starts before the left edge', () => {
    setup();
    const scroller = makeOverflow(100);
    setLayout(screen.getByTestId('space-tab-s2'), { left: 40, width: 100 });
    flush(scroller);

    expect(revealButton()).toBeEnabled();
  });

  it('reads where the tab sits, not where a drag is drawing it', () => {
    // dnd-kit moves a dragged tab with a transform, which getBoundingClientRect
    // counts and the layout does not. Measured through the rect, a tab held
    // over the middle of the strip reads as on screen however far its place has
    // scrolled away — and when the gesture ends nothing scrolls or resizes, so
    // that answer is the one the control keeps.
    setup();
    const scroller = makeOverflow(400);
    const tab = screen.getByTestId('space-tab-s2');
    setLayout(tab, { left: 40, width: 100 });
    mockRect(tab, { left: 50, right: 150 });
    flush(scroller);

    expect(revealButton()).toBeEnabled();
  });

  it('scrolls the strip alone, and only as far as the tab is cut off', async () => {
    // The strip is what moves, not every scroller up to the document: below
    // the project page's width floor the page is one of those, and a click
    // here would drag what the reader was looking at.
    const user = userEvent.setup();
    setup();
    const scroller = makeOverflow();
    mockRect(screen.getByTestId('space-tab-s2'), { left: 150, right: 280 });
    setLayout(screen.getByTestId('space-tab-s2'), { left: 150, width: 130 });
    flush(scroller);
    const scrollTo = vi.fn();
    scroller.scrollTo = scrollTo;

    await user.click(revealButton());

    // 80px past the right edge, so 80px of travel and not a pixel more.
    expect(scrollTo).toHaveBeenCalledWith({ left: 80, behavior: 'smooth' });
  });

  it('answers again when the shown order changes', () => {
    // A drag is what puts the current tab out of sight, and it changes neither
    // the scroll position nor any element's size — so neither of the two
    // signals the arrows listen on fires.
    const rerender = setup();
    const scroller = makeOverflow();
    setLayout(screen.getByTestId('space-tab-s2'), { left: 40, width: 100 });
    flush(scroller);
    expect(revealButton()).toBeDisabled();

    setLayout(screen.getByTestId('space-tab-s2'), { left: 150, width: 130 });
    rerender({ spaces: [SPACES[1]!, SPACES[0]!, SPACES[2]!] });

    expect(revealButton()).toBeEnabled();
  });

  it('settles on the start of a tab wider than the strip', async () => {
    // A long name and a narrow window: the tab cannot be inside both edges at
    // once. Asking for that leaves the control enabled with nothing that can
    // satisfy it, and each click swings the strip from one edge to the other
    // — measured in a browser at 137px of strip and a 160px tab, scrollLeft
    // going 115, 92, 115, 92. Its start is what a reader needs; that is where
    // the name begins.
    const user = userEvent.setup();
    setup();
    const scroller = makeOverflow();
    setLayout(screen.getByTestId('space-tab-s2'), { left: 240, width: 260 });
    flush(scroller);
    const scrollTo = vi.fn();
    scroller.scrollTo = scrollTo;
    expect(revealButton()).toBeEnabled();

    await user.click(revealButton());
    expect(scrollTo).toHaveBeenCalledWith({ left: 240, behavior: 'smooth' });

    Object.defineProperty(scroller, 'scrollLeft', {
      value: 240,
      configurable: true,
      writable: true,
    });
    flush(scroller);

    expect(revealButton()).toBeDisabled();
  });

  it('is offered while an oversized tab still has travel left', async () => {
    // Its start is inside the strip but not flush against the leading edge,
    // so there is more of the name to bring in. Answering "shown" anywhere in
    // that band disagrees with what a click then does, which is to put the
    // start against the edge.
    const user = userEvent.setup();
    setup();
    const scroller = makeOverflow();
    setLayout(screen.getByTestId('space-tab-s2'), { left: 60, width: 260 });
    flush(scroller);
    const scrollTo = vi.fn();
    scroller.scrollTo = scrollTo;

    expect(revealButton()).toBeEnabled();

    await user.click(revealButton());
    expect(scrollTo).toHaveBeenCalledWith({ left: 60, behavior: 'smooth' });
  });

  it('answers again when the page switches Space', () => {
    // Switching to a tab already in sight scrolls nothing, so nothing else
    // tells the button its answer just changed.
    const rerender = setup();
    const scroller = makeOverflow();
    setLayout(screen.getByTestId('space-tab-s2'), { left: 40, width: 100 });
    setLayout(screen.getByTestId('space-tab-s3'), { left: 150, width: 130 });
    flush(scroller);
    expect(revealButton()).toBeDisabled();

    rerender({ activeSpaceId: 's3' });

    expect(revealButton()).toBeEnabled();
  });
});
