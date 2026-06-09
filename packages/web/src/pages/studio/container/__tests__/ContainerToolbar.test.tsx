// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

import { ContainerToolbar } from '@web/pages/studio/container/ContainerToolbar';

describe('ContainerToolbar', () => {
  it('draws NO bottom border — the tab strip already owns the divider (neutral mock §toolbar)', () => {
    render(
      <ContainerToolbar title='Projects' count={3} createLabel='New project' />,
    );
    // The neutral-direction mock removed the toolbar's own border-bottom because
    // it doubled the tab strip's line right above it. Locking that in: the
    // toolbar container must carry no bottom-border utility.
    const bar = screen.getByTestId('container-toolbar');
    expect(bar.className).not.toContain('border-b');
  });

  it('shows the sort placeholder by default (Projects tab): sort + create = 2 buttons', () => {
    render(
      <ContainerToolbar
        title='Projects'
        count={3}
        createLabel='New project'
        onCreate={() => {}}
      />,
    );
    // The disabled sort placeholder is a <button>; the grid/list toggle is
    // spans (not buttons). So default = sort + create = 2 buttons.
    expect(screen.getAllByRole('button')).toHaveLength(2);
  });

  it('hides sort + view placeholders when showViewControls=false (Members tab)', () => {
    render(
      <ContainerToolbar
        title='Members'
        count={2}
        createLabel='Invite'
        onCreate={() => {}}
        showViewControls={false}
      />,
    );
    // Only the create button remains — the sort placeholder is gone.
    const buttons = screen.getAllByRole('button');
    expect(buttons).toHaveLength(1);
    expect(buttons[0]).toHaveAccessibleName(/Invite/);
    // Title + count chip still render.
    expect(screen.getByText('Members')).toBeInTheDocument();
    expect(screen.getByText('2')).toBeInTheDocument();
  });

  it('hides the create button when onCreate is omitted (guest / personal studio)', () => {
    render(
      <ContainerToolbar
        title='Members'
        count={1}
        createLabel='Invite'
        showViewControls={false}
      />,
    );
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.getByText('Members')).toBeInTheDocument();
  });
});
