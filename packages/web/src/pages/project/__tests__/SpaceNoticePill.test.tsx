// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The shell both top-centre Space notices share (inner#1790 web spec 27.1,
 * V1-01 to V1-06): an opaque base so canvas content never shows through, a
 * tinted surface inside it, and a sentence that wraps instead of being cut.
 * jsdom does no layout, so these read class names; wrapping and an even
 * background are checked in the real browser (V1-R1 to V1-R3).
 */

import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { TriangleAlert } from 'lucide-react';

import { SpaceNoticePill } from '@web/pages/project/SpaceNoticePill';

const OVER_EN = 'This Space is over its limit (83.4 KiB of 64 KiB). You can only delete whole nodes or whole passages.';
const TONES = {
  info: ['bg-status-info-bg', 'border-status-info-border', 'text-status-info-foreground'],
  warning: ['bg-status-warning-bg', 'border-status-warning-border', 'text-status-warning-foreground'],
} as const;
const NO_WRAP = ['truncate', 'whitespace-nowrap', 'text-nowrap'];

/**
 * Renders a pill with a test id on its outer element.
 * @param tone - The tone.
 * @param extra - Optional node after the sentence.
 * @returns The outer element and its surface.
 */
function pill(tone: 'info' | 'warning', extra?: React.ReactNode): { outer: HTMLElement; surface: HTMLElement } {
  render(
    <SpaceNoticePill
      tone={tone}
      icon={TriangleAlert}
      role='status'
      aria-live='polite'
      data-testid='pill'
      data-phase='full'
      data-over-ceiling=''
      className='pointer-events-auto'
      extra={extra}
    >
      {OVER_EN}
    </SpaceNoticePill>,
  );
  const outer = screen.getByTestId('pill');
  expect(outer.children).toHaveLength(1);
  return { outer, surface: outer.firstElementChild as HTMLElement };
}

describe('27.1 SpaceNoticePill', () => {
  it('V1-01 the outer element is an opaque, rounded, shadowed base with no tint and no blur', () => {
    const { outer, surface } = pill('warning');
    expect(outer).toHaveClass('bg-background', 'rounded-overlay', 'shadow-md');
    expect([...outer.classList].some((c) => c.startsWith('bg-status-'))).toBe(false);
    expect(outer).not.toHaveClass('backdrop-blur-sm');
    expect(surface).not.toHaveClass('backdrop-blur-sm');
  });

  it.each(['info', 'warning'] as const)('V1-02 %s: the surface carries that tone and nothing of the other', (tone) => {
    const { outer, surface } = pill(tone);
    expect(surface).toHaveClass(...TONES[tone], 'border', 'rounded-overlay');
    const other = tone === 'info' ? TONES.warning : TONES.info;
    for (const cls of other) {
      expect(surface).not.toHaveClass(cls);
      expect(outer).not.toHaveClass(cls);
    }
  });

  it('V1-03 the sentence wraps (text-balance) and nothing between it and the outer element cuts it', () => {
    const { outer } = pill('warning');
    const sentence = screen.getByText(OVER_EN);
    expect(sentence).toHaveClass('text-balance');
    expect(sentence.textContent).toBe(OVER_EN);
    for (let el: HTMLElement | null = sentence; el && el !== outer.parentElement; el = el.parentElement) {
      for (const cls of NO_WRAP) expect(el).not.toHaveClass(cls);
      expect([...el.classList].some((c) => c.startsWith('line-clamp-'))).toBe(false);
    }
  });

  it('V1-04 role, aria-live, test id and data attributes sit on the outer element only', () => {
    const { outer, surface } = pill('warning');
    expect(outer).toHaveAttribute('role', 'status');
    expect(outer).toHaveAttribute('aria-live', 'polite');
    expect(outer).toHaveAttribute('data-phase', 'full');
    expect(outer).toHaveAttribute('data-over-ceiling', '');
    for (const el of [surface, ...surface.querySelectorAll('*')]) {
      for (const attr of ['role', 'aria-live', 'data-testid', 'data-phase', 'data-over-ceiling']) expect(el.hasAttribute(attr)).toBe(false);
    }
  });

  it('V1-05 className merges into the outer element and keeps its defaults; the surface does not get it', () => {
    const { outer, surface } = pill('warning');
    expect(outer).toHaveClass('pointer-events-auto', 'bg-background', 'rounded-overlay', 'shadow-md');
    expect(surface).not.toHaveClass('pointer-events-auto');
  });

  it('V1-06 the icon comes before the sentence, the extra node after it, both inside the surface', () => {
    const { surface } = pill('warning', <button type='button'>Reconnect</button>);
    const kids = [...surface.children];
    expect(kids).toHaveLength(3);
    expect(kids[0].tagName.toLowerCase()).toBe('svg');
    expect(kids[0]).toHaveAttribute('aria-hidden');
    expect(kids[1].textContent).toBe(OVER_EN);
    expect(kids[2].textContent).toBe('Reconnect');
  });

  it('V1-06 without an extra node the surface holds only the icon and the sentence', () => {
    const { surface } = pill('info');
    expect(surface.children).toHaveLength(2);
  });
});
