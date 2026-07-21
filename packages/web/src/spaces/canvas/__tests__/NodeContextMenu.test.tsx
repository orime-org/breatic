// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import type * as React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

import { NodeContextMenu } from '@web/spaces/canvas/NodeContextMenu';

/**
 * Render the node right-click menu open at a fixed point.
 * @param overrides - Props overriding the open/unlocked defaults.
 * @returns The render result.
 */
function setup(
  overrides: Partial<React.ComponentProps<typeof NodeContextMenu>> = {},
): ReturnType<typeof render> {
  return render(
    <NodeContextMenu
      open
      x={10}
      y={10}
      locked={false}
      onOpenChange={() => {}}
      onToggleLock={() => {}}
      {...overrides}
    />,
  );
}

describe('NodeContextMenu', () => {
  it('offers Lock when the node is unlocked', () => {
    setup({ locked: false });
    expect(screen.getByTestId('node-menu-lock-toggle')).toHaveTextContent(
      'Lock',
    );
  });

  it('offers Unlock when the node is locked', () => {
    setup({ locked: true });
    expect(screen.getByTestId('node-menu-lock-toggle')).toHaveTextContent(
      'Unlock',
    );
  });

  it('toggles the lock when the item is chosen', () => {
    const onToggleLock = vi.fn();
    setup({ onToggleLock });
    fireEvent.click(screen.getByTestId('node-menu-lock-toggle'));
    expect(onToggleLock).toHaveBeenCalledTimes(1);
  });

  it('node target: shows copy / duplicate / rename / delete (no ungroup)', () => {
    setup({
      target: 'node',
      onCopy: () => {},
      onDuplicate: () => {},
      onRename: () => {},
      onDelete: () => {},
    });
    expect(screen.getByTestId('node-menu-copy')).toBeInTheDocument();
    expect(screen.getByTestId('node-menu-duplicate')).toBeInTheDocument();
    expect(screen.getByTestId('node-menu-rename')).toBeInTheDocument();
    expect(screen.getByTestId('node-menu-delete')).toBeInTheDocument();
    expect(screen.queryByTestId('node-menu-ungroup')).toBeNull();
  });

  it('group target: shows copy / duplicate / ungroup / rename / delete (R2-D)', () => {
    setup({
      target: 'group',
      onUngroup: () => {},
      onRename: () => {},
      onDelete: () => {},
      onCopy: () => {},
      onDuplicate: () => {},
    });
    // A group copies / duplicates with its members (R2-D), so the items show.
    expect(screen.getByTestId('node-menu-copy')).toBeInTheDocument();
    expect(screen.getByTestId('node-menu-duplicate')).toBeInTheDocument();
    expect(screen.getByTestId('node-menu-ungroup')).toBeInTheDocument();
    expect(screen.getByTestId('node-menu-rename')).toBeInTheDocument();
    expect(screen.getByTestId('node-menu-delete')).toBeInTheDocument();
    // A group never shows the content-node generate / upload / tools block.
    expect(screen.queryByTestId('node-menu-generate')).toBeNull();
  });

  it('node target: delete item reads "Delete node"', () => {
    setup({ target: 'node', onDelete: () => {} });
    expect(screen.getByTestId('node-menu-delete')).toHaveTextContent(
      'Delete node',
    );
  });

  it('group target: delete item reads "Delete group" (distinct from ungroup)', () => {
    setup({ target: 'group', onDelete: () => {}, onUngroup: () => {} });
    expect(screen.getByTestId('node-menu-delete')).toHaveTextContent(
      'Delete group',
    );
    expect(screen.getByTestId('node-menu-ungroup')).toHaveTextContent(
      'Ungroup',
    );
  });

  it('fires the duplicate / delete handlers on selection', () => {
    const onDuplicate = vi.fn();
    const onDelete = vi.fn();
    setup({ target: 'node', onDuplicate, onDelete });
    fireEvent.click(screen.getByTestId('node-menu-duplicate'));
    expect(onDuplicate).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTestId('node-menu-delete'));
    expect(onDelete).toHaveBeenCalledTimes(1);
  });

  it('omits action items whose handlers are not supplied (lock always present)', () => {
    setup({ target: 'node' });
    expect(screen.queryByTestId('node-menu-copy')).toBeNull();
    expect(screen.queryByTestId('node-menu-delete')).toBeNull();
    expect(screen.getByTestId('node-menu-lock-toggle')).toBeInTheDocument();
  });

  it('node target: shows generate / upload / tools at the top', () => {
    setup({ target: 'node', onUpload: () => {} });
    expect(screen.getByTestId('node-menu-generate')).toBeInTheDocument();
    expect(screen.getByTestId('node-menu-upload')).toBeInTheDocument();
    expect(screen.getByTestId('node-menu-tools')).toBeInTheDocument();
  });

  it('generate is a disabled placeholder without onGenerate; tools always disabled; upload active', () => {
    setup({ target: 'node', onUpload: () => {} });
    expect(screen.getByTestId('node-menu-generate')).toHaveAttribute(
      'data-disabled',
    );
    expect(screen.getByTestId('node-menu-tools')).toHaveAttribute(
      'data-disabled',
    );
    expect(screen.getByTestId('node-menu-upload')).not.toHaveAttribute(
      'data-disabled',
    );
  });

  it('generate is enabled and fires onGenerate when a handler is supplied', () => {
    const onGenerate = vi.fn();
    setup({ target: 'node', onUpload: () => {}, onGenerate });
    const item = screen.getByTestId('node-menu-generate');
    expect(item).not.toHaveAttribute('data-disabled');
    fireEvent.click(item);
    expect(onGenerate).toHaveBeenCalledTimes(1);
  });

  it('fires onUpload when the upload item is chosen', () => {
    const onUpload = vi.fn();
    setup({ target: 'node', onUpload });
    fireEvent.click(screen.getByTestId('node-menu-upload'));
    expect(onUpload).toHaveBeenCalledTimes(1);
  });

  // #1623: reset-to-empty-image is image-only. The parent passes onResetImage
  // only for image nodes, so its presence is what shows the item — a text /
  // audio / video node (no handler) never gets it.
  it('shows the reset-empty item only when onResetImage is supplied', () => {
    setup({ target: 'node', onUpload: () => {} });
    expect(screen.queryByTestId('node-menu-reset-image')).toBeNull();
  });

  it('fires onResetImage when the reset-empty item is chosen', () => {
    const onResetImage = vi.fn();
    setup({ target: 'node', onUpload: () => {}, onResetImage });
    fireEvent.click(screen.getByTestId('node-menu-reset-image'));
    expect(onResetImage).toHaveBeenCalledTimes(1);
  });

  it('group target: never shows generate / upload / tools', () => {
    setup({ target: 'group', onUpload: () => {}, onUngroup: () => {} });
    expect(screen.queryByTestId('node-menu-generate')).toBeNull();
    expect(screen.queryByTestId('node-menu-upload')).toBeNull();
    expect(screen.queryByTestId('node-menu-tools')).toBeNull();
  });

  it('node target: omits generate / upload / tools without onUpload (viewer)', () => {
    setup({ target: 'node' });
    expect(screen.queryByTestId('node-menu-generate')).toBeNull();
    expect(screen.queryByTestId('node-menu-upload')).toBeNull();
    expect(screen.queryByTestId('node-menu-tools')).toBeNull();
  });
});
