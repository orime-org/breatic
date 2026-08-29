import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
// Test-only: Radix Root gives our ScrollBar its required context so the rail
// can be force-mounted (jsdom has no layout, so Radix never mounts it on its
// own). Product code never imports the primitive directly.
import * as ScrollAreaPrimitive from '@radix-ui/react-scroll-area';

import { ScrollArea, ScrollBar } from '@web/components/ui/scroll-area';

describe('ScrollArea', () => {
  it('renders root container with overflow-hidden + relative', () => {
    render(
      <ScrollArea data-testid='root' className='h-32 w-64'>
        <p>content</p>
      </ScrollArea>,
    );
    const root = screen.getByTestId('root');
    expect(root.className).toContain('relative');
    expect(root.className).toContain('overflow-hidden');
    expect(root.className).toContain('h-32');
    expect(root.className).toContain('w-64');
  });

  it('renders children inside viewport', () => {
    render(
      <ScrollArea>
        <p>Hello content</p>
      </ScrollArea>,
    );
    expect(screen.getByText('Hello content')).toBeInTheDocument();
  });

  it('viewport has h-full + w-full (fills root)', () => {
    render(
      <ScrollArea data-testid='root'>
        <p data-testid='child'>x</p>
      </ScrollArea>,
    );
    const child = screen.getByTestId('child');
    let cur: HTMLElement | null = child.parentElement;
    let found = false;
    while (cur) {
      if (cur.className.includes('h-full') && cur.className.includes('w-full')) {
        found = true;
        break;
      }
      cur = cur.parentElement;
    }
    expect(found).toBe(true);
  });

  it('viewport inherits border-radius via rounded-[inherit]', () => {
    render(
      <ScrollArea data-testid='root' className='rounded-lg'>
        <p data-testid='child'>x</p>
      </ScrollArea>,
    );
    const child = screen.getByTestId('child');
    let cur: HTMLElement | null = child.parentElement;
    let found = false;
    while (cur) {
      if (cur.className.includes('rounded-[inherit]')) {
        found = true;
        break;
      }
      cur = cur.parentElement;
    }
    expect(found).toBe(true);
  });

  it('forwards ref to root element', () => {
    let captured: HTMLDivElement | null = null;
    render(
      <ScrollArea
        ref={(el) => {
          captured = el;
        }}
      >
        <p>x</p>
      </ScrollArea>,
    );
    expect(captured).toBeInstanceOf(HTMLElement);
  });

  it('viewport scrolls: overflowY is scroll while the vertical ScrollBar is mounted (#1773 protective pin)', () => {
    // Radix flips the viewport to overflow hidden when no matching ScrollBar
    // is mounted — if someone removes/conditions the bar inside ScrollArea,
    // EVERY scroller app-wide silently stops scrolling while className-based
    // tests stay green. Pin the real capability.
    render(
      <ScrollArea data-testid='root' className='h-32'>
        <p>tall content</p>
      </ScrollArea>,
    );
    const viewport = screen
      .getByTestId('root')
      .querySelector('[data-radix-scroll-area-viewport]');
    expect((viewport as HTMLElement).style.overflowY).toBe('scroll');
  });

  it('scrollbars="both" mounts a horizontal viewport axis too (#1773 horizontal support)', () => {
    render(
      <ScrollArea data-testid='root' className='h-32' scrollbars='both'>
        <p>wide content</p>
      </ScrollArea>,
    );
    const root = screen.getByTestId('root');
    expect(root.getAttribute('data-scrollbars')).toBe('both');
    const viewport = root.querySelector('[data-radix-scroll-area-viewport]');
    expect((viewport as HTMLElement).style.overflowX).toBe('scroll');
    expect((viewport as HTMLElement).style.overflowY).toBe('scroll');
  });

  it('stamps data-scrollbars="vertical" by default (drives the truncate-fixing block-wrapper CSS)', () => {
    render(
      <ScrollArea data-testid='root'>
        <p>x</p>
      </ScrollArea>,
    );
    expect(screen.getByTestId('root').getAttribute('data-scrollbars')).toBe('vertical');
  });

  it('vertical-only does NOT mount the horizontal axis (overflowX stays hidden)', () => {
    // Mutation-caught gap (adversarial round): mounting BOTH ScrollBars
    // unconditionally passed every prior test. The axis prop must actually
    // gate the bars — Radix flips viewport overflow per mounted bar.
    render(
      <ScrollArea data-testid='root'>
        <p>x</p>
      </ScrollArea>,
    );
    const viewport = screen
      .getByTestId('root')
      .querySelector('[data-radix-scroll-area-viewport]');
    expect((viewport as HTMLElement).style.overflowX).toBe('hidden');
    expect((viewport as HTMLElement).style.overflowY).toBe('scroll');
  });

  it.each([
    [true, true, 'true', 'pointer-events-auto'],
    [true, false, 'false', 'pointer-events-none'],
    [false, true, 'false', 'pointer-events-none'],
    [false, false, 'false', 'pointer-events-none'],
  ])(
    'shows and answers the pointer only when its axis scrolls AND the pointer is inside (scrollable=%s revealed=%s)',
    (scrollable, revealed, wantRevealed, wantEvents) => {
      // Both halves of the gate, driven directly. Through ScrollArea this
      // composition is unreachable under jsdom: `scrollable` comes from a
      // ResizeObserver measurement and jsdom lays nothing out, so a case that
      // renders the whole component can only ever observe the hidden state and
      // says nothing about what the pointer half does.
      const { container, unmount } = render(
        <ScrollAreaPrimitive.Root type='always'>
          <ScrollAreaPrimitive.Viewport />
          <ScrollBar
            forceMount
            orientation='vertical'
            scrollable={scrollable}
            revealed={revealed}
          />
        </ScrollAreaPrimitive.Root>,
      );
      const bar = container.querySelector('[data-orientation="vertical"]') as HTMLElement;
      expect(bar.getAttribute('data-scrollable')).toBe(String(scrollable));
      expect(bar.getAttribute('data-revealed')).toBe(wantRevealed);
      expect(bar.className).toContain(wantEvents);
      unmount();
    },
  );

  it('keeps one ref identity for the viewport across renders (2026-08-29)', () => {
    // React detaches and re-attaches a ref whose identity changed, calling the
    // old one with null first, and Radix composes the viewport ref with a state
    // setter of its own — so an unstable callback here runs that setter null
    // and back on every render of every scroller in the app.
    const seen: (HTMLElement | null)[] = [];
    /**
     * Records every node this ref is handed.
     * @param node - The viewport, or null when React detaches the ref.
     */
    const keep = (node: HTMLDivElement | null): void => {
      seen.push(node);
    };
    const { rerender } = render(
      <ScrollArea viewportRef={keep}>
        <p>x</p>
      </ScrollArea>,
    );
    rerender(
      <ScrollArea viewportRef={keep}>
        <p>y</p>
      </ScrollArea>,
    );
    expect(seen).toEqual([expect.any(HTMLElement)]);
  });

  it('rail idles hidden and pointer-transparent, and stays that way with nothing to scroll (2026-08-29)', () => {
    // The rail is force-mounted so it is there to reveal, but until the
    // pointer is inside the scroller it must be hidden and take no pointer
    // events at all: it overlays content, and a rail that answers to the
    // pointer while invisible swallows the clicks meant for whatever is
    // underneath it. The reveal is therefore watched on the scroller, not on
    // the rail — a rail cannot notice a hover it is transparent to. What the
    // Root-to-rail wiring does with a real pointer needs layout, and is
    // measured in tests/smoke/space-tab-strip.spec.ts.
    const { container } = render(
      <ScrollArea data-testid='root'>
        <p>x</p>
      </ScrollArea>,
    );
    const root = screen.getByTestId('root');
    const rail = container.querySelector('[data-orientation="vertical"]') as HTMLElement;
    expect(rail).not.toBeNull();
    expect(rail.getAttribute('data-state')).toBe('hidden');
    expect(rail.className).toContain('opacity-0');
    expect(rail.getAttribute('data-revealed')).toBe('false');
    expect(rail.className).toContain('pointer-events-none');
    // jsdom lays nothing out, so nothing is scrollable here: the rail stays
    // transparent even with the pointer inside, which is the same gate that
    // keeps a non-scrollable edge from swallowing clicks.
    expect(rail.getAttribute('data-scrollable')).toBe('false');
    // Nothing here is scrollable, so the pointer coming in reveals nothing:
    // a bar that appears over content the reader cannot scroll says something
    // untrue about that content. Reported on an empty document Space, where
    // a bar came out on hover with nothing to scroll (user 2026-08-29).
    fireEvent.pointerEnter(root);
    expect(rail.getAttribute('data-revealed')).toBe('false');
    expect(rail.className).toContain('opacity-0');
    expect(rail.className).toContain('pointer-events-none');
    fireEvent.pointerLeave(root);
    expect(rail.getAttribute('data-revealed')).toBe('false');
  });

  it('thumb hover response is opacity-only and the rail carries the fade animation classes (ratified: hover = color, never shape)', () => {
    const { container } = render(
      <ScrollAreaPrimitive.Root type='always'>
        <ScrollAreaPrimitive.Viewport />
        <ScrollBar forceMount orientation='vertical' />
      </ScrollAreaPrimitive.Root>,
    );
    const bar = container.querySelector('[data-orientation="vertical"]') as HTMLElement;
    expect(bar.className).toContain('transition-opacity');
    expect(bar.className).toContain('data-[state=visible]:opacity-100');
    // Native-scrollbar pointer: always the default arrow, never inherited
    // text/grab cursors (user 2026-07-15).
    expect(bar.className).toContain('cursor-default');
    // Fixed geometry: the rail never changes thickness.
    expect(bar.className).toContain('w-2');
    const thumb = bar.firstElementChild as HTMLElement;
    expect(thumb.className).toContain('opacity-40');
    expect(thumb.className).toContain('hover:opacity-60');
    // An active drag keeps the hover color even when the pointer strays off
    // the thumb (rail data-dragging stamp, user 2026-07-15).
    expect(thumb.className).toContain('group-data-[dragging=true]/rail:opacity-60');
    expect(thumb.className).toContain('transition-opacity');
    // No scale/width hover response anywhere on the thumb.
    expect(thumb.className).not.toMatch(/hover:(w-|h-|scale)/);
  });

  describe('input-state contract (user-ratified 2026-07-15): scrollbar interaction never disturbs focus/selection', () => {
    /**
     * Renders a scroller with a focused textarea and enough stubbed layout for
     * the rail to own a press.
     *
     * A pointerdown is the only press a real pointer delivers here, and the
     * rail's handler cancels it before the browser can produce the
     * compatibility mouse events, so nothing that could move focus is ever
     * dispatched.
     * @returns The rail and the textarea that must keep the caret.
     */
    function renderScrollableWithInput(): { rail: HTMLElement; input: HTMLElement } {
      const { container } = render(
        <ScrollArea data-testid='root'>
          <textarea data-testid='input' defaultValue='typing…' />
        </ScrollArea>,
      );
      const rail = container.querySelector('[data-orientation="vertical"]') as HTMLElement;
      rail.setPointerCapture = vi.fn();
      rail.releasePointerCapture = vi.fn();
      Object.defineProperty(rail, 'clientHeight', { value: 200, configurable: true });
      Object.defineProperty(rail, 'offsetHeight', { value: 200, configurable: true });
      const thumb = rail.firstElementChild as HTMLElement;
      Object.defineProperty(thumb, 'offsetHeight', { value: 40, configurable: true });
      const viewport = container.querySelector(
        '[data-radix-scroll-area-viewport]',
      ) as HTMLElement;
      Object.defineProperty(viewport, 'scrollHeight', { value: 1000, configurable: true });
      Object.defineProperty(viewport, 'clientHeight', { value: 200, configurable: true });
      return { rail, input: screen.getByTestId('input') };
    }

    it('cancels the press on the rail (the action that would move focus)', () => {
      const { rail } = renderScrollableWithInput();
      // fireEvent returns false when preventDefault was called.
      expect(fireEvent.pointerDown(rail, { button: 0, pointerId: 1, clientY: 50 })).toBe(
        false,
      );
    });

    it('keeps focus on a focused textarea when the scrollbar is pressed', () => {
      const { rail, input } = renderScrollableWithInput();
      input.focus();
      expect(document.activeElement).toBe(input);
      fireEvent.pointerDown(rail, { button: 0, pointerId: 1, clientY: 50 });
      expect(document.activeElement).toBe(input);
    });
  });
});

describe('ScrollArea — a rail is gated by its own axis, not by an ancestor', () => {
  /**
   * Renders a horizontal scroller nested inside a vertical one — an assistant
   * message's wide table inside the message list.
   * @returns The rendered container.
   */
  function renderNested(): HTMLElement {
    const { container } = render(
      <ScrollArea data-testid='outer'>
        <p>messages</p>
        <ScrollArea data-testid='inner' scrollbars='horizontal'>
          <table>
            <tbody>
              <tr>
                <td>a wide row</td>
              </tr>
            </tbody>
          </table>
        </ScrollArea>
      </ScrollArea>,
    );
    return container;
  }

  it('stamps each rail with its own axis verdict', () => {
    renderNested();
    const inner = screen.getByTestId('inner');
    const rail = inner.querySelector('[data-orientation="horizontal"]') as HTMLElement;

    expect(rail).not.toBeNull();
    // The verdict lives on the rail itself. jsdom lays nothing out, so both
    // scrollers report nothing to scroll; what this pins is that the rail
    // carries an answer of its own at all.
    expect(rail.getAttribute('data-scrollable')).toBe('false');
  });

  it('does not gate a rail through a descendant selector on an ancestor scroller', () => {
    // This is what broke a wide table inside the message list: the outer
    // scroller scrolls vertically, so it reported nothing to scroll
    // sideways, and a `group-data-[scrollable-x=false]/scroller:` variant is
    // a plain descendant selector — it matched the INNER rail too and killed
    // its pointer events, leaving a bar that is visible and cannot be
    // grabbed.
    const container = renderNested();
    const rails = [...container.querySelectorAll('[data-orientation]')] as HTMLElement[];

    expect(rails.length).toBeGreaterThan(0);
    for (const rail of rails) {
      expect(rail.className).not.toMatch(/group-data-\[scrollable/);
    }
  });
  it('a drag that loses its pointer capture still ends (2026-08-29)', () => {
    // `end` is the only thing that detaches the move listener, clears
    // data-dragging and releases the capture, and pointerup / pointercancel
    // both presuppose the capture is still held. Lose it — the capture
    // element leaves the document, another element takes the same pointer,
    // the OS releases outside the window — and the release lands on a
    // sibling, whose pointerup never reaches this rail. The move listener
    // then outlives the gesture, and pointermove fires whether or not a
    // button is down: merely sweeping the pointer across the rail scrolls
    // the content to wherever the cursor is. Measured in a browser before
    // this was bound: 3393px of travel from hovering alone, with
    // data-dragging stuck at 'true'.
    const { container } = render(
      <ScrollArea data-testid='root' scrollbars='horizontal'>
        <p>x</p>
      </ScrollArea>,
    );
    const rail = container.querySelector('[data-orientation="horizontal"]') as HTMLElement;
    const added: string[] = [];
    const removed: string[] = [];
    const origAdd = rail.addEventListener.bind(rail);
    const origRemove = rail.removeEventListener.bind(rail);
    rail.addEventListener = ((type: string, ...rest: unknown[]) => {
      added.push(type);
      return (origAdd as (t: string, ...r: unknown[]) => void)(type, ...rest);
    }) as typeof rail.addEventListener;
    rail.removeEventListener = ((type: string, ...rest: unknown[]) => {
      removed.push(type);
      return (origRemove as (t: string, ...r: unknown[]) => void)(type, ...rest);
    }) as typeof rail.removeEventListener;

    rail.setPointerCapture = vi.fn();
    rail.releasePointerCapture = vi.fn();
    Object.defineProperty(rail, 'clientWidth', { value: 200, configurable: true });
    const thumb = rail.firstElementChild as HTMLElement;
    Object.defineProperty(thumb, 'offsetWidth', { value: 40, configurable: true });
    const viewport = container.querySelector(
      '[data-radix-scroll-area-viewport]',
    ) as HTMLElement;
    Object.defineProperty(viewport, 'scrollWidth', { value: 1000, configurable: true });
    Object.defineProperty(viewport, 'clientWidth', { value: 200, configurable: true });

    fireEvent.pointerDown(rail, { button: 0, pointerId: 1, clientX: 50 });
    expect(added).toContain('pointermove');
    // Every path out of a gesture has to reach `end`, and only this one
    // fires when the capture goes away without a release on this element.
    expect(added).toContain('lostpointercapture');

    fireEvent(rail, new Event('lostpointercapture'));
    expect(removed).toContain('pointermove');
    expect(rail.dataset.dragging).toBeUndefined();
  });
  it('owns a press on a scrollable rail even when the track is degenerate (2026-08-29)', () => {
    // The thumb has a floor, so on a very short rail the travel left for it
    // goes negative while the content is still fully scrollable. Refusing the
    // press there hands the gesture to the primitive underneath, whose model
    // is jump-to-point in SCREEN space — a different drag on the one geometry
    // where the two disagree most, and it also writes body and viewport
    // styles behind this component's back. Ownership is claimed before the
    // geometry is judged.
    const { container } = render(
      <ScrollArea data-testid='root' scrollbars='horizontal'>
        <p>x</p>
      </ScrollArea>,
    );
    const rail = container.querySelector('[data-orientation="horizontal"]') as HTMLElement;
    rail.setPointerCapture = vi.fn();
    rail.releasePointerCapture = vi.fn();
    const thumb = rail.firstElementChild as HTMLElement;
    // 14px rail, 18px thumb floor: track range is negative.
    Object.defineProperty(rail, 'clientWidth', { value: 14, configurable: true });
    Object.defineProperty(rail, 'offsetWidth', { value: 14, configurable: true });
    Object.defineProperty(thumb, 'offsetWidth', { value: 18, configurable: true });
    const viewport = container.querySelector(
      '[data-radix-scroll-area-viewport]',
    ) as HTMLElement;
    Object.defineProperty(viewport, 'scrollWidth', { value: 3693, configurable: true });
    Object.defineProperty(viewport, 'clientWidth', { value: 14, configurable: true });

    let scrollLeft = 0;
    Object.defineProperty(viewport, 'scrollLeft', {
      get: () => scrollLeft,
      set: (v: number) => {
        scrollLeft = v;
      },
      configurable: true,
    });

    fireEvent.pointerDown(rail, { button: 0, pointerId: 1, clientX: 7 });
    // Ownership shows in the gesture being ours: the rail is stamped and the
    // moves that follow are the ones this file writes.
    expect(rail.dataset.dragging).toBe('true');
    fireEvent(rail, new PointerEvent('pointermove', { clientX: 12 }));
    expect(scrollLeft).toBeGreaterThan(0);
  });

  it('keeps the thumb under the cursor across a mid-gesture relayout (2026-08-29)', () => {
    // What a drag has to hold on to is the point the pointer grabbed INSIDE
    // the thumb: it is the one quantity a relayout cannot invalidate. Carrying
    // a scroll offset instead ties the gesture to the ratio in force when it
    // started, and the moment the ratio changes the thumb settles a fixed
    // distance from the cursor and stays there for the rest of the drag.
    // Measured in a browser before this: growing the strip's content mid-drag
    // put the thumb 40px from the cursor and it never came back — four
    // consecutive samples all read −40. This strip relayouts readily (a
    // collaborator renames a Space) and so does every other scroller in the
    // app (the node-history panel loads a page while its bar is being
    // dragged).
    const { container } = render(
      <ScrollArea data-testid='root' scrollbars='horizontal'>
        <p>x</p>
      </ScrollArea>,
    );
    const rail = container.querySelector('[data-orientation="horizontal"]') as HTMLElement;
    rail.setPointerCapture = vi.fn();
    rail.releasePointerCapture = vi.fn();
    const thumb = rail.firstElementChild as HTMLElement;
    const viewport = container.querySelector(
      '[data-radix-scroll-area-viewport]',
    ) as HTMLElement;
    const THUMB = 40;
    const MAX_SCROLL = 800;
    let railWidth = 200;
    Object.defineProperty(rail, 'clientWidth', { get: () => railWidth, configurable: true });
    Object.defineProperty(rail, 'offsetWidth', { get: () => railWidth, configurable: true });
    rail.getBoundingClientRect = (() =>
      ({ left: 0, top: 0, width: railWidth, height: 8 })) as typeof rail.getBoundingClientRect;
    Object.defineProperty(thumb, 'offsetWidth', { value: THUMB, configurable: true });
    thumb.getBoundingClientRect = (() =>
      ({ left: 0, right: THUMB, top: 0, bottom: 8 })) as typeof thumb.getBoundingClientRect;
    let scrollLeft = 0;
    Object.defineProperty(viewport, 'scrollLeft', {
      get: () => scrollLeft,
      set: (v: number) => {
        scrollLeft = v;
      },
      configurable: true,
    });
    Object.defineProperty(viewport, 'scrollWidth', { value: 1000, configurable: true });
    Object.defineProperty(viewport, 'clientWidth', { value: 200, configurable: true });

    /**
     * Where the pointer is holding the thumb, in the rail's own coordinates.
     * @param pointerX - The pointer's x, which is also its offset into the rail here.
     * @returns The distance from the thumb's leading edge to the pointer.
     */
    const grabAt = (pointerX: number): number =>
      pointerX - scrollLeft / (MAX_SCROLL / (railWidth - 2 - THUMB));

    // Press the track, which starts the gesture from a non-zero offset — the
    // state in which the frozen offset and the live ratio disagree.
    fireEvent.pointerDown(rail, { button: 0, pointerId: 1, clientX: 150 });
    fireEvent(rail, new PointerEvent('pointermove', { clientX: 160 }));
    const grabBefore = grabAt(160);
    expect(grabBefore).toBeCloseTo(1 + THUMB / 2, 5);

    // The rail doubles without the pointer moving: same cursor, new ratio.
    railWidth = 400;
    fireEvent(rail, new PointerEvent('pointermove', { clientX: 160 }));
    expect(grabAt(160)).toBeCloseTo(grabBefore, 5);
  });
});
