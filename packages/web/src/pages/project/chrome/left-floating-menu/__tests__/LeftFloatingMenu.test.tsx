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

  it('exposes the 6 mock-spec tools (3 upper + 3 placeholder lower)', () => {
    setup();
    expect(screen.getByTestId('tool-nodes')).toBeInTheDocument();
    expect(screen.getByTestId('tool-upload')).toBeInTheDocument();
    expect(screen.getByTestId('tool-comment')).toBeInTheDocument();
    expect(screen.getByTestId('tool-asset-group')).toBeInTheDocument();
    expect(screen.getByTestId('tool-help')).toBeInTheDocument();
    expect(screen.getByTestId('tool-feedback')).toBeInTheDocument();
  });

  it('renders the divider separating the two zones', () => {
    setup();
    expect(screen.getByTestId('left-menu-divider')).toBeInTheDocument();
  });

  it('clicking a tool calls onPick with its id', async () => {
    const user = userEvent.setup();
    const { onPick } = setup();
    await user.click(screen.getByTestId('tool-upload'));
    expect(onPick).toHaveBeenCalledWith('upload');
  });

  it('active tool has aria-pressed=true', () => {
    setup('nodes');
    expect(
      screen.getByTestId('tool-nodes').getAttribute('aria-pressed'),
    ).toBe('true');
  });

  it('non-active tools have aria-pressed=false', () => {
    setup('nodes');
    expect(
      screen.getByTestId('tool-upload').getAttribute('aria-pressed'),
    ).toBe('false');
  });
});
