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

  it('rail idles HIDDEN with its hover zone gated until content is scrollable (ratified visibility contract)', () => {
    // The rail is force-mounted so its hover zone can reveal a hidden bar
    // (2026-07-15), but at idle it must be data-state hidden (opacity-0 via
    // the transition classes) and — in jsdom, where nothing is scrollable —
    // the per-axis gate must disable its pointer events so a non-scrollable
    // rail can neither hover-reveal nor swallow edge clicks.
    const { container } = render(
      <ScrollArea data-testid='root'>
        <p>x</p>
      </ScrollArea>,
    );
    const rail = container.querySelector('[data-orientation="vertical"]') as HTMLElement;
    expect(rail).not.toBeNull();
    expect(rail.getAttribute('data-state')).toBe('hidden');
    expect(rail.className).toContain('opacity-0');
    expect(rail.className).toContain('hover:opacity-100');
    expect(rail.className).toContain('group-data-[scrollable-y=false]/scroller:pointer-events-none');
    expect(screen.getByTestId('root').getAttribute('data-scrollable-y')).toBe('false');
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
    expect(thumb.className).toContain('transition-opacity');
    // No scale/width hover response anywhere on the thumb.
    expect(thumb.className).not.toMatch(/hover:(w-|h-|scale)/);
  });

  describe('input-state contract (user-ratified 2026-07-15): scrollbar interaction never disturbs focus/selection', () => {
    it('prevents mousedown default on the scrollbar rail (the focus/selection-changing action)', () => {
      const { container } = render(
        <ScrollAreaPrimitive.Root type='always'>
          <ScrollAreaPrimitive.Viewport />
          <ScrollBar forceMount orientation='vertical' />
        </ScrollAreaPrimitive.Root>,
      );
      const bar = container.querySelector('[data-orientation="vertical"]');
      expect(bar).not.toBeNull();
      // fireEvent returns false when preventDefault was called.
      expect(fireEvent.mouseDown(bar as HTMLElement)).toBe(false);
    });

    it('keeps focus on a focused textarea when the scrollbar is pressed', () => {
      const { container } = render(
        <ScrollAreaPrimitive.Root type='always'>
          <ScrollAreaPrimitive.Viewport>
            <textarea data-testid='input' defaultValue='typing…' />
          </ScrollAreaPrimitive.Viewport>
          <ScrollBar forceMount orientation='vertical' />
        </ScrollAreaPrimitive.Root>,
      );
      const input = screen.getByTestId('input');
      input.focus();
      expect(document.activeElement).toBe(input);
      const bar = container.querySelector('[data-orientation="vertical"]');
      fireEvent.mouseDown(bar as HTMLElement);
      expect(document.activeElement).toBe(input);
    });

    it('a caller-supplied onMouseDown cannot remove the contract (chained after preventDefault)', () => {
      const spy = vi.fn();
      const { container } = render(
        <ScrollAreaPrimitive.Root type='always'>
          <ScrollAreaPrimitive.Viewport />
          <ScrollBar forceMount orientation='vertical' onMouseDown={spy} />
        </ScrollAreaPrimitive.Root>,
      );
      const bar = container.querySelector('[data-orientation="vertical"]');
      expect(fireEvent.mouseDown(bar as HTMLElement)).toBe(false);
      expect(spy).toHaveBeenCalledTimes(1);
    });
  });
});
