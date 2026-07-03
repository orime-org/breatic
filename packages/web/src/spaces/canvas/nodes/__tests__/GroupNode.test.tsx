// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

import { GroupNode } from '@web/spaces/canvas/nodes/GroupNode';

describe('GroupNode', () => {
  it('renders the group container', () => {
    render(<GroupNode data={{ kind: 'group' }} />);
    expect(screen.getByTestId('group-node')).toBeInTheDocument();
  });

  it('shows a lock indicator when the group is locked', () => {
    render(
      <GroupNode data={{ kind: 'group', locked: true }} />,
    );
    expect(screen.getByTestId('group-lock-indicator')).toBeInTheDocument();
  });

  it('shows no lock indicator when the group is unlocked', () => {
    render(<GroupNode data={{ kind: 'group' }} />);
    expect(
      screen.queryByTestId('group-lock-indicator'),
    ).not.toBeInTheDocument();
  });

  it('applies the backgroundColor tint via var(), normalizing legacy stored tokens (#1549)', () => {
    render(
      <GroupNode
        data={{ kind: 'group', backgroundColor: '--color-status-info-bg' }}
      />,
    );
    expect(screen.getByTestId('group-node')).toHaveStyle({
      backgroundColor: 'var(--color-palette-blue-bg)',
    });
  });

  it('gives a tinted group the matching 40% palette border (#1549 dark-mode anchor)', () => {
    render(
      <GroupNode
        data={{ kind: 'group', backgroundColor: '--color-palette-teal-bg' }}
      />,
    );
    const node = screen.getByTestId('group-node');
    // Color travels via a local CSS variable + a static class (an inline
    // border-color shorthand with var() is dropped by jsdom's cssstyle).
    expect(node.style.getPropertyValue('--group-tint-border')).toBe(
      'var(--color-palette-teal-border)',
    );
    expect(node).toHaveClass('border-[color:var(--group-tint-border)]');
  });

  it('keeps the neutral dashed border for untinted groups', () => {
    render(<GroupNode data={{ kind: 'group' }} />);
    const node = screen.getByTestId('group-node');
    expect(node).toHaveClass('border-border');
    expect(node.style.getPropertyValue('--group-tint-border')).toBe('');
  });

  it('lets the selected class win: no tint border override while selected', () => {
    render(
      <GroupNode
        data={{ kind: 'group', backgroundColor: '--color-palette-teal-bg' }}
        selected
      />,
    );
    const node = screen.getByTestId('group-node');
    expect(node).toHaveClass('border-status-selected');
    expect(node.className).not.toContain('--group-tint-border');
  });

  it('uses the node-shell border treatment — dashed line, 6px radius, fills the wrapper, 3-state colors', () => {
    const { rerender } = render(
      <GroupNode data={{ kind: 'group' }} />,
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
    rerender(<GroupNode data={{ kind: 'group' }} selected />);
    expect(screen.getByTestId('group-node')).toHaveClass(
      'border-status-selected',
    );
  });

  it('renders no content-node lock badge — the group shows its own group-lock-indicator', () => {
    render(<GroupNode data={{ kind: 'group' }} locked />);
    expect(screen.queryByTestId('node-lock-indicator')).toBeNull();
  });

  it('renders the group name header, defaulting to "Group"', () => {
    render(<GroupNode data={{ kind: 'group' }} />);
    expect(screen.getByTestId('group-name')).toHaveTextContent('Group');
  });

  it('shows a custom group name in the header', () => {
    render(
      <GroupNode data={{ kind: 'group', name: 'My Group' }} />,
    );
    expect(screen.getByTestId('group-name')).toHaveTextContent('My Group');
  });

  it('enters edit mode when the name is double-clicked', () => {
    render(
      <GroupNode data={{ kind: 'group' }} onRename={vi.fn()} />,
    );
    fireEvent.doubleClick(screen.getByTestId('group-name'));
    expect(screen.getByTestId('group-name-input')).toBeInTheDocument();
  });

  it('does NOT enter edit mode when a locked group name is double-clicked', () => {
    render(
      <GroupNode
        data={{ kind: 'group', locked: true }}
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
        data={{ kind: 'group', name: 'Group' }}
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
        data={{ kind: 'group', name: 'Group' }}
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

  // #1449: the group name deepens/brightens with selection — the same rule as
  // node names — so the active group reads at a glance when its dashed selection
  // border is zoom-thinned. Selected → text-foreground; unselected →
  // text-muted-foreground.
  it('unselected: the group name uses the muted foreground colour', () => {
    render(<GroupNode data={{ kind: 'group' }} />);
    const name = screen.getByTestId('group-name');
    expect(name).toHaveClass('text-muted-foreground');
    expect(name).not.toHaveClass('text-foreground');
  });

  it('selected: the group name uses the strong foreground colour', () => {
    render(<GroupNode data={{ kind: 'group' }} selected />);
    const name = screen.getByTestId('group-name');
    expect(name).toHaveClass('text-foreground');
    expect(name).not.toHaveClass('text-muted-foreground');
  });
});
