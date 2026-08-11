// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

import { RailCreateActions } from '@web/pages/studio/rail/RailCreateActions';
import { RailRecentLink } from '@web/pages/studio/rail/RailRecentLink';
import { RAIL_LIST, RAIL_ROW_TOP } from '@web/pages/studio/rail/rail-row';

describe('RailCreateActions (spec §4.1 ①②)', () => {
  it('fires onCreateProject when create-project is clicked', () => {
    const onCreateProject = vi.fn();
    render(
      <RailCreateActions
        createProjectLabel='New project'
        createCollectionLabel='New collection'
        comingSoonLabel='Coming soon'
        onCreateProject={onCreateProject}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'New project' }));
    expect(onCreateProject).toHaveBeenCalledTimes(1);
  });

  it('renders create-collection as a disabled placeholder (backend deferred)', () => {
    render(
      <RailCreateActions
        createProjectLabel='New project'
        createCollectionLabel='New collection'
        comingSoonLabel='Coming soon'
        onCreateProject={vi.fn()}
      />,
    );

    // Disabled through the HTML attribute — never `pointer-events: none`,
    // which would swallow the hover that explains why it cannot be used.
    const collection = screen.getByRole('button', { name: 'New collection' });
    expect(collection).toBeDisabled();
    expect(collection.className).toContain('cursor-not-allowed');
    expect(screen.getByRole('button', { name: 'New project' })).toBeEnabled();
  });

  it('does not answer the pointer at all on the disabled action', () => {
    // `group` is what lets a row's icon come up under the pointer, so a row
    // that cannot be used must not carry it. It kept `cursor-not-allowed`
    // rather than `pointer-events: none` precisely so the hover still explains
    // itself — that hover must not then light the icon brighter than the label
    // it sits next to.
    render(
      <RailCreateActions
        createProjectLabel='New project'
        createCollectionLabel='New collection'
        comingSoonLabel='Coming soon'
        onCreateProject={vi.fn()}
      />,
    );
    const collection = screen.getByRole('button', { name: 'New collection' });
    expect(collection.className).not.toMatch(/(^|\s)group(\s|$)/);
    expect(screen.getByRole('button', { name: 'New project' }).className).toMatch(
      /(^|\s)group(\s|$)/,
    );
  });

  it('dims the disabled action to its own value, not the primitive’s', () => {
    // The row definition says how a row reads when it cannot be used, so that
    // value has to be the one that lands. Written without the `disabled:`
    // prefix it never did: a plain class loses on specificity to the `Button`
    // base's `disabled:opacity-50` (a class against a class plus a
    // pseudo-class), and twMerge leaves both standing because the modifiers
    // differ. Named the same way, twMerge drops the primitive's and the row's
    // own value renders. (Prose here is scanned by Tailwind too — a class name
    // written only in a comment still ships a rule nothing uses.)
    render(
      <RailCreateActions
        createProjectLabel='New project'
        createCollectionLabel='New collection'
        comingSoonLabel='Coming soon'
        onCreateProject={vi.fn()}
      />,
    );
    const collection = screen.getByRole('button', { name: 'New collection' });
    expect(collection.className).toContain('disabled:opacity-65');
    expect(collection.className).not.toContain('disabled:opacity-50');
  });

  it('no longer carries the create-studio action (it lives in the rail footer)', () => {
    render(
      <RailCreateActions
        createProjectLabel='New project'
        createCollectionLabel='New collection'
        comingSoonLabel='Coming soon'
        onCreateProject={vi.fn()}
      />,
    );
    expect(screen.getAllByRole('button')).toHaveLength(2);
  });

  it('draws no separator of its own', () => {
    const { container } = render(
      <RailCreateActions
        createProjectLabel='New project'
        createCollectionLabel='New collection'
        comingSoonLabel='Coming soon'
        onCreateProject={vi.fn()}
      />,
    );
    expect(container.querySelectorAll('hr')).toHaveLength(0);
  });

  it('stacks its actions with the one list definition', () => {
    const { container } = render(
      <RailCreateActions
        createProjectLabel='New project'
        createCollectionLabel='New collection'
        comingSoonLabel='Coming soon'
        onCreateProject={vi.fn()}
      />,
    );
    expect(container.firstElementChild?.className).toContain(RAIL_LIST);
  });

  it('builds both actions from the one top-level row definition', () => {
    render(
      <RailCreateActions
        createProjectLabel='New project'
        createCollectionLabel='New collection'
        comingSoonLabel='Coming soon'
        onCreateProject={vi.fn()}
      />,
    );
    for (const name of ['New project', 'New collection']) {
      expect(screen.getByRole('button', { name }).className).toContain(RAIL_ROW_TOP);
    }
  });
});

describe('RailRecentLink (spec §4.1 ③)', () => {
  it('links to /studio and highlights when active', () => {
    render(
      <MemoryRouter>
        <RailRecentLink label='Recent' active />
      </MemoryRouter>,
    );

    const link = screen.getByRole('link', { name: /Recent/ });
    expect(link).toHaveAttribute('href', '/studio');
    expect(link).toHaveAttribute('aria-current', 'page');
  });

  it('does not mark aria-current when not active', () => {
    render(
      <MemoryRouter>
        <RailRecentLink label='Recent' active={false} />
      </MemoryRouter>,
    );
    expect(screen.getByRole('link', { name: /Recent/ })).not.toHaveAttribute(
      'aria-current',
    );
  });

  it('answers the keyboard with the same ring the buttons show', () => {
    // A rail row is reached by tab as often as by pointer, and half these rows
    // are links while half are buttons. With the ring left to the `Button`
    // primitive, only the buttons had one and the links fell back to whatever
    // ring the browser draws — so the focus you see moving down the rail
    // changed shape halfway. The definition owns it, so every row shows one.
    render(
      <MemoryRouter>
        <RailRecentLink label='Recent' active={false} />
      </MemoryRouter>,
    );
    const link = screen.getByRole('link', { name: /Recent/ });
    expect(link.className).toContain('focus-visible:ring-1');
    expect(link.className).toContain('focus-visible:ring-ring');
    expect(link.className).toContain('focus-visible:outline-none');
  });

  it('brightens its icon on the page you are on, not only under the pointer', () => {
    // Icons come up under the pointer, so the row you are actually on has to
    // read at least as bright — otherwise hovering a row you are not on lights
    // it more than the one you are. Three things have to line up on the
    // rendered row, and none of them is visible in the icon's class list on its
    // own: the row carries `group`, the row is the one marked aria-current, and
    // the icon carries the variant keyed to both.
    render(
      <MemoryRouter>
        <RailRecentLink label='Recent' active />
      </MemoryRouter>,
    );
    const link = screen.getByRole('link', { name: /Recent/ });
    expect(link.className).toMatch(/(^|\s)group(\s|$)/);
    expect(link).toHaveAttribute('aria-current', 'page');
    expect(link.querySelector('svg')?.getAttribute('class')).toContain(
      'group-aria-[current=page]:text-foreground',
    );
  });

  it('is a top-level rail row, from the one definition', () => {
    render(
      <MemoryRouter>
        <RailRecentLink label='Recent' active={false} />
      </MemoryRouter>,
    );
    expect(screen.getByRole('link', { name: /Recent/ }).className).toContain(
      RAIL_ROW_TOP,
    );
  });
});
