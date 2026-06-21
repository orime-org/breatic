// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { CanvasContextMenu } from '@web/spaces/canvas/CanvasContextMenu';

describe('CanvasContextMenu', () => {
  it('lists the 4 creatable node types when open and fires onPick on selection', async () => {
    const user = userEvent.setup();
    const onPick = vi.fn();
    render(
      <CanvasContextMenu
        open
        x={120}
        y={240}
        onOpenChange={() => {}}
        onPick={onPick}
        onPaste={() => {}}
      />,
    );
    expect(await screen.findByTestId('create-node-text')).toBeInTheDocument();
    expect(screen.getByTestId('create-node-image')).toBeInTheDocument();
    expect(screen.getByTestId('create-node-audio')).toBeInTheDocument();
    expect(screen.getByTestId('create-node-video')).toBeInTheDocument();
    await user.click(screen.getByTestId('create-node-video'));
    expect(onPick).toHaveBeenCalledWith('video');
  });

  it('renders no items when closed', () => {
    render(
      <CanvasContextMenu
        open={false}
        x={0}
        y={0}
        onOpenChange={() => {}}
        onPick={() => {}}
        onPaste={() => {}}
      />,
    );
    expect(screen.queryByTestId('create-node-text')).toBeNull();
  });

  it('shows a Paste item (with shortcut hint) that fires onPaste', async () => {
    const user = userEvent.setup();
    const onPaste = vi.fn();
    render(
      <CanvasContextMenu
        open
        x={0}
        y={0}
        onOpenChange={() => {}}
        onPick={() => {}}
        onPaste={onPaste}
      />,
    );
    const item = await screen.findByTestId('canvas-menu-paste');
    expect(item.textContent).toMatch(/⌘V|Ctrl\+V/);
    await user.click(item);
    expect(onPaste).toHaveBeenCalledTimes(1);
  });
});
