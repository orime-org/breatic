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

  it('applies the backgroundColor tint', () => {
    render(
      <GroupNode
        data={{ kind: 'group', backgroundColor: 'rgb(238, 238, 255)' }}
      />,
    );
    expect(screen.getByTestId('group-node')).toHaveStyle({
      backgroundColor: 'rgb(238, 238, 255)',
    });
  });

  it('does not render a lock indicator — a group has no lock (§1.1)', () => {
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
