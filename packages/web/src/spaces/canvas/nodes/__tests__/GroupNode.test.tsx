// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

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
});
