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
  const props = {
    spaces: SPACES,
    allSpaces: SPACES,
    openTabIds: SPACES.map((s) => s.id),
    activeSpaceId: 's1',
    projectId: 'p1',
    onActivate,
    onCreate,
    onClose,
    onViewSpace,
    ...overrides,
  };
  const view = render(<SpaceTabBar {...props} />);
  /** Render again with one prop changed, keeping this bar mounted. */
  const setActiveSpace = (id: string): void => {
    view.rerender(<SpaceTabBar {...props} activeSpaceId={id} />);
  };
  return { onActivate, onCreate, onClose, onViewSpace, setActiveSpace };
}

describe('SpaceTabBar', () => {
  // Every browser has `Element.scrollTo`; jsdom leaves the prototype without
  // it, so a component that scrolls a box of its own throws here and nowhere
  // else. Taking the descriptor and deleting when there was none puts the
  // prototype back as it was: assigning the saved `undefined` would leave an
  // own property behind, and `'scrollTo' in element` answers differently for
  // every file that runs after this one.
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

  function mockRect(el: HTMLElement, rect: Pick<DOMRect, 'left' | 'right'>) {
    vi.spyOn(el, 'getBoundingClientRect').mockReturnValue({
      ...rect,
      top: 0,
      bottom: 40,
      width: rect.right - rect.left,
      height: 40,
      x: rect.left,
      y: 0,
      toJSON: () => ({}),
    });
  }

  /**
   * Mock the scroller into the overflow state (scrollWidth > clientWidth).
   * Does NOT dispatch the scroll event — the test must call
   * `flushScrollState` AFTER the layout is in place, because
   * `updateScrollState` reads `offsetLeft`/`offsetWidth` off the tabs and
   * `scrollLeft`/`clientWidth` off the scroller (all 0 in jsdom, which
   * falsely yields atStart=atEnd=true and disables the arrows before the
   * test can click them).
   */
  /**
   * Place a tab along the strip, in the strip's own scroll coordinates.
   *
   * That is what the bar measures with — a transform moves a tab's rect and
   * leaves its layout where it is, and a tab being dragged carries one.
   * @param el - The tab to place.
   * @param at - Its leading edge and width.
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

  // PR #140 (2026-05-25): scroll arrows snap one tab per click rather than
  // moving a fixed `scrollBy(±120)`, which under-shoots long-name tabs (took
  // 2–3 clicks to fully reveal). The strip moves itself — the arrows write
  // `scroller.scrollTo`. These two tests pin the contract: right-arrow snaps
  // the first off-screen tab flush-right, left-arrow snaps the last
  // off-screen tab flush-left.
  describe('scroll arrows (point-and-scroll, PR #140)', () => {
    it('right arrow snaps the first off-screen tab flush-right, moving only the strip', async () => {
      const user = userEvent.setup();
      setup();
      const scroller = makeOverflow();
      // s1 fully visible; s2 first off-screen on the right; s3 further.
      setLayout(screen.getByTestId('space-tab-s1'), { left: 0, width: 60 });
      setLayout(screen.getByTestId('space-tab-s2'), { left: 220, width: 100 });
      setLayout(screen.getByTestId('space-tab-s3'), { left: 330, width: 100 });
      flushScrollState(scroller);
      const scrollTo = vi.fn();
      scroller.scrollTo = scrollTo;
      const reachesOutward = vi.spyOn(
        screen.getByTestId('space-tab-s2'),
        'scrollIntoView',
      );

      await user.click(screen.getByTestId('tabs-scroll-right'));

      // s2's right edge sits 120px past the strip's, so the strip travels
      // exactly that far and s2 lands flush against the right edge.
      expect(scrollTo).toHaveBeenCalledWith({ left: 120, behavior: 'smooth' });
      // Every scroller between the tab and the document moves along with
      // `scrollIntoView`, and the project page is one of them once the window
      // is narrower than its floor: a reader who had scrolled the page
      // sideways lost that position on every arrow click.
      expect(reachesOutward).not.toHaveBeenCalled();
    });

    it('disables the left arrow when the strip starts at its padding', () => {
      setup();
      // The element that scrolls is the viewport, and `scroll` does not
      // bubble: stubbing the row instead leaves every measurement below
      // unread and the assertion reading the mount-time default.
      const scroller = makeOverflow();
      // A scroll can leave scrollLeft at the scroller's padding-left (~8 px)
      // rather than zero. The first tab starts there too, so nothing is cut
      // off the left and the arrow is disabled — an `atStart` asking whether
      // scrollLeft itself is near zero (commit 626ec56) left it enabled here.
      Object.defineProperty(scroller, 'scrollLeft', {
        value: 8,
        configurable: true,
        writable: true,
      });
      setLayout(screen.getByTestId('space-tab-s1'), { left: 8, width: 60 });
      setLayout(screen.getByTestId('space-tab-s2'), { left: 78, width: 60 });
      setLayout(screen.getByTestId('space-tab-s3'), { left: 148, width: 60 });
      flushScrollState(scroller);
      expect(screen.getByTestId('tabs-scroll-left')).toBeDisabled();
    });

    it('ignores where a drag is drawing a tab', () => {
      // A tab being dragged carries a transform, which its rect counts and
      // its layout does not. Held over the middle of the strip its rect reads
      // as on screen while its place has scrolled away — and a gesture ending
      // scrolls nothing and resizes nothing, so a rect-based answer is the one
      // the arrows would keep.
      setup();
      const scroller = makeOverflow();
      const dragged = screen.getByTestId('space-tab-s3');
      setLayout(screen.getByTestId('space-tab-s1'), { left: 0, width: 60 });
      setLayout(screen.getByTestId('space-tab-s2'), { left: 70, width: 60 });
      setLayout(dragged, { left: 240, width: 100 });
      mockRect(dragged, { left: 60, right: 160 });
      flushScrollState(scroller);

      expect(screen.getByTestId('tabs-scroll-right')).toBeEnabled();
    });

    it('left arrow snaps the last off-screen tab flush-left, moving only the strip', async () => {
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
      setLayout(screen.getByTestId('space-tab-s1'), { left: 0, width: 60 });
      setLayout(screen.getByTestId('space-tab-s2'), { left: 70, width: 100 });
      setLayout(screen.getByTestId('space-tab-s3'), { left: 180, width: 100 });
      flushScrollState(scroller);
      const scrollTo = vi.fn();
      scroller.scrollTo = scrollTo;
      const reachesOutward = vi.spyOn(
        screen.getByTestId('space-tab-s2'),
        'scrollIntoView',
      );

      await user.click(screen.getByTestId('tabs-scroll-left'));

      // s2 starts 30px left of the strip's edge, so 100 - 30 brings it flush.
      expect(scrollTo).toHaveBeenCalledWith({ left: 70, behavior: 'smooth' });
      expect(reachesOutward).not.toHaveBeenCalled();
    });
  });

  // Picking a space from the drawer can name one whose tab is off-screen, and
  // then nothing on screen says the pick landed — the strip has to bring it in.
  describe('bringing the newly active tab into the strip', () => {
    it('scrolls a tab cut off on the right just far enough to show it', () => {
      const { setActiveSpace } = setup();
      const scroller = makeOverflow();
      setLayout(screen.getByTestId('space-tab-s1'), { left: 0, width: 60 });
      setLayout(screen.getByTestId('space-tab-s2'), { left: 70, width: 60 });
      setLayout(screen.getByTestId('space-tab-s3'), { left: 240, width: 100 });
      flushScrollState(scroller);
      const scrollTo = vi.fn();
      scroller.scrollTo = scrollTo;

      act(() => setActiveSpace('s3'));

      // s3's right edge is 140px past the strip's.
      expect(scrollTo).toHaveBeenCalledWith({ left: 140, behavior: 'smooth' });
    });

    it('scrolls a tab cut off on the left back to the strip edge', () => {
      const { setActiveSpace } = setup({ activeSpaceId: 's2' });
      const scroller = makeOverflow();
      Object.defineProperty(scroller, 'scrollLeft', {
        value: 100,
        configurable: true,
        writable: true,
      });
      setLayout(screen.getByTestId('space-tab-s1'), { left: 0, width: 60 });
      setLayout(screen.getByTestId('space-tab-s2'), { left: 120, width: 60 });
      setLayout(screen.getByTestId('space-tab-s3'), { left: 190, width: 60 });
      flushScrollState(scroller);
      const scrollTo = vi.fn();
      scroller.scrollTo = scrollTo;

      act(() => setActiveSpace('s1'));

      // s1 starts 100px left of the strip's edge, so 100 - 100 lands at 0.
      expect(scrollTo).toHaveBeenCalledWith({ left: 0, behavior: 'smooth' });
    });

    it('leaves a tab hanging a fraction of a pixel over the edge alone', () => {
      // The same 1px tolerance the arrows and their enabled predicate use: a
      // column whose width is a percentage of a fractional container puts every
      // edge on a fraction, and without it the two answer differently inside
      // that band — the arrow says there is nothing off-screen while this says
      // there is, and the strip creeps on every space switch.
      const { setActiveSpace } = setup();
      const scroller = makeOverflow();
      setLayout(screen.getByTestId('space-tab-s1'), { left: 0, width: 60 });
      setLayout(screen.getByTestId('space-tab-s2'), { left: 70, width: 60 });
      setLayout(screen.getByTestId('space-tab-s3'), { left: 140, width: 60.5 });
      flushScrollState(scroller);
      const scrollTo = vi.fn();
      scroller.scrollTo = scrollTo;

      act(() => setActiveSpace('s3'));

      expect(scrollTo).not.toHaveBeenCalled();
    });

    it('leaves a tab that is already whole on screen exactly where it is', () => {
      const { setActiveSpace } = setup();
      const scroller = makeOverflow();
      setLayout(screen.getByTestId('space-tab-s1'), { left: 0, width: 60 });
      setLayout(screen.getByTestId('space-tab-s2'), { left: 70, width: 60 });
      setLayout(screen.getByTestId('space-tab-s3'), { left: 240, width: 100 });
      flushScrollState(scroller);
      const scrollTo = vi.fn();
      scroller.scrollTo = scrollTo;

      act(() => setActiveSpace('s2'));

      expect(scrollTo).not.toHaveBeenCalled();
    });

    it('moves the strip and nothing above it', () => {
      const { setActiveSpace } = setup();
      const scroller = makeOverflow();
      setLayout(screen.getByTestId('space-tab-s1'), { left: 0, width: 60 });
      setLayout(screen.getByTestId('space-tab-s2'), { left: 70, width: 60 });
      setLayout(screen.getByTestId('space-tab-s3'), { left: 240, width: 100 });
      flushScrollState(scroller);
      const scrollTo = vi.fn();
      scroller.scrollTo = scrollTo;
      const reachesOutward = vi.spyOn(
        screen.getByTestId('space-tab-s3'),
        'scrollIntoView',
      );

      act(() => setActiveSpace('s3'));

      // 340 - 200: the strip moves by what hangs off its right edge.
      expect(scrollTo).toHaveBeenCalledWith({ left: 140, behavior: 'smooth' });
      expect(reachesOutward).not.toHaveBeenCalled();
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
