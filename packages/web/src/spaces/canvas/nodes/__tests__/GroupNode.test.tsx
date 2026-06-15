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

  it('shows the lock indicator when locked', () => {
    render(<GroupNode data={{ kind: 'group' }} locked />);
    expect(screen.getByTestId('node-lock-indicator')).toBeInTheDocument();
  });
});
