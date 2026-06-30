// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

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

  it('keeps original 32px sizing, with only the even-margin py-1 inset (#1435)', () => {
    setup();
    // The "align to LeftFloatingMenu" resize was reverted (2026-06-20). The bar
    // keeps its original 32px buttons / 14px icons / rounded-md frame; the ONE
    // thing kept is the container `py-1` (not `p-1`), which evens the end-button
    // hover-fill insets — `p-1` + each Group's `px-1` gave 8px sides / 4px top.
    const toolbar = screen.getByTestId('viewport-toolbar');
    expect(toolbar.className).toContain('py-1');
    expect(toolbar.className).not.toContain('p-1');
    expect(toolbar.className).toContain('rounded-md');
    // Buttons back to 32px (h-8 w-8) + rounded-md.
    const undo = screen.getByLabelText('Undo');
    expect(undo.className).toContain('h-8');
    expect(undo.className).toContain('rounded-md');
    // Icons back to 14px (h-3.5).
    const icon = undo.querySelector('svg');
    expect(icon?.getAttribute('class') ?? '').toContain('h-3.5');
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

  it('custom input clamps to [10%, 800%]', async () => {
    const user = userEvent.setup();
    const handlers = setup();
    await user.click(screen.getByTestId('zoom-readout-trigger'));
    const input = await screen.findByTestId('zoom-custom-input');
    await user.clear(input);
    await user.type(input, '9999{Enter}');
    expect(handlers.onZoomChange).toHaveBeenLastCalledWith(8);

    await user.click(screen.getByTestId('zoom-readout-trigger'));
    const input2 = await screen.findByTestId('zoom-custom-input');
    await user.clear(input2);
    await user.type(input2, '1{Enter}');
    expect(handlers.onZoomChange).toHaveBeenLastCalledWith(0.1);
  });

  it('zoom presets are 10/25/50/100/150/200/400/800', async () => {
    const user = userEvent.setup();
    setup();
    await user.click(screen.getByTestId('zoom-readout-trigger'));
    await screen.findByTestId('zoom-menu');
    expect(screen.getByTestId('zoom-preset-10')).toBeInTheDocument();
    expect(screen.getByTestId('zoom-preset-400')).toBeInTheDocument();
    expect(screen.getByTestId('zoom-preset-800')).toBeInTheDocument();
  });

  it('closing the zoom popover returns focus to the readout without re-popping its tooltip', async () => {
    // C mechanism (Popover family): focus returns to the readout on close;
    // its `onFocusCapture` stops the tooltip from opening on that refocus.
    // (Tooltip-not-popping is also covered by real-browser smoke.)
    const user = userEvent.setup();
    setup();
    const trigger = screen.getByTestId('zoom-readout-trigger');
    await user.click(trigger);
    await screen.findByTestId('zoom-menu');
    await user.keyboard('{Escape}');
    expect(document.activeElement).toBe(trigger);
    expect(
      document.querySelector(
        '[data-state="instant-open"],[data-state="delayed-open"]',
      ),
    ).toBeNull();
  });

  it('clicking the 400% / 800% presets applies 4 / 8', async () => {
    const user = userEvent.setup();
    const handlers = setup();
    await user.click(screen.getByTestId('zoom-readout-trigger'));
    await user.click(await screen.findByTestId('zoom-preset-400'));
    expect(handlers.onZoomChange).toHaveBeenCalledWith(4);

    await user.click(screen.getByTestId('zoom-readout-trigger'));
    await user.click(await screen.findByTestId('zoom-preset-800'));
    expect(handlers.onZoomChange).toHaveBeenCalledWith(8);
  });

  it('clicking the 10% preset applies 0.1', async () => {
    const user = userEvent.setup();
    const handlers = setup();
    await user.click(screen.getByTestId('zoom-readout-trigger'));
    await user.click(await screen.findByTestId('zoom-preset-10'));
    expect(handlers.onZoomChange).toHaveBeenCalledWith(0.1);
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
