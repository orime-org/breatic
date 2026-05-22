import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { ViewportToolbar } from '@/pages/project/chrome/viewport-toolbar/ViewportToolbar';
import { TooltipProvider } from '@/components/ui/tooltip';

function setup(
  zoom = 1,
  overrides: Partial<React.ComponentProps<typeof ViewportToolbar>> = {},
) {
  const handlers = {
    onZoomIn: vi.fn(),
    onZoomOut: vi.fn(),
    onZoomReset: vi.fn(),
    onFit: vi.fn(),
    onToggleSnap: vi.fn(),
    onToggleMinimap: vi.fn(),
    onUndo: vi.fn(),
    onRedo: vi.fn(),
  };
  render(
    <TooltipProvider>
      <ViewportToolbar
        zoom={zoom}
        minimapVisible={true}
        snapToGrid={false}
        {...handlers}
        {...overrides}
      />
    </TooltipProvider>,
  );
  return handlers;
}

describe('ViewportToolbar', () => {
  it('renders the toolbar overlay', () => {
    setup();
    expect(screen.getByTestId('viewport-toolbar')).toBeInTheDocument();
  });

  it('zoom readout shows zoom * 100 rounded as %', () => {
    setup(0.756);
    expect(screen.getByTestId('zoom-readout')).toHaveTextContent('76%');
  });

  it('clicking Zoom in / out / reset invoke their handlers', async () => {
    const user = userEvent.setup();
    const handlers = setup();
    await user.click(screen.getByLabelText('Zoom in'));
    await user.click(screen.getByLabelText('Zoom out'));
    await user.click(screen.getByLabelText('Reset zoom to 100%'));
    expect(handlers.onZoomIn).toHaveBeenCalledTimes(1);
    expect(handlers.onZoomOut).toHaveBeenCalledTimes(1);
    expect(handlers.onZoomReset).toHaveBeenCalledTimes(1);
  });

  it('fit / snap / minimap buttons all wired', async () => {
    const user = userEvent.setup();
    const handlers = setup();
    await user.click(screen.getByLabelText('Fit to viewport'));
    await user.click(screen.getByLabelText('Enable snap to grid'));
    await user.click(screen.getByLabelText('Hide minimap'));
    expect(handlers.onFit).toHaveBeenCalledTimes(1);
    expect(handlers.onToggleSnap).toHaveBeenCalledTimes(1);
    expect(handlers.onToggleMinimap).toHaveBeenCalledTimes(1);
  });

  it('undo / redo render disabled when canUndo / canRedo are false (default)', () => {
    setup();
    const undo = screen.getByLabelText('Undo');
    const redo = screen.getByLabelText('Redo');
    expect(undo).toBeDisabled();
    expect(redo).toBeDisabled();
  });

  it('undo / redo wire to handlers when canUndo / canRedo are true', async () => {
    const user = userEvent.setup();
    const handlers = setup(1, { canUndo: true, canRedo: true });
    await user.click(screen.getByLabelText('Undo'));
    await user.click(screen.getByLabelText('Redo'));
    expect(handlers.onUndo).toHaveBeenCalledTimes(1);
    expect(handlers.onRedo).toHaveBeenCalledTimes(1);
  });

  it('no longer renders expand or alignment-guides controls', () => {
    setup();
    expect(screen.queryByLabelText('Fullscreen')).not.toBeInTheDocument();
    expect(
      screen.queryByLabelText('Enable alignment guides'),
    ).not.toBeInTheDocument();
  });
});
