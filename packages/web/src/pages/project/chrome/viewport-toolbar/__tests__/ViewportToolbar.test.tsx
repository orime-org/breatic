import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { ViewportToolbar } from '@/pages/project/chrome/viewport-toolbar/ViewportToolbar';
import { TooltipProvider } from '@/components/ui/tooltip';

function setup(zoom = 1) {
  const handlers = {
    onZoomIn: vi.fn(),
    onZoomOut: vi.fn(),
    onZoomReset: vi.fn(),
    onFit: vi.fn(),
    onExpand: vi.fn(),
    onToggleSnap: vi.fn(),
    onToggleAlign: vi.fn(),
    onToggleMinimap: vi.fn(),
  };
  render(
    <TooltipProvider>
      <ViewportToolbar
        zoom={zoom}
        minimapVisible={true}
        snapToGrid={false}
        alignActive={false}
        {...handlers}
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

  it('fit / expand / snap / align / minimap buttons all wired', async () => {
    const user = userEvent.setup();
    const handlers = setup();
    await user.click(screen.getByLabelText('Fit to viewport'));
    await user.click(screen.getByLabelText('Fullscreen'));
    await user.click(screen.getByLabelText('Enable snap to grid'));
    await user.click(screen.getByLabelText('Enable alignment guides'));
    await user.click(screen.getByLabelText('Hide minimap'));
    expect(handlers.onFit).toHaveBeenCalledTimes(1);
    expect(handlers.onExpand).toHaveBeenCalledTimes(1);
    expect(handlers.onToggleSnap).toHaveBeenCalledTimes(1);
    expect(handlers.onToggleAlign).toHaveBeenCalledTimes(1);
    expect(handlers.onToggleMinimap).toHaveBeenCalledTimes(1);
  });
});
