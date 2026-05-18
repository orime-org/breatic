import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '../tooltip';

function setup(open = true) {
  return render(
    <TooltipProvider>
      <Tooltip open={open}>
        <TooltipTrigger asChild>
          <button type="button">Trigger</button>
        </TooltipTrigger>
        <TooltipContent data-testid="content">Tooltip text</TooltipContent>
      </Tooltip>
    </TooltipProvider>,
  );
}

describe('Tooltip', () => {
  it('renders trigger as the wrapped child (asChild)', () => {
    setup(false);
    const trigger = screen.getByRole('button', { name: 'Trigger' });
    expect(trigger).toBeInTheDocument();
  });

  it('does NOT render content when closed', () => {
    setup(false);
    expect(screen.queryByText('Tooltip text')).not.toBeInTheDocument();
  });

  it('renders content when open=true (controlled)', () => {
    setup(true);
    // Radix can render multiple content nodes (visual + a11y); getAllBy.
    const contents = screen.getAllByText('Tooltip text');
    expect(contents.length).toBeGreaterThan(0);
  });

  it('content carries bg-primary + text-primary-foreground tokens', () => {
    setup(true);
    const content = screen.getByTestId('content');
    expect(content.className).toContain('bg-primary');
    expect(content.className).toContain('text-primary-foreground');
  });

  it('content merges custom className (tailwind-merge)', () => {
    render(
      <TooltipProvider>
        <Tooltip open>
          <TooltipTrigger asChild>
            <button type="button">T</button>
          </TooltipTrigger>
          <TooltipContent data-testid="content" className="bg-destructive">
            Err
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>,
    );
    const content = screen.getByTestId('content');
    // tailwind-merge: bg-destructive overrides bg-primary.
    expect(content.className).toContain('bg-destructive');
    expect(content.className).not.toContain('bg-primary');
  });
});
