// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  render as rtlRender,
  screen,
  act,
  type RenderOptions,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type * as React from 'react';

import { SpaceTabBar } from '@web/pages/project/chrome/tab-bar/SpaceTabBar';
import type { ProjectSpace } from '@web/data/yjs/project-meta';
import { TooltipProvider } from '@web/components/ui/tooltip';
import { useUIStore } from '@web/stores';
import { expectNoA11yViolations } from '@web/test-utils/a11y';

// Agent-toggle / NewSpace / Drawer / ProjectMessages buttons in the
// tab bar now use shadcn `Tooltip` for hover tooltips. App.tsx
// supplies `TooltipProvider` at runtime; tests have to add it.
const render = (ui: React.ReactElement, options?: RenderOptions) =>
  rtlRender(ui, { wrapper: TooltipProvider, ...options });

const SPACES: ProjectSpace[] = [
  { id: 's1', name: 'Main', type: 'canvas' },
  { id: 's2', name: 'Notes', type: 'document' },
  { id: 's3', name: 'Reel', type: 'timeline', locked: true },
];

function setup(overrides: Partial<Parameters<typeof SpaceTabBar>[0]> = {}) {
  const onActivate = vi.fn();
  const onCreate = vi.fn();
  const onClose = vi.fn();
  const onViewSpace = vi.fn();
  render(
    <SpaceTabBar
      spaces={SPACES}
      allSpaces={SPACES}
      openTabIds={SPACES.map((s) => s.id)}
      activeSpaceId='s1'
      projectId='p1'
      onActivate={onActivate}
      onCreate={onCreate}
      onClose={onClose}
      onViewSpace={onViewSpace}
      {...overrides}
    />,
  );
  return { onActivate, onCreate, onClose, onViewSpace };
}

describe('SpaceTabBar', () => {
  beforeEach(() => {
    useUIStore.getState().setChatPanelCollapsed(false);
  });

  it('has no a11y violations', async () => {
    setup();
    // nested-interactive disabled: each SpaceTab is a `role='tab'`
    // button with an inner close-`<span role='button' tabIndex=0>`.
    // Every mainstream browser tab bar (Chrome, Firefox, Safari,
    // VSCode) uses this pattern; ARIA permits it, but axe-core flags
    // it conservatively. Keyboard reach to the close button works via
    // Tab + Enter/Space — see SpaceTab.tsx for the inline reasoning.
    await expectNoA11yViolations(document.body, {
      'nested-interactive': { enabled: false },
    });
  });

  it('renders one tab per open space', () => {
    setup();
    expect(screen.getByTestId('space-tab-s1')).toBeInTheDocument();
    expect(screen.getByTestId('space-tab-s2')).toBeInTheDocument();
    expect(screen.getByTestId('space-tab-s3')).toBeInTheDocument();
  });

  it('renders the 2 dividers (space-header-left + space-header-right)', () => {
    setup();
    expect(screen.getByTestId('space-header-left')).toBeInTheDocument();
    expect(screen.getByTestId('space-header-right')).toBeInTheDocument();
  });

  it('clicking a non-active tab calls onActivate with its id', async () => {
    const user = userEvent.setup();
    const { onActivate } = setup();
    await user.click(screen.getByTestId('space-tab-s2'));
    expect(onActivate).toHaveBeenCalledWith('s2');
  });

  it('agent toggle button flips chatPanelCollapsed in the UI store', async () => {
    const user = userEvent.setup();
    setup();
    expect(useUIStore.getState().chatPanelCollapsed).toBe(false);
    await user.click(screen.getByTestId('agent-toggle'));
    expect(useUIStore.getState().chatPanelCollapsed).toBe(true);
  });

  it('close button is rendered for every tab regardless of lock (close ≠ delete)', () => {
    setup();
    expect(screen.getByTestId('space-tab-close-s1')).toBeInTheDocument();
    expect(screen.getByTestId('space-tab-close-s3')).toBeInTheDocument();
  });

  it('+ button, drawer trigger, project-messages trigger all present (right group)', () => {
    setup();
    expect(screen.getByTestId('new-space-button')).toBeInTheDocument();
    expect(screen.getByTestId('space-drawer-trigger')).toBeInTheDocument();
    expect(screen.getByTestId('project-messages-trigger')).toBeInTheDocument();
  });

  // PR #140 (2026-05-25): scroll arrows use point-and-scroll (one tab per
  // click via `scrollIntoView`), not fixed `scrollBy(±120)`. A fixed delta
  // under-shoots long-name tabs (took 2–3 clicks to fully reveal). These
  // two tests pin the contract: right-arrow snaps the first off-screen
  // tab flush-right, left-arrow snaps the last off-screen tab flush-left.
  describe('scroll arrows (point-and-scroll, PR #140)', () => {
    function mockRect(
      el: HTMLElement,
      rect: Pick<DOMRect, 'left' | 'right'>,
    ) {
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
     * Mock the scroller into the overflow state (scrollWidth > clientWidth).
     * Does NOT dispatch the scroll event — the test must call
     * `flushScrollState` AFTER all rect mocks are in place, because the
     * post-PR #140 DOM-rect-based `updateScrollState` reads tab + scroller
     * rects (defaults to 0 in jsdom, which falsely yields atStart=atEnd=true
     * and disables the arrows before the test can click them).
     */
    function makeOverflow(): HTMLElement {
      const scroller = screen.getByRole('tablist');
      Object.defineProperty(scroller, 'scrollWidth', {
        value: 600,
        configurable: true,
      });
      Object.defineProperty(scroller, 'clientWidth', {
        value: 200,
        configurable: true,
      });
      return scroller;
    }

    function flushScrollState(scroller: HTMLElement) {
      act(() => {
        scroller.dispatchEvent(new Event('scroll'));
      });
    }

    it('right arrow snaps the first off-screen tab flush-right (inline: end)', async () => {
      const user = userEvent.setup();
      setup();
      const scroller = makeOverflow();
      mockRect(scroller, { left: 0, right: 200 });
      // s1 fully visible; s2 first off-screen on the right; s3 further.
      mockRect(screen.getByTestId('space-tab-s1'), { left: 0, right: 60 });
      mockRect(screen.getByTestId('space-tab-s2'), { left: 220, right: 320 });
      mockRect(screen.getByTestId('space-tab-s3'), { left: 330, right: 430 });
      flushScrollState(scroller);
      const s2 = screen.getByTestId('space-tab-s2');
      const scrollSpy = vi.spyOn(s2, 'scrollIntoView');

      await user.click(screen.getByTestId('tabs-scroll-right'));
      expect(scrollSpy).toHaveBeenCalledWith(
        expect.objectContaining({ inline: 'end', block: 'nearest' }),
      );
    });

    it('disables the left arrow when no tab is off-screen-left, regardless of scrollLeft (DOM-rect, PR #140)', () => {
      setup();
      const scroller = screen.getByRole('tablist');
      Object.defineProperty(scroller, 'scrollWidth', {
        value: 600,
        configurable: true,
      });
      Object.defineProperty(scroller, 'clientWidth', {
        value: 200,
        configurable: true,
      });
      // Smooth `scrollIntoView({ inline: 'start' })` lands scrollLeft
      // at scroller padding-left (~8 px), NOT zero. The prior
      // scrollLeft-based atStart check (commit 626ec56) failed here
      // — `8 <= 1` false → arrow stayed enabled. The DOM-rect check
      // looks at tab positions; if all tabs sit inside the viewport
      // (none cut off the left), atStart is true regardless of
      // scrollLeft's exact value.
      Object.defineProperty(scroller, 'scrollLeft', {
        value: 8,
        configurable: true,
        writable: true,
      });
      mockRect(scroller, { left: 0, right: 200 });
      mockRect(screen.getByTestId('space-tab-s1'), { left: 0, right: 60 });
      mockRect(screen.getByTestId('space-tab-s2'), { left: 70, right: 130 });
      mockRect(screen.getByTestId('space-tab-s3'), { left: 140, right: 200 });
      flushScrollState(scroller);
      expect(screen.getByTestId('tabs-scroll-left')).toBeDisabled();
    });

    it('left arrow snaps the last off-screen tab flush-left (inline: start)', async () => {
      const user = userEvent.setup();
      setup();
      const scroller = makeOverflow();
      // Pretend the user has scrolled right; without this, scrollLeft=0
      // makes `atStart=true` and disables the left arrow.
      Object.defineProperty(scroller, 'scrollLeft', {
        value: 100,
        configurable: true,
        writable: true,
      });
      // s1 + s2 sit off-screen-left of the scroller viewport.
      mockRect(scroller, { left: 100, right: 300 });
      mockRect(screen.getByTestId('space-tab-s1'), { left: 0, right: 60 });
      mockRect(screen.getByTestId('space-tab-s2'), { left: 70, right: 170 });
      mockRect(screen.getByTestId('space-tab-s3'), { left: 180, right: 280 });
      flushScrollState(scroller);
      const s2 = screen.getByTestId('space-tab-s2');
      const scrollSpy = vi.spyOn(s2, 'scrollIntoView');

      await user.click(screen.getByTestId('tabs-scroll-left'));
      expect(scrollSpy).toHaveBeenCalledWith(
        expect.objectContaining({ inline: 'start', block: 'nearest' }),
      );
    });
  });
});
