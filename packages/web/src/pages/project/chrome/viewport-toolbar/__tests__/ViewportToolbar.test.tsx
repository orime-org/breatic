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
    await user.click(screen.getByLabelText('放大'));
    await user.click(screen.getByLabelText('缩小'));
    await user.click(screen.getByLabelText('缩放重置 100%'));
    expect(handlers.onZoomIn).toHaveBeenCalledTimes(1);
    expect(handlers.onZoomOut).toHaveBeenCalledTimes(1);
    expect(handlers.onZoomReset).toHaveBeenCalledTimes(1);
  });

  it('fit / expand / snap / align / minimap buttons all wired', async () => {
    const user = userEvent.setup();
    const handlers = setup();
    await user.click(screen.getByLabelText('适应窗口'));
    await user.click(screen.getByLabelText('全屏'));
    await user.click(screen.getByLabelText('开启网格吸附'));
    await user.click(screen.getByLabelText('开启对齐参考线'));
    await user.click(screen.getByLabelText('隐藏缩略图'));
    expect(handlers.onFit).toHaveBeenCalledTimes(1);
    expect(handlers.onExpand).toHaveBeenCalledTimes(1);
    expect(handlers.onToggleSnap).toHaveBeenCalledTimes(1);
    expect(handlers.onToggleAlign).toHaveBeenCalledTimes(1);
    expect(handlers.onToggleMinimap).toHaveBeenCalledTimes(1);
  });
});
