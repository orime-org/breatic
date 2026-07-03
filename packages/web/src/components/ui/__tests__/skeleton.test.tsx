import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

import { Skeleton } from '@web/components/ui/skeleton';

describe('Skeleton', () => {
  it('renders a <div>', () => {
    render(<Skeleton data-testid='sk' />);
    const el = screen.getByTestId('sk');
    expect(el.tagName).toBe('DIV');
  });

  it('applies the shimmer class, not the old pulse fill (#1550: 10% fill pulsing to 5% was invisible)', () => {
    render(<Skeleton data-testid='sk' />);
    const el = screen.getByTestId('sk');
    expect(el.className).toContain('skeleton-shimmer');
    expect(el.className).not.toContain('animate-pulse');
    expect(el.className).not.toContain('bg-primary/10');
  });

  it('keeps the rounded-md default token', () => {
    render(<Skeleton data-testid='sk' />);
    const el = screen.getByTestId('sk');
    expect(el.className).toContain('rounded-md');
  });

  describe('shimmer stylesheet contract (#1550 spec)', () => {
    const css = readFileSync(
      resolve(__dirname, '../../../index.css'),
      'utf8',
    );

    it('defines the skeleton-shimmer keyframes (a moving highlight, not an opacity pulse)', () => {
      expect(css).toContain('@keyframes skeleton-shimmer');
      expect(css).toContain('background-position');
    });

    it('derives both base fill and highlight from the foreground token (mode-symmetric visibility)', () => {
      const rule = css.slice(css.indexOf('.skeleton-shimmer'));
      expect(rule).toContain('color-mix(in srgb, var(--color-foreground)');
    });

    it('has NO reduced-motion override - the sweep is functional state, not decoration (user-ratified 2026-07-03)', () => {
      // An earlier reduce override silently blanked the animation on
      // reduce-enabled machines, making the loading state unreadable — the
      // very defect this slice fixes. The sweep moves no element (a
      // brightness band, no displacement), so it is not vestibular-trigger
      // motion and must keep playing.
      const shimmerRule = css.slice(css.indexOf('.skeleton-shimmer'));
      const reducedIdx = shimmerRule.indexOf('prefers-reduced-motion');
      if (reducedIdx !== -1) {
        const reducedBlock = shimmerRule.slice(reducedIdx, reducedIdx + 400);
        expect(reducedBlock).not.toContain('animation: none');
      }
      expect(shimmerRule).toContain('animation: skeleton-shimmer');
    });
  });

  it('merges custom sizing className (h-4 w-full)', () => {
    render(<Skeleton data-testid='sk' className='h-4 w-full' />);
    const el = screen.getByTestId('sk');
    expect(el.className).toContain('h-4');
    expect(el.className).toContain('w-full');
  });

  it('custom rounded class overrides default rounded-md (tailwind-merge)', () => {
    render(<Skeleton data-testid='sk' className='rounded-full' />);
    const el = screen.getByTestId('sk');
    expect(el.className).toContain('rounded-full');
    expect(el.className).not.toContain('rounded-md');
  });
});
