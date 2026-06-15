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
      />,
    );
    expect(screen.queryByTestId('create-node-text')).toBeNull();
  });
});
