// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

import { SelectionContextMenu } from '@web/spaces/canvas/SelectionContextMenu';

/**
 * Force a platform so the shortcut hints are deterministic.
 * @param value - The platform string to report.
 */
function setPlatform(value: string): void {
  Object.defineProperty(window.navigator, 'platform', {
    value,
    configurable: true,
  });
}

describe('SelectionContextMenu', () => {
  afterEach(() => setPlatform(''));

  it('shows group / copy / duplicate / delete when handlers are given', () => {
    render(
      <SelectionContextMenu
        open
        x={0}
        y={0}
        onOpenChange={() => {}}
        onGroup={() => {}}
        onCopy={() => {}}
        onDuplicate={() => {}}
        onDelete={() => {}}
      />,
    );
    expect(screen.getByTestId('selection-menu-group')).toBeInTheDocument();
    expect(screen.getByTestId('selection-menu-copy')).toBeInTheDocument();
    expect(screen.getByTestId('selection-menu-duplicate')).toBeInTheDocument();
    expect(screen.getByTestId('selection-menu-delete')).toBeInTheDocument();
  });

  it('delete item reads "Delete selection"', () => {
    render(
      <SelectionContextMenu
        open
        x={0}
        y={0}
        onOpenChange={() => {}}
        onDelete={() => {}}
      />,
    );
    expect(screen.getByTestId('selection-menu-delete')).toHaveTextContent(
      'Delete selection',
    );
  });

  it('fires the handlers on selection', () => {
    const onGroup = vi.fn();
    const onDelete = vi.fn();
    render(
      <SelectionContextMenu
        open
        x={0}
        y={0}
        onOpenChange={() => {}}
        onGroup={onGroup}
        onDelete={onDelete}
      />,
    );
    fireEvent.click(screen.getByTestId('selection-menu-group'));
    expect(onGroup).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTestId('selection-menu-delete'));
    expect(onDelete).toHaveBeenCalledTimes(1);
  });

  it('shows platform-aware shortcut hints (mac)', () => {
    setPlatform('MacIntel');
    render(
      <SelectionContextMenu
        open
        x={0}
        y={0}
        onOpenChange={() => {}}
        onGroup={() => {}}
        onDelete={() => {}}
      />,
    );
    expect(screen.getByTestId('selection-menu-group').textContent).toContain(
      '⌘G',
    );
    expect(screen.getByTestId('selection-menu-delete').textContent).toContain(
      '⌫',
    );
  });

  it('renders nothing when closed', () => {
    render(
      <SelectionContextMenu
        open={false}
        x={0}
        y={0}
        onOpenChange={() => {}}
        onGroup={() => {}}
      />,
    );
    expect(screen.queryByTestId('selection-menu-group')).toBeNull();
  });
});

describe('SelectionContextMenu — adding to the agent', () => {
  it('hands the selection to the agent when chosen', () => {
    const onAddToAgent = vi.fn();
    render(
      <SelectionContextMenu open x={0} y={0} onOpenChange={() => {}} onAddToAgent={onAddToAgent} />,
    );

    fireEvent.click(screen.getByTestId('selection-menu-add-to-agent'));

    expect(onAddToAgent).toHaveBeenCalledTimes(1);
  });

  it('is shown but not available while the chat is changing conversation', () => {
    render(
      <SelectionContextMenu
        open
        x={0}
        y={0}
        onOpenChange={() => {}}
        onAddToAgent={() => {}}
        addToAgentDisabled
      />,
    );

    expect(screen.getByTestId('selection-menu-add-to-agent')).toHaveAttribute('data-disabled');
  });

  it('sits right above delete, at the foot of the menu', () => {
    render(
      <SelectionContextMenu
        open
        x={0}
        y={0}
        onOpenChange={() => {}}
        onAddToAgent={() => {}}
        onGroup={() => {}}
        onCopy={() => {}}
        onDelete={() => {}}
      />,
    );
    const items = screen.getAllByRole('menuitem').map((el) => el.getAttribute('data-testid'));

    expect(items.slice(-2)).toEqual(['selection-menu-add-to-agent', 'selection-menu-delete']);
  });
});

