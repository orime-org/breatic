// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

import { GroupNode } from '@web/spaces/canvas/nodes/GroupNode';

describe('GroupNode', () => {
  it('renders the group container', () => {
    render(<GroupNode data={{ kind: 'group', childIds: ['a', 'b'] }} />);
    expect(screen.getByTestId('group-node')).toBeInTheDocument();
  });

  it('shows a lock indicator when the group is locked', () => {
    render(
      <GroupNode data={{ kind: 'group', childIds: ['a'], locked: true }} />,
    );
    expect(screen.getByTestId('group-lock-indicator')).toBeInTheDocument();
  });

  it('shows no lock indicator when the group is unlocked', () => {
    render(<GroupNode data={{ kind: 'group', childIds: ['a'] }} />);
    expect(
      screen.queryByTestId('group-lock-indicator'),
    ).not.toBeInTheDocument();
  });

  it('applies the backgroundColor tint via var() from the stored token', () => {
    render(
      <GroupNode
        data={{ kind: 'group', backgroundColor: '--color-status-info-bg' }}
      />,
    );
    expect(screen.getByTestId('group-node')).toHaveStyle({
      backgroundColor: 'var(--color-status-info-bg)',
    });
  });

  it('uses the node-shell border treatment — dashed line, 6px radius, fills the wrapper, 3-state colors', () => {
    const { rerender } = render(
      <GroupNode data={{ kind: 'group', childIds: ['a'] }} />,
    );
    const node = screen.getByTestId('group-node');
    // Node radius (6px) + fills the ReactFlow wrapper + keeps the dashed line.
    expect(node).toHaveClass('rounded-sm', 'size-full', 'border-dashed');
    expect(node).not.toHaveClass('rounded-lg');
    // Idle uses the node's border colour + hover, exactly like NodeShell.
    expect(node).toHaveClass(
      'border-border',
      'hover:border-foreground-disabled',
    );
    // Selected uses the node's selected colour.
    rerender(<GroupNode data={{ kind: 'group', childIds: ['a'] }} selected />);
    expect(screen.getByTestId('group-node')).toHaveClass(
      'border-status-selected',
    );
  });

  it('renders no content-node lock badge — the group shows its own group-lock-indicator', () => {
    render(<GroupNode data={{ kind: 'group', childIds: ['a'] }} locked />);
    expect(screen.queryByTestId('node-lock-indicator')).toBeNull();
  });

  it('renders the group name header, defaulting to "Group"', () => {
    render(<GroupNode data={{ kind: 'group', childIds: ['a'] }} />);
    expect(screen.getByTestId('group-name')).toHaveTextContent('Group');
  });

  it('shows a custom group name in the header', () => {
    render(
      <GroupNode data={{ kind: 'group', name: 'My Group', childIds: ['a'] }} />,
    );
    expect(screen.getByTestId('group-name')).toHaveTextContent('My Group');
  });

  it('enters edit mode when the name is double-clicked', () => {
    render(
      <GroupNode data={{ kind: 'group', childIds: ['a'] }} onRename={vi.fn()} />,
    );
    fireEvent.doubleClick(screen.getByTestId('group-name'));
    expect(screen.getByTestId('group-name-input')).toBeInTheDocument();
  });

  it('does NOT enter edit mode when a locked group name is double-clicked', () => {
    render(
      <GroupNode
        data={{ kind: 'group', childIds: ['a'], locked: true }}
        onRename={vi.fn()}
      />,
    );
    // Group lock now gates rename (decision 2026-06-20): a locked group's name
    // is frozen like its structure — double-click must NOT open the editor.
    fireEvent.doubleClick(screen.getByTestId('group-name'));
    expect(screen.queryByTestId('group-name-input')).toBeNull();
  });

  it('commits the new name on Enter', () => {
    const onRename = vi.fn();
    render(
      <GroupNode
        data={{ kind: 'group', name: 'Group', childIds: ['a'] }}
        onRename={onRename}
      />,
    );
    fireEvent.doubleClick(screen.getByTestId('group-name'));
    const input = screen.getByTestId('group-name-input');
    fireEvent.change(input, { target: { value: 'Scenes' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onRename).toHaveBeenCalledExactlyOnceWith('Scenes');
  });

  it('cancels on Escape without renaming', () => {
    const onRename = vi.fn();
    render(
      <GroupNode
        data={{ kind: 'group', name: 'Group', childIds: ['a'] }}
        onRename={onRename}
      />,
    );
    fireEvent.doubleClick(screen.getByTestId('group-name'));
    const input = screen.getByTestId('group-name-input');
    fireEvent.change(input, { target: { value: 'Scenes' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(onRename).not.toHaveBeenCalled();
    expect(screen.queryByTestId('group-name-input')).toBeNull();
  });
});
