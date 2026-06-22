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

  it('group target: shows ungroup / rename / delete, never copy / duplicate', () => {
    setup({
      target: 'group',
      onUngroup: () => {},
      onRename: () => {},
      onDelete: () => {},
      // copy / duplicate are node-only even if handlers are passed
      onCopy: () => {},
      onDuplicate: () => {},
    });
    expect(screen.getByTestId('node-menu-ungroup')).toBeInTheDocument();
    expect(screen.getByTestId('node-menu-rename')).toBeInTheDocument();
    expect(screen.getByTestId('node-menu-delete')).toBeInTheDocument();
    expect(screen.queryByTestId('node-menu-copy')).toBeNull();
    expect(screen.queryByTestId('node-menu-duplicate')).toBeNull();
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

  it('generate / tools are disabled placeholders; upload is active', () => {
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

  it('fires onUpload when the upload item is chosen', () => {
    const onUpload = vi.fn();
    setup({ target: 'node', onUpload });
    fireEvent.click(screen.getByTestId('node-menu-upload'));
    expect(onUpload).toHaveBeenCalledTimes(1);
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
