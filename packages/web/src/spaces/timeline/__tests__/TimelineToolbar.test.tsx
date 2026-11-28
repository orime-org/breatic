// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * The Timeline toolbar's row (inner#1709 design §6.1, acceptance 12): controls that do not fit move behind More, and a
 * control that appears later is measured before the row settles.
 */

import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { TooltipProvider } from '@web/components/ui/tooltip';
import { TimelineToolbar, type TimelineToolbarEntry } from '@web/spaces/timeline/TimelineToolbar';

const ENTRY = 40;
const MORE = 32;

/**
 * Give every control and More a fixed width and the toolbar a fixed content width.
 * @param room - The toolbar's content width.
 * @throws {never} Never.
 */
function sizeToolbar(room: number): void {
  vi.stubGlobal('ResizeObserver', class {
    readonly #callback: ResizeObserverCallback;
    constructor(callback: ResizeObserverCallback) { this.#callback = callback; }
    observe(target: Element): void {
      this.#callback([{ target, contentRect: { width: room } } as unknown as ResizeObserverEntry], this as unknown as ResizeObserver);
    }
    unobserve(): void {}
    disconnect(): void {}
  });
  const original = Element.prototype.getBoundingClientRect;
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    if (this.hasAttribute('data-toolbar-entry')) return { width: ENTRY } as DOMRect;
    if (this.hasAttribute('data-toolbar-more')) return { width: MORE } as DOMRect;
    return original.call(this);
  });
}

/**
 * A plain control entry.
 * @param id - Its id and test hook.
 * @param end - Whether it sits in the right-aligned part.
 * @returns The entry.
 * @throws {never} Never.
 */
function entry(id: string, end = false): TimelineToolbarEntry {
  return { id, group: end ? 'switch' : 'edit', end, bar: <span data-testid={id} />, row: <div data-testid={`${id}-item`} /> };
}

/**
 * The ids of the controls on the bar, in order.
 * @param container - The rendered toolbar.
 * @returns Their ids.
 * @throws {never} Never.
 */
function onBar(container: HTMLElement): string[] {
  return [...container.querySelectorAll('[data-toolbar-entry]')].map((node) => node.getAttribute('data-toolbar-entry')!);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('TimelineToolbar (inner#1709)', () => {
  it('measures a control that appears while others are behind More and settles back within the row', () => {
    sizeToolbar(2 * ENTRY + MORE);
    const { container, rerender } = render(<TimelineToolbar label='Tracks' moreLabel='More' entries={[entry('a'), entry('b'), entry('c')]} />, { wrapper: TooltipProvider });
    expect(onBar(container)).toEqual(['a', 'b']);
    // A Viewer made an Editor gains controls the toolbar has never measured.
    rerender(<TimelineToolbar label='Tracks' moreLabel='More' entries={[entry('a'), entry('b'), entry('x'), entry('c')]} />);
    expect(onBar(container)).toEqual(['a', 'b']);
  });

  it('pushes the right-aligned part to the end of the row without a separator before it', () => {
    sizeToolbar(4 * ENTRY);
    const { container } = render(<TimelineToolbar label='Tracks' moreLabel='More' entries={[entry('a'), entry('b'), entry('m', true), entry('z', true)]} />, { wrapper: TooltipProvider });
    const start = container.querySelector('[data-toolbar-entry="m"]')!;
    expect(start.classList.contains('ml-auto')).toBe(true);
    expect(start.querySelector('[data-orientation="vertical"]')).toBeNull();
    expect(container.querySelector('[data-toolbar-entry="z"]')!.classList.contains('ml-auto')).toBe(false);
  });

  it('pushes More to the end of the row once the whole right-aligned part is behind it', () => {
    sizeToolbar(2 * ENTRY + MORE);
    const { container } = render(<TimelineToolbar label='Tracks' moreLabel='More' entries={[entry('a'), entry('b'), entry('m', true), entry('z', true)]} />, { wrapper: TooltipProvider });
    expect(onBar(container)).toEqual(['a', 'b']);
    expect(container.querySelector('[data-toolbar-more]')!.classList.contains('ml-auto')).toBe(true);
  });

  it('keeps More\'s tooltip closed when focus comes back to it as its menu closes', () => {
    sizeToolbar(2 * ENTRY + MORE);
    render(<TimelineToolbar label='Tracks' moreLabel='More' entries={[entry('a'), entry('b'), entry('m', true), entry('z', true)]} />, { wrapper: TooltipProvider });
    fireEvent.focus(screen.getByTestId('timeline-more'));
    expect(screen.queryByRole('tooltip')).toBeNull();
  });
});
