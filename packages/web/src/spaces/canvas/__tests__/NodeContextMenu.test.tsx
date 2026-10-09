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
    setup({
      target: 'node',
      onUpload: () => {},
      onGenerate: () => {},
      toolsOffered: true,
    });
    expect(screen.getByTestId('node-menu-generate')).toBeInTheDocument();
    expect(screen.getByTestId('node-menu-upload')).toBeInTheDocument();
    expect(screen.getByTestId('node-menu-tools')).toBeInTheDocument();
  });

  it('leaves generate out for a node kind that does not generate; upload active', () => {
    setup({ target: 'node', onUpload: () => {} });
    expect(screen.queryByTestId('node-menu-generate')).toBeNull();
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
    setup({
      target: 'group',
      onUpload: () => {},
      onUngroup: () => {},
      toolsOffered: true,
    });
    expect(screen.queryByTestId('node-menu-generate')).toBeNull();
    expect(screen.queryByTestId('node-menu-upload')).toBeNull();
    expect(screen.queryByTestId('node-menu-tools')).toBeNull();
  });

  it('node target: omits generate / upload / tools without onUpload (viewer)', () => {
    setup({ target: 'node', toolsOffered: true });
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

  // Download and Understand act on the asset a node is showing, and a text
  // node shows none — it holds words. An item greyed out on every text node
  // forever says "not right now" about something that is never going to be
  // offered, so the two are absent rather than disabled (user 2026-09-20).
  // Snapshot is the same distinction read the other way: it is offered on
  // text nodes and absent elsewhere. Tools answers to its own prop.
  it.each([
    ['node-menu-download'],
    ['node-menu-understand'],
  ])('leaves out %s on a node holding no asset', (testId) => {
    setup({ target: 'node', onUpload: () => {}, assetActionsOffered: false });
    expect(screen.queryByTestId(testId)).toBeNull();
  });

  // The other half: a node that DOES show an asset keeps both, greyed when
  // this particular node cannot act right now.
  it.each([
    ['node-menu-download'],
    ['node-menu-understand'],
  ])('keeps %s on a node holding an asset', (testId) => {
    setup({ target: 'node', onUpload: () => {} });
    expect(screen.getByTestId(testId)).not.toBeNull();
  });

  // inner#888 §7.1: Tools is a submenu listing the tools this node's kind
  // offers. Whether the kind is offered any is its own prop, apart from the
  // asset actions; a node of such a kind with nothing in it greys the row.
  describe('tools submenu', () => {
    const TOOLS = [
      { id: 'image.upscale', labelKey: 'canvas.miniTool.image.upscale.label', icon: 'Maximize2' as const, model: true },
      { id: 'image.remove-bg', labelKey: 'canvas.miniTool.image.remove-bg.label', icon: 'Eraser' as const, model: true },
    ];

    it('leaves Tools out for a kind that offers no tools', () => {
      setup({ target: 'node', onUpload: () => {} });
      expect(screen.queryByTestId('node-menu-tools')).toBeNull();
    });

    it('greys Tools on a node of such a kind that holds nothing yet', () => {
      setup({ target: 'node', onUpload: () => {}, toolsOffered: true });
      expect(screen.getByTestId('node-menu-tools')).toHaveAttribute(
        'data-disabled',
      );
    });

    it('lists the offered tools in order and hands back the one chosen', () => {
      const onTool = vi.fn();
      setup({
        target: 'node',
        onUpload: () => {},
        toolsOffered: true,
        tools: TOOLS,
        onTool,
      });

      const trigger = screen.getByTestId('node-menu-tools');
      expect(trigger).not.toHaveAttribute('data-disabled');
      fireEvent.keyDown(trigger, { key: 'ArrowRight' });

      const items = screen.getAllByTestId(/^node-menu-tool-/);
      expect(items.map((item) => item.dataset.testid)).toEqual([
        'node-menu-tool-image.upscale',
        'node-menu-tool-image.remove-bg',
      ]);
      // Each row leads with its tool's icon, as the menu's other rows do.
      expect(items.every((item) => item.querySelector('svg') !== null)).toBe(true);
      fireEvent.click(screen.getByTestId('node-menu-tool-image.remove-bg'));
      expect(onTool).toHaveBeenCalledWith('image.remove-bg');
    });

    it('puts a separator before the model tools, and only there', () => {
      setup({
        target: 'node',
        onUpload: () => {},
        toolsOffered: true,
        tools: [
          { id: 'image.crop', labelKey: 'canvas.miniTool.image.crop.label', icon: 'Crop' as const, model: false },
          { id: 'image.rotate', labelKey: 'canvas.miniTool.image.rotate.label', icon: 'RotateCw' as const, model: false },
          ...TOOLS,
        ],
        onTool: () => {},
      });
      fireEvent.keyDown(screen.getByTestId('node-menu-tools'), { key: 'ArrowRight' });

      const rows = [...screen.getByTestId('node-menu-tool-image.crop').parentElement!.children];
      expect(rows.map((row) => row.getAttribute('data-testid') ?? row.getAttribute('role'))).toEqual([
        'node-menu-tool-image.crop',
        'node-menu-tool-image.rotate',
        'separator',
        'node-menu-tool-image.upscale',
        'node-menu-tool-image.remove-bg',
      ]);
    });

    it('keeps Tools apart from the asset actions', () => {
      setup({
        target: 'node',
        onUpload: () => {},
        assetActionsOffered: false,
        toolsOffered: true,
        tools: TOOLS,
        onTool: () => {},
      });
      expect(screen.queryByTestId('node-menu-download')).toBeNull();
      expect(screen.getByTestId('node-menu-tools')).toBeInTheDocument();
    });
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

  // #2175: only a text node offers Snapshot. Every other modality's content
  // is an asset that already has a row of its own; words are replaced by the
  // next keystroke and nothing keeps them unless the reader says so.
  it('leaves Snapshot off a node that is not made of words', () => {
    setup({ target: 'node', onUpload: () => {} });
    expect(screen.queryByTestId('node-menu-snapshot')).toBeNull();
  });

  // Same answer Download gives a node showing nothing: the item stays where
  // the reader expects it, greyed out, rather than disappearing.
  it('disables Snapshot on a node saying nothing', () => {
    setup({ target: 'node', onUpload: () => {}, snapshotOffered: true });
    expect(screen.getByTestId('node-menu-snapshot')).toHaveAttribute(
      'data-disabled',
    );
  });

  it('fires onSnapshot when a node with words offers it', () => {
    const onSnapshot = vi.fn();
    setup({
      target: 'node',
      onUpload: () => {},
      snapshotOffered: true,
      onSnapshot,
    });
    const item = screen.getByTestId('node-menu-snapshot');
    expect(item).not.toHaveAttribute('data-disabled');
    fireEvent.click(item);
    expect(onSnapshot).toHaveBeenCalledTimes(1);
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

describe('NodeContextMenu — adding to the agent', () => {
  it('hands the node to the agent when chosen', () => {
    const onAddToAgent = vi.fn();
    setup({ onAddToAgent });

    fireEvent.click(screen.getByTestId('node-menu-add-to-agent'));

    expect(onAddToAgent).toHaveBeenCalledTimes(1);
  });

  it('is offered for a group too', () => {
    setup({ target: 'group', onAddToAgent: () => {} });

    expect(screen.getByTestId('node-menu-add-to-agent')).toBeInTheDocument();
  });

  it('is shown but not available while the chat is changing conversation', () => {
    setup({ onAddToAgent: () => {}, addToAgentDisabled: true });

    expect(screen.getByTestId('node-menu-add-to-agent')).toHaveAttribute('data-disabled');
  });

  it('is not offered without a handler', () => {
    setup();

    expect(screen.queryByTestId('node-menu-add-to-agent')).not.toBeInTheDocument();
  });

  it('sits right above delete, each in a group of its own', () => {
    setup({ onAddToAgent: () => {}, onDelete: () => {}, onUpload: () => {}, onCopy: () => {} });
    const items = Array.from(document.querySelectorAll('[role="menuitem"], [role="separator"]')).map((el) =>
      el.getAttribute('role') === 'separator' ? '---' : el.getAttribute('data-testid'),
    );

    expect(items.slice(-4)).toEqual(['---', 'node-menu-add-to-agent', '---', 'node-menu-delete']);
  });
});

