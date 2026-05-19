import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

import { Skeleton } from '../skeleton';

describe('Skeleton', () => {
  it('renders a <div>', () => {
    render(<Skeleton data-testid='sk' />);
    const el = screen.getByTestId('sk');
    expect(el.tagName).toBe('DIV');
  });

  it('applies animate-pulse for the loading shimmer', () => {
    render(<Skeleton data-testid='sk' />);
    const el = screen.getByTestId('sk');
    expect(el.className).toContain('animate-pulse');
  });

  it('applies bg-primary/10 + rounded-md default tokens', () => {
    render(<Skeleton data-testid='sk' />);
    const el = screen.getByTestId('sk');
    expect(el.className).toContain('bg-primary/10');
    expect(el.className).toContain('rounded-md');
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
