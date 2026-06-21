// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

import { GroupSelectionToolbar } from '@web/spaces/canvas/GroupSelectionToolbar';

const baseProps = {
  onGroup: () => {},
  onUngroup: () => {},
  bgOpen: false,
  onBgOpenChange: () => {},
  bgValue: undefined,
  onPickBg: () => {},
};

describe('GroupSelectionToolbar', () => {
  it('offer=group: shows the Group button, not Ungroup', () => {
    render(<GroupSelectionToolbar {...baseProps} offer='group' />);
    expect(screen.getByTestId('group-toolbar-group')).toBeInTheDocument();
    expect(screen.queryByTestId('group-toolbar-ungroup')).toBeNull();
  });

  it('offer=ungroup: shows the Ungroup button', () => {
    render(<GroupSelectionToolbar {...baseProps} offer='ungroup' />);
    expect(screen.getByTestId('group-toolbar-ungroup')).toBeInTheDocument();
    expect(screen.queryByTestId('group-toolbar-group')).toBeNull();
  });

  it('clicking Group / Ungroup calls the handler', () => {
    const onGroup = vi.fn();
    const { unmount } = render(
      <GroupSelectionToolbar {...baseProps} offer='group' onGroup={onGroup} />,
    );
    fireEvent.click(screen.getByTestId('group-toolbar-group'));
    expect(onGroup).toHaveBeenCalledTimes(1);
    unmount();
    const onUngroup = vi.fn();
    render(
      <GroupSelectionToolbar
        {...baseProps}
        offer='ungroup'
        onUngroup={onUngroup}
      />,
    );
    fireEvent.click(screen.getByTestId('group-toolbar-ungroup'));
    expect(onUngroup).toHaveBeenCalledTimes(1);
  });

  // #1450: the toolbar is portaled by ReactFlow's NodeToolbar OUTSIDE the canvas
  // node, escaping its user-select:none — so its chrome must carry `select-none`,
  // or a stray marquee/drag selects the button label text (reads as "selected").
  it('carries select-none so its label text cannot be drag-selected', () => {
    render(<GroupSelectionToolbar {...baseProps} offer='ungroup' />);
    expect(screen.getByTestId('group-selection-toolbar').className).toContain(
      'select-none',
    );
  });
});
