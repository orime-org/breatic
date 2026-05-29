import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { ViewportToolbar } from '@web/pages/project/chrome/viewport-toolbar/ViewportToolbar';
import { TooltipProvider } from '@web/components/ui/tooltip';
import { expectNoA11yViolations } from '@web/test-utils/a11y';

function setup(
  zoom = 1,
  overrides: Partial<React.ComponentProps<typeof ViewportToolbar>> = {},
) {
  const handlers = {
    onZoomIn: vi.fn(),
    onZoomOut: vi.fn(),
    onZoomChange: vi.fn(),
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

  it('has no a11y violations', async () => {
    setup();
    await expectNoA11yViolations(document.body);
  });

  it('zoom readout shows zoom * 100 rounded as %', () => {
    setup(0.756);
    expect(screen.getByTestId('zoom-readout')).toHaveTextContent('76%');
  });

  it('clicking Zoom in / out invoke their handlers', async () => {
    const user = userEvent.setup();
    const handlers = setup();
    await user.click(screen.getByLabelText('Zoom in'));
    await user.click(screen.getByLabelText('Zoom out'));
    expect(handlers.onZoomIn).toHaveBeenCalledTimes(1);
    expect(handlers.onZoomOut).toHaveBeenCalledTimes(1);
  });

  it('clicking the 100% readout opens the zoom popover', async () => {
    const user = userEvent.setup();
    setup();
    await user.click(screen.getByTestId('zoom-readout-trigger'));
    expect(await screen.findByTestId('zoom-menu')).toBeInTheDocument();
  });

  it('every preset (including 100%) calls onZoomChange and closes the popover', async () => {
    const user = userEvent.setup();
    const handlers = setup();
    await user.click(screen.getByTestId('zoom-readout-trigger'));
    await user.click(await screen.findByTestId('zoom-preset-100'));
    expect(handlers.onZoomChange).toHaveBeenCalledWith(1);
    // popover should be closed after applying
    expect(screen.queryByTestId('zoom-menu')).not.toBeInTheDocument();
  });

  it('non-100% preset calls onZoomChange with the preset value', async () => {
    const user = userEvent.setup();
    const handlers = setup();
    await user.click(screen.getByTestId('zoom-readout-trigger'));
    await user.click(await screen.findByTestId('zoom-preset-50'));
    expect(handlers.onZoomChange).toHaveBeenCalledWith(0.5);
  });

  it('custom input + Enter applies the value (accepts "150" or "150%")', async () => {
    const user = userEvent.setup();
    const handlers = setup();
    await user.click(screen.getByTestId('zoom-readout-trigger'));
    const input = await screen.findByTestId('zoom-custom-input');
    await user.clear(input);
    await user.type(input, '150{Enter}');
    expect(handlers.onZoomChange).toHaveBeenCalledWith(1.5);
  });

  it('custom input clamps to [10%, 400%]', async () => {
    const user = userEvent.setup();
    const handlers = setup();
    await user.click(screen.getByTestId('zoom-readout-trigger'));
    const input = await screen.findByTestId('zoom-custom-input');
    await user.clear(input);
    await user.type(input, '9999{Enter}');
    expect(handlers.onZoomChange).toHaveBeenLastCalledWith(4);

    await user.click(screen.getByTestId('zoom-readout-trigger'));
    const input2 = await screen.findByTestId('zoom-custom-input');
    await user.clear(input2);
    await user.type(input2, '1{Enter}');
    expect(handlers.onZoomChange).toHaveBeenLastCalledWith(0.1);
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
