import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

import { Separator } from '@/components/ui/separator';

describe('Separator', () => {
  it('renders a div with bg-border token class', () => {
    render(<Separator data-testid='sep' />);
    const el = screen.getByTestId('sep');
    expect(el.className).toContain('bg-border');
    expect(el.className).toContain('shrink-0');
  });

  it('horizontal orientation (default): h-[1px] w-full', () => {
    render(<Separator data-testid='sep' />);
    const el = screen.getByTestId('sep');
    expect(el.className).toContain('h-[1px]');
    expect(el.className).toContain('w-full');
    expect(el).toHaveAttribute('data-orientation', 'horizontal');
  });

  it('vertical orientation: h-full w-[1px]', () => {
    render(<Separator data-testid='sep' orientation='vertical' />);
    const el = screen.getByTestId('sep');
    expect(el.className).toContain('h-full');
    expect(el.className).toContain('w-[1px]');
    expect(el).toHaveAttribute('data-orientation', 'vertical');
  });

  it('decorative=true (default) hides from a11y tree (role=none)', () => {
    render(<Separator data-testid='sep' />);
    const el = screen.getByTestId('sep');
    // Radix sets role="none" when decorative; otherwise role="separator".
    expect(el).toHaveAttribute('role', 'none');
  });

  it('decorative=false exposes role=separator to a11y tree', () => {
    render(<Separator data-testid='sep' decorative={false} />);
    const el = screen.getByTestId('sep');
    expect(el).toHaveAttribute('role', 'separator');
  });
});
