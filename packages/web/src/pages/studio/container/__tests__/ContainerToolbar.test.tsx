// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { expectChosenFill, expectHoverableSiblingFill } from '@web/test-utils/selection-fill';
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

  it('offers the given sorts, marks the current one, and reports a new choice', async () => {
    const onChange = vi.fn();
    render(
      <ContainerToolbar
        title='Projects'
        count={3}
        sort={{ value: 'opened', options: ['opened', 'edited', 'name', 'created'], onChange }}
      />,
    );
    const trigger = screen.getByRole('button', { name: /Sort/ });
    expect(trigger).toHaveTextContent('Last opened');

    await userEvent.click(trigger);
    const items = await screen.findAllByTestId(/^container-sort-option-/);
    expect(items.map((i) => i.textContent)).toEqual(['Last opened', 'Last edited', 'Name', 'Created']);
    // Same chosen fill as the language and theme menus, no radio dot.
    expectChosenFill(items[0]!);
    for (const sibling of items.slice(1)) expectHoverableSiblingFill(sibling);
    expect(items[0]!.querySelector('svg')).toBeNull();

    await userEvent.click(items[2]!);
    expect(onChange).toHaveBeenCalledWith('name');
    expect(screen.queryByTestId('container-sort-option-name')).not.toBeInTheDocument();
  });

  it('switches between grid and list and shows which one is on', async () => {
    const onChange = vi.fn();
    render(<ContainerToolbar title='Projects' count={3} view={{ value: 'grid', onChange }} />);
    const grid = screen.getByRole('button', { name: 'Grid view' });
    const list = screen.getByRole('button', { name: 'List view' });
    expect(grid).toHaveAttribute('aria-pressed', 'true');
    expect(list).toHaveAttribute('aria-pressed', 'false');

    await userEvent.click(list);
    expect(onChange).toHaveBeenCalledWith('list');
  });

  it('shows no count while the list has not loaded', () => {
    render(<ContainerToolbar title='Projects' count={null} />);
    expect(screen.queryByTestId('container-toolbar-count')).not.toBeInTheDocument();
  });
});
