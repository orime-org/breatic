// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * The plus beside a multi-selection or a group (inner#2216 design 4.3): its
 * menu offers the four creatable types, greys out the ones no selected node
 * connects into, and ends with Add to Agent after a separator.
 */

import type * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ReactFlowProvider } from '@xyflow/react';

import { SelectionAddButton } from '@web/spaces/canvas/SelectionAddButton';

const TYPES = ['text', 'image', 'audio', 'video'] as const;

/**
 * Renders the plus with defaults the test can override.
 * @param overrides - Props to override.
 * @returns The callbacks handed in.
 */
function setup(overrides: Partial<React.ComponentProps<typeof SelectionAddButton>> = {}): {
  onPick: ReturnType<typeof vi.fn>;
  onAddToAgent: ReturnType<typeof vi.fn>;
  onOpenChange: ReturnType<typeof vi.fn>;
} {
  const onPick = vi.fn();
  const onAddToAgent = vi.fn();
  const onOpenChange = vi.fn();
  render(
    <ReactFlowProvider>
      <SelectionAddButton
        sourceKinds={['image']}
        open
        onOpenChange={onOpenChange}
        onPick={onPick}
        onAddToAgent={onAddToAgent}
        addToAgentDisabled={false}
        {...overrides}
      />
    </ReactFlowProvider>,
  );
  return { onPick, onAddToAgent, onOpenChange };
}

describe('SelectionAddButton', () => {
  it('shows the plus and no menu while closed, and asks to open on a press', async () => {
    const user = userEvent.setup();
    const { onOpenChange } = setup({ open: false });
    expect(screen.queryByTestId('create-node-text')).toBeNull();
    await user.click(screen.getByTestId('selection-add-button'));
    expect(onOpenChange).toHaveBeenCalledWith(true);
  });

  it('lists the four types, a separator, then Add to Agent', () => {
    setup();
    const rows = Array.from(document.querySelectorAll('[role="menuitem"], [role="separator"]')).map((el) =>
      el.getAttribute('role') === 'separator' ? '---' : el.getAttribute('data-testid'),
    );
    expect([...rows.slice(0, 4)].sort()).toEqual(TYPES.map((t) => `create-node-${t}`).sort());
    expect(rows.slice(4)).toEqual(['---', 'selection-add-to-agent']);
    expect(screen.getByTestId('selection-add-to-agent')).toHaveTextContent('Add to Agent');
  });

  it('greys out only the types no selected node connects into', () => {
    // audio and video feed text, audio and video, but never an image node.
    setup({ sourceKinds: ['audio', 'video'] });
    expect(screen.getByTestId('create-node-image')).toHaveAttribute('data-disabled');
    expect(screen.getByTestId('create-node-image')).toHaveAttribute('aria-disabled', 'true');
    for (const type of ['text', 'audio', 'video']) {
      expect(screen.getByTestId(`create-node-${type}`)).not.toHaveAttribute('data-disabled');
    }
  });

  it('keeps a type available when any one selected node connects into it', () => {
    setup({ sourceKinds: ['audio', 'image'] });
    for (const type of TYPES) {
      expect(screen.getByTestId(`create-node-${type}`)).not.toHaveAttribute('data-disabled');
    }
  });

  it('greys out every type when no selected node connects into any', () => {
    setup({ sourceKinds: ['3d', 'web'] });
    for (const type of TYPES) {
      expect(screen.getByTestId(`create-node-${type}`)).toHaveAttribute('data-disabled');
    }
  });

  it('hands the picked type over', () => {
    const { onPick } = setup({ sourceKinds: ['audio'] });
    fireEvent.click(screen.getByTestId('create-node-video'));
    expect(onPick).toHaveBeenCalledTimes(1);
    expect(onPick).toHaveBeenCalledWith('video');
  });

  it('does nothing when a greyed-out type is clicked', () => {
    const { onPick } = setup({ sourceKinds: ['audio'] });
    fireEvent.click(screen.getByTestId('create-node-image'));
    expect(onPick).not.toHaveBeenCalled();
  });

  it('hands the selection to the Agent', () => {
    const { onAddToAgent } = setup();
    fireEvent.click(screen.getByTestId('selection-add-to-agent'));
    expect(onAddToAgent).toHaveBeenCalledTimes(1);
  });

  it('holds Add to Agent back while the chat is changing conversation', () => {
    const { onAddToAgent } = setup({ addToAgentDisabled: true });
    expect(screen.getByTestId('selection-add-to-agent')).toHaveAttribute('data-disabled');
    fireEvent.click(screen.getByTestId('selection-add-to-agent'));
    expect(onAddToAgent).not.toHaveBeenCalled();
  });
});
