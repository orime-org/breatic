// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { ConnectCreateMenu } from '@web/spaces/canvas/ConnectCreateMenu';

// Batch-2 item 3: dragging a wire from an output stub and releasing on blank
// canvas opens this menu — its rows are ONLY the creatable modalities whose
// input accepts the dragged source (connection rules §9.1), so a picked row
// can never be rejected at the edge write.
describe('ConnectCreateMenu', () => {
  it('lists only rule-compatible creatable types for an image source and fires onPick', async () => {
    const user = userEvent.setup();
    const onPick = vi.fn();
    render(
      <ConnectCreateMenu
        open
        x={100}
        y={200}
        sourceKind='image'
        onOpenChange={() => {}}
        onPick={onPick}
      />,
    );
    // image feeds text / image / video — audio's input accepts text only.
    expect(await screen.findByTestId('create-node-text')).toBeInTheDocument();
    expect(screen.getByTestId('create-node-image')).toBeInTheDocument();
    expect(screen.getByTestId('create-node-video')).toBeInTheDocument();
    expect(screen.queryByTestId('create-node-audio')).toBeNull();
    await user.click(screen.getByTestId('create-node-video'));
    expect(onPick).toHaveBeenCalledWith('video');
  });

  it('lists text / video only for an audio source', async () => {
    render(
      <ConnectCreateMenu
        open
        x={0}
        y={0}
        sourceKind='audio'
        onOpenChange={() => {}}
        onPick={() => {}}
      />,
    );
    expect(await screen.findByTestId('create-node-text')).toBeInTheDocument();
    expect(screen.getByTestId('create-node-video')).toBeInTheDocument();
    expect(screen.queryByTestId('create-node-image')).toBeNull();
    expect(screen.queryByTestId('create-node-audio')).toBeNull();
  });

  it('renders no items when closed', () => {
    render(
      <ConnectCreateMenu
        open={false}
        x={0}
        y={0}
        sourceKind='image'
        onOpenChange={() => {}}
        onPick={() => {}}
      />,
    );
    expect(screen.queryByTestId('create-node-text')).toBeNull();
  });
});
