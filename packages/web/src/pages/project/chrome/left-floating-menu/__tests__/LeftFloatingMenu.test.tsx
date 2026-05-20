import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { LeftFloatingMenu } from '@/pages/project/chrome/left-floating-menu/LeftFloatingMenu';
import { TooltipProvider } from '@/components/ui/tooltip';

function setup(active?: Parameters<typeof LeftFloatingMenu>[0]['active']) {
  const onPick = vi.fn();
  render(
    <TooltipProvider>
      <LeftFloatingMenu active={active} onPick={onPick} />
    </TooltipProvider>,
  );
  return { onPick };
}

describe('LeftFloatingMenu', () => {
  it('renders the nav landmark', () => {
    setup();
    expect(screen.getByTestId('left-floating-menu')).toBeInTheDocument();
  });

  it('exposes one button per tool (6 total)', () => {
    setup();
    expect(screen.getByTestId('tool-select')).toBeInTheDocument();
    expect(screen.getByTestId('tool-text')).toBeInTheDocument();
    expect(screen.getByTestId('tool-image')).toBeInTheDocument();
    expect(screen.getByTestId('tool-draw')).toBeInTheDocument();
    expect(screen.getByTestId('tool-sticky')).toBeInTheDocument();
    expect(screen.getByTestId('tool-layers')).toBeInTheDocument();
  });

  it('clicking a tool calls onPick with its id', async () => {
    const user = userEvent.setup();
    const { onPick } = setup();
    await user.click(screen.getByTestId('tool-image'));
    expect(onPick).toHaveBeenCalledWith('image');
  });

  it('active tool has aria-pressed=true', () => {
    setup('draw');
    expect(
      screen.getByTestId('tool-draw').getAttribute('aria-pressed'),
    ).toBe('true');
  });

  it('non-active tools have aria-pressed=false', () => {
    setup('draw');
    expect(
      screen.getByTestId('tool-select').getAttribute('aria-pressed'),
    ).toBe('false');
  });
});
