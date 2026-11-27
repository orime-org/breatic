import * as React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

import { Progress } from '@web/components/ui/progress';

describe('Progress', () => {
  it('renders a progressbar whose fill shows the value', () => {
    render(<Progress value={40} data-testid='p' />);
    const bar = screen.getByRole('progressbar');
    expect(bar).toHaveAttribute('aria-valuenow', '40');
    const fill = bar.firstElementChild as HTMLElement;
    expect(fill.style.transform).toBe('translateX(-60%)');
  });

  it('shows indeterminate progress when the value is null', () => {
    render(<Progress value={null} />);
    const bar = screen.getByRole('progressbar');
    expect(bar).toHaveAttribute('data-state', 'indeterminate');
    expect(bar).not.toHaveAttribute('aria-valuenow');
    expect((bar.firstElementChild as HTMLElement).className).toContain('progress-indeterminate');
  });

  it('uses the muted track and a foreground fill, rounded and 4px high', () => {
    render(<Progress value={10} />);
    const bar = screen.getByRole('progressbar');
    expect(bar.className).toContain('bg-muted');
    expect(bar.className).toContain('h-1');
    expect(bar.className).toContain('rounded-full');
    expect((bar.firstElementChild as HTMLElement).className).toContain('bg-foreground');
  });

  it('takes a fill colour through indicatorClassName', () => {
    render(<Progress value={10} indicatorClassName='bg-primary' />);
    const fill = screen.getByRole('progressbar').firstElementChild as HTMLElement;
    expect(fill.className).toContain('bg-primary');
    expect(fill.className).not.toContain('bg-foreground');
  });

  it('lets className override a default through cn()', () => {
    render(<Progress value={10} className='h-2' />);
    const bar = screen.getByRole('progressbar');
    expect(bar.className).toContain('h-2');
    expect(bar.className).not.toContain('h-1');
  });

  it('forwards its ref to the root', () => {
    const ref = React.createRef<HTMLDivElement>();
    render(<Progress ref={ref} value={10} />);
    expect(ref.current).toBe(screen.getByRole('progressbar'));
  });
});
