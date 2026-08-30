// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  render as rtlRender,
  screen,
  act,
  fireEvent,
  type RenderOptions,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type * as React from 'react';

import { SpaceTabBar } from '@web/pages/project/chrome/tab-bar/SpaceTabBar';
import type { ProjectSpace } from '@web/data/yjs/project-meta';
import { TooltipProvider } from '@web/components/ui/tooltip';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useUIStore } from '@web/stores';
import { expectNoA11yViolations } from '@web/test-utils/a11y';

// Agent-toggle / NewSpace / Drawer / ProjectMessages buttons in the
// tab bar now use shadcn `Tooltip` for hover tooltips. App.tsx
// supplies `TooltipProvider` at runtime; tests have to add it. The
// embedded ProjectActivityButton also needs a QueryClient (activity
// feed via React Query since ADR 2026-07-04).
const render = (ui: React.ReactElement, options?: RenderOptions) => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const Wrapper = ({ children }: { children: React.ReactNode }): React.JSX.Element => (
    <QueryClientProvider client={client}>
      <TooltipProvider>{children}</TooltipProvider>
    </QueryClientProvider>
  );
  return rtlRender(ui, { wrapper: Wrapper, ...options });
};

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

  it('+ button, drawer trigger, project-activity trigger all present (right group)', () => {
    setup();
    expect(screen.getByTestId('new-space-button')).toBeInTheDocument();
    expect(screen.getByTestId('space-drawer-trigger')).toBeInTheDocument();
    expect(screen.getByTestId('project-activity-trigger')).toBeInTheDocument();
  });

  describe('role-based affordance gating (B model — hide)', () => {
    it('owner sees the new-space "+" create button', () => {
      setup({ currentUserRole: 'owner' });
      expect(screen.getByTestId('new-space-button')).toBeInTheDocument();
    });

    it('editor sees the new-space "+" create button', () => {
      setup({ currentUserRole: 'editor' });
      expect(screen.getByTestId('new-space-button')).toBeInTheDocument();
    });

    it('viewer does NOT see the new-space "+" create button', () => {
      setup({ currentUserRole: 'viewer' });
      expect(screen.queryByTestId('new-space-button')).toBeNull();
    });

    it('viewer still sees the all-spaces drawer + project-activity buttons', () => {
      setup({ currentUserRole: 'viewer' });
      expect(screen.getByTestId('space-drawer-trigger')).toBeInTheDocument();
      expect(screen.getByTestId('project-activity-trigger')).toBeInTheDocument();
    });
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
      // The element that scrolls is the ScrollArea viewport; the tablist is
      // the row of tabs inside it. They are two elements on purpose — a role
      // that owns the tabs belongs on the element they sit in, and the
      // scrolling belongs to the viewport around it.
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
      // The element that scrolls is the viewport, and `scroll` does not
      // bubble: stubbing the row instead leaves every rect below unread and
      // the assertion reading the mount-time default.
      const scroller = makeOverflow();
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

  // The active tab's label is the one piece of text that stands for the space
  // region. Its fill answers a different question — which of these spaces is
  // the current one — and that stays true whichever region is active, so the
  // fill does not move (#168).
  describe('the active tab label follows the active region (#168)', () => {
    afterEach(() => {
      useUIStore.getState().setActiveRegion('space');
    });

    it('is bright while the space region is the active one', () => {
      useUIStore.getState().setActiveRegion('space');
      setup();
      const tab = screen.getByTestId('space-tab-s1');
      expect(tab.className).toContain('text-foreground');
      expect(tab.className).not.toContain('text-muted-foreground');
      expect(tab.className).toContain('bg-accent');
    });

    it('is dim while the agent column is the active region, fill unchanged', () => {
      useUIStore.getState().setActiveRegion('agent');
      setup();
      const tab = screen.getByTestId('space-tab-s1');
      expect(tab.className).toContain('text-muted-foreground');
      expect(tab.className).toContain('bg-accent');
    });

    it.each(['space', 'agent'] as const)(
      'leaves the resting inactive tabs dim while the active region is %s',
      (region) => {
        useUIStore.getState().setActiveRegion(region);
        setup();
        for (const id of ['s2', 's3']) {
          const tab = screen.getByTestId(`space-tab-${id}`);
          expect(tab.className).toContain('text-muted-foreground');
          expect(tab.className).toContain('bg-transparent');
        }
      },
    );

    // Hover reaches for the same brightness the label uses to say the keyboard
    // is here, so it follows the region too: with the agent column active the
    // current tab is dim, and a hovered one brighter than it would read as the
    // current one.
    it('brightens a hovered resting tab while the space region is the active one', () => {
      useUIStore.getState().setActiveRegion('space');
      setup();
      const tab = screen.getByTestId('space-tab-s2');
      expect(tab.className).toContain('hover:bg-accent');
      expect(tab.className).toContain('hover:text-foreground');
    });

    it('leaves a hovered resting tab dim while the agent column is the active region', () => {
      useUIStore.getState().setActiveRegion('agent');
      setup();
      const tab = screen.getByTestId('space-tab-s2');
      expect(tab.className).toContain('hover:bg-accent');
      expect(tab.className).not.toContain('hover:text-foreground');
    });

    // Everything inside the active tab states its own colour, so the tab's
    // says nothing about them.
    it.each(['space', 'agent'] as const)(
      'leaves what is inside the active tab alone while the active region is %s',
      (region) => {
        useUIStore.getState().setActiveRegion(region);
        // s3 is the locked one, so the lock icon is on screen too.
        setup({ activeSpaceId: 's3' });
        const tab = screen.getByTestId('space-tab-s3');
        const typeIcon = tab.querySelector('svg[aria-hidden="true"]');
        expect(typeIcon?.getAttribute('class')).toContain('text-muted-foreground');
        expect(screen.getByLabelText('Locked').getAttribute('class')).toContain(
          'text-muted-foreground',
        );
        expect(
          screen.getByTestId('space-tab-close-s3').className,
        ).toContain('text-muted-foreground');
      },
    );

    it.each(['space', 'agent'] as const)(
      'leaves the rename field bright while the active region is %s',
      async (region) => {
        const user = userEvent.setup();
        useUIStore.getState().setActiveRegion(region);
        // Double-click rename only opens when there is somewhere to commit to.
        setup({ onRenameSpace: vi.fn() });
        await user.dblClick(screen.getByTestId('space-tab-name-s1'));
        const field = screen.getByTestId('space-tab-name-input-s1');
        expect(field.className).toContain('text-foreground');
        expect(field.className).not.toContain('text-muted-foreground');
      },
    );
  });

  describe('the strip that scrolls sideways', () => {
    it('lays the tabs out in one row that can overflow sideways', () => {
      setup();
      // Radix puts a `display:table` div of its own inside a viewport, so a
      // flex declared ON the viewport reaches that div and stops. The tabs
      // would then stack one per row, the strip would never overflow
      // sideways, and both the bar and the arrows would never appear.
      const tab = screen.getByTestId('space-tab-s1');
      const row = tab.parentElement;
      expect(row?.getAttribute('role')).toBe('tablist');
      // classList, not the className string: `flex-col` — the direction the
      // regression takes — contains "flex" as a substring, so a substring
      // check reads as satisfied by the very thing it exists to refuse.
      expect(row?.classList.contains('flex')).toBe(true);
      expect(row?.classList.contains('flex-col')).toBe(false);
      // The role belongs to the element the tabs sit in, so the same element
      // carries both.
      expect(row?.querySelectorAll('[role="tab"]').length).toBe(3);
    });

    it('scrolls through the shared component, not a native bar', () => {
      setup();
      // Every visible scroller in the app is the ScrollArea component
      // (web/CLAUDE.md), which draws its own bar: appears while scrolling,
      // takes no layout room, and hover changes colour without changing
      // shape. A native bar delivers none of that -- the interaction states
      // are UA-private and differ between browser builds.
      const tab = screen.getByTestId('space-tab-s1');
      const strip = tab.closest('[data-scrollbars]');
      expect(strip).not.toBeNull();
      expect(strip?.getAttribute('data-scrollbars')).toBe('horizontal');
    });
  });

  describe('a name too long for the strip', () => {
    // The strip scrolls sideways, so a long name never breaks the layout --
    // it takes the whole visible width for itself and pushes every other tab
    // behind the scroll arrows. A cap on the tab is what keeps the rest
    // reachable (#2015; user set 160px on 2026-08-28).
    //
    // jsdom does no layout, so `getBoundingClientRect` here is all zeroes and
    // these assertions can only say the cap is declared, not that it renders
    // at 160px. The rendered width is measured in a real browser.
    const LONG = '素材分镜脚本第一版终稿请勿删除';
    const withLongName = {
      spaces: [{ id: 's1', name: LONG, type: 'canvas' as const }],
      allSpaces: [{ id: 's1', name: LONG, type: 'canvas' as const }],
      openTabIds: ['s1'],
    };

    it('caps the tab and clips the name that overflows it', () => {
      setup(withLongName);
      const tab = screen.getByTestId('space-tab-s1');
      // The literal is the point: restating the constant would let the
      // assertion follow the number wherever it was changed to.
      expect(tab.style.maxWidth).toBe('160px');
      // The clip belongs to the name, not the tab: the icon and the close
      // control keep their room and the name gives up what is left.
      expect(screen.getByTestId('space-tab-name-s1').className).toContain(
        'truncate',
      );
    });

    it('leaves the rename field free to grow, and caps it through the tab', async () => {
      const user = userEvent.setup();
      setup({ ...withLongName, onRenameSpace: vi.fn() });
      await user.dblClick(screen.getByTestId('space-tab-name-s1'));
      const field = screen.getByTestId('space-tab-name-input-s1');
      // A width computed from the character count grows without end, which is
      // the same overflow through the editing state. The field grows with its
      // content up to the cap and scrolls after that, so the caret stays in
      // view -- the treatment the project title already uses.
      expect(field.className).toContain('[field-sizing:content]');
      // `field-sizing` replaces only the AUTOMATIC size, so ANY definite width
      // switches it off and pins the field at that width whatever is typed --
      // a `w-[2ch]` floor did exactly that and left the field two characters
      // wide. Asking only whether the inline style is empty cannot see it: the
      // pin lives in a class. jsdom does no layout, so what the field is
      // actually worth once something is typed is measured in a browser
      // (tests/smoke/space-tab-strip.spec.ts).
      expect([...field.classList].some((c) => /^w-\[/.test(c))).toBe(false);
      expect(field.style.width).toBe('');
      expect(screen.getByTestId('space-tab-s1').style.maxWidth).toBe(
        '160px',
      );
    });

    // The cap buys back the rest of the strip by taking the end of the name
    // away, and until this the name was nowhere else on the strip: two Spaces
    // whose names agree for the first hundred pixels printed the same glyphs.
    // Hovering a tab hands the whole name back — EVERY tab, whatever its name
    // is worth (user 2026-08-29): someone who has learnt to hover for the full
    // name must not find that gesture silently dead on the short ones.
    describe('reading the name back', () => {
      afterEach(() => {
        vi.useRealTimers();
      });

      /**
       * Give the name span a measured width — jsdom lays nothing out, so both
       * `scrollWidth` and `clientWidth` are 0 there and no name ever reads as
       * clipped.
       * @param scrollWidth - What the name is worth.
       * @param clientWidth - What the tab leaves it.
       */
      const measureName = (scrollWidth: number, clientWidth: number): void => {
        const el = screen.getByTestId('space-tab-name-s1');
        Object.defineProperty(el, 'scrollWidth', {
          configurable: true,
          value: scrollWidth,
        });
        Object.defineProperty(el, 'clientWidth', {
          configurable: true,
          value: clientWidth,
        });
      };

      /** Point at the tab and let Radix's open delay elapse. */
      const hoverTab = (): void => {
        vi.useFakeTimers();
        fireEvent.pointerMove(screen.getByTestId('space-tab-s1'), {
          pointerType: 'mouse',
        });
        act(() => {
          vi.advanceTimersByTime(1_000);
        });
      };

      /** What the open tooltips say, if any are open. */
      const tooltipTexts = (): string[] =>
        screen.queryAllByRole('tooltip').map((el) => el.textContent ?? '');

      it.each([
        ['the strip cut it short', 211, 100],
        ['it fits as it is', 100, 100],
      ])('shows the whole name above a tab when %s', (_case, scrollWidth, clientWidth) => {
        setup(withLongName);
        measureName(scrollWidth, clientWidth);
        hoverTab();
        expect(tooltipTexts()).toContain(LONG);
      });

      it('stays quiet while the name is being edited', () => {
        setup({ ...withLongName, onRenameSpace: vi.fn() });
        measureName(211, 100);
        fireEvent.dblClick(screen.getByTestId('space-tab-name-s1'));
        expect(
          screen.getByTestId('space-tab-name-input-s1'),
        ).toBeDefined();
        hoverTab();
        expect(tooltipTexts()).toEqual([]);
      });
    });
  });
});
