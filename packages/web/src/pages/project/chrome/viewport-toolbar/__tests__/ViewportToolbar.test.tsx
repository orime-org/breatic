import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { ViewportToolbar } from '@/pages/project/chrome/viewport-toolbar/ViewportToolbar';

function setup(zoom = 1) {
  const handlers = {
    onZoomIn: vi.fn(),
    onZoomOut: vi.fn(),
    onFit: vi.fn(),
    onToggleLock: vi.fn(),
    onToggleMinimap: vi.fn(),
  };
  render(
    <ViewportToolbar
      zoom={zoom}
      locked={false}
      minimapVisible={true}
      {...handlers}
    />,
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

  it('clicking Zoom in / out / Fit invoke their handlers', async () => {
    const user = userEvent.setup();
    const handlers = setup();
    await user.click(screen.getByLabelText('Zoom in'));
    await user.click(screen.getByLabelText('Zoom out'));
    await user.click(screen.getByLabelText('Fit to view'));
    expect(handlers.onZoomIn).toHaveBeenCalledTimes(1);
    expect(handlers.onZoomOut).toHaveBeenCalledTimes(1);
    expect(handlers.onFit).toHaveBeenCalledTimes(1);
  });

  it('lock button aria-label reflects locked state', () => {
    setup();
    expect(screen.getByLabelText('Lock viewport')).toBeInTheDocument();
  });
});
