// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

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

  // #2108: the parent supplies onDownload only for a node whose body is
  // showing an asset. The item is on the menu either way — without a handler
  // it is disabled, so the reader sees that this node has nothing to take.
  it('disables the download item when no handler is supplied', () => {
    setup({ target: 'node', onUpload: () => {} });
    expect(screen.getByTestId('node-menu-download')).toHaveAttribute(
      'data-disabled',
    );
  });

  // The item is implemented and this node just does not qualify, so the
  // pointer says so. `itemBase` turns pointer events off on a disabled item,
  // which hands the cursor back to the menu surface and its plain arrow, so
  // both halves of the override carry the answer.
  it('refuses the pointer over a download this node cannot offer', () => {
    setup({ target: 'node', onUpload: () => {} });

    const item = screen.getByTestId('node-menu-download');
    expect(item.className).toContain('data-[disabled]:pointer-events-auto');
    expect(item.className).toContain('data-[disabled]:cursor-not-allowed');
  });

  it('shows the download item once for a node offering one', () => {
    setup({ target: 'node', onUpload: () => {}, onDownload: () => {} });
    expect(screen.getAllByTestId('node-menu-download')).toHaveLength(1);
  });

  // Understand sits with Download because both act on the asset the node is
  // showing, and both are answered the same way when it is showing none.
  it('disables the understand item when no handler is supplied', () => {
    setup({ target: 'node', onUpload: () => {} });
    expect(screen.getByTestId('node-menu-understand')).toHaveAttribute(
      'data-disabled',
    );
  });

  it('refuses the pointer over an understand this node cannot offer', () => {
    setup({ target: 'node', onUpload: () => {} });

    const item = screen.getByTestId('node-menu-understand');
    expect(item.className).toContain('data-[disabled]:pointer-events-auto');
    expect(item.className).toContain('data-[disabled]:cursor-not-allowed');
  });

  it('fires onUnderstand when the understand item is chosen', () => {
    const onUnderstand = vi.fn();
    setup({ target: 'node', onUpload: () => {}, onUnderstand });

    fireEvent.click(screen.getByTestId('node-menu-understand'));
    expect(onUnderstand).toHaveBeenCalledTimes(1);
  });

  it('fires onDownload when the download item is chosen', () => {
    const onDownload = vi.fn();
    setup({ target: 'node', onUpload: () => {}, onDownload });
    const item = screen.getByTestId('node-menu-download');
    expect(item).not.toHaveAttribute('data-disabled');
    fireEvent.click(item);
    expect(onDownload).toHaveBeenCalledTimes(1);
  });

  it('group target: never shows download, handler or not', () => {
    setup({ target: 'group', onUpload: () => {}, onDownload: () => {} });
    expect(screen.queryByTestId('node-menu-download')).toBeNull();
  });
});
