// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type * as React from 'react';

import { SpaceDrawer } from '@web/pages/project/chrome/tab-bar/SpaceDrawer';
import { useUIStore } from '@web/stores/ui';
import type { ProjectSpace } from '@web/data/yjs/project-meta';
import {
  expectChosenFill,
  expectHoverableSiblingFill,
} from '@web/test-utils/selection-fill';
import {
  expectGappedList,
  expectStandaloneRow,
} from '@web/test-utils/list-rows';


/**
 * Open a row's actions menu.
 * @param user - The user-event instance.
 * @param spaceId - The row's Space id.
 */
async function openRowMenu(
  user: ReturnType<typeof userEvent.setup>,
  spaceId: string,
): Promise<void> {
  await user.click(screen.getByTestId(`space-drawer-menu-${spaceId}`));
  await screen.findByRole('menu');
}

beforeEach(() => {
  // The drawer's open state goes through `useExclusiveOverlay`, which
  // reads the global `activeOverlayId`. Reset it so a sibling test's
  // leftover doesn't open/block this drawer.
  useUIStore.setState({ activeOverlayId: null });
});

const SPACE: ProjectSpace = {
  id: 'sp-1',
  name: 'Reel',
  type: 'canvas',
  locked: false,
};

// A second space so SPACE is not the only one — delete is enabled by default.
// Deleting the LAST space is gated (project keeps >=1), tested separately.
const SIBLING: ProjectSpace = {
  id: 'sp-2',
  name: 'Teaser',
  type: 'canvas',
  locked: false,
};

function setup(overrides: Partial<React.ComponentProps<typeof SpaceDrawer>> = {}) {
  const onDeleteSpace = vi.fn();
  render(
    <SpaceDrawer
      spaces={[SPACE, SIBLING]}
      openTabIds={[]}
      activeSpaceId=''
      projectId='proj-1'
      onActivate={vi.fn()}
      onView={vi.fn()}
      onDeleteSpace={onDeleteSpace}
      onSetSpaceLocked={vi.fn()}
      {...overrides}
    />,
  );
  return { onDeleteSpace };
}

describe('SpaceDrawer', () => {
  it('opens the drawer and lists every space', async () => {
    const user = userEvent.setup();
    setup();
    await user.click(screen.getByTestId('space-drawer-trigger'));
    expect(screen.getByTestId('space-drawer')).toBeInTheDocument();
    expect(screen.getByTestId('space-drawer-row-sp-1')).toBeInTheDocument();
  });

  it('opens the delete-confirm AlertDialog from the row menu', async () => {
    const user = userEvent.setup();
    setup();
    await user.click(screen.getByTestId('space-drawer-trigger'));
    await openRowMenu(user, 'sp-1');
    await user.click(screen.getByTestId('space-drawer-delete-sp-1'));
    expect(
      await screen.findByTestId('space-drawer-delete-confirm-sp-1'),
    ).toBeInTheDocument();
  });

  it('puts view, lock and delete in the row menu', async () => {
    const user = userEvent.setup();
    setup();
    await user.click(screen.getByTestId('space-drawer-trigger'));
    await openRowMenu(user, 'sp-1');
    const items = screen.getAllByRole('menuitem').map((item) => item.textContent);
    expect(items).toEqual(['View', 'Lock', 'Delete']);
  });

  it('views the Space from the row menu', async () => {
    const user = userEvent.setup();
    const onView = vi.fn();
    setup({ onView });
    await user.click(screen.getByTestId('space-drawer-trigger'));
    await openRowMenu(user, 'sp-1');
    await user.click(screen.getByTestId('space-drawer-view-sp-1'));
    expect(onView).toHaveBeenCalledWith('sp-1');
  });

  it('locks an unlocked Space and offers Unlock on a locked one', async () => {
    const user = userEvent.setup();
    const onSetSpaceLocked = vi.fn();
    setup({ spaces: [SPACE, { ...SIBLING, locked: true }], onSetSpaceLocked });
    await user.click(screen.getByTestId('space-drawer-trigger'));
    await openRowMenu(user, 'sp-1');
    await user.click(screen.getByTestId('space-drawer-lock-sp-1'));
    expect(onSetSpaceLocked).toHaveBeenCalledWith('sp-1', true);
    await openRowMenu(user, 'sp-2');
    expect(screen.getByTestId('space-drawer-lock-sp-2')).toHaveTextContent('Unlock');
  });

  it('renders the row menu outside the scrolling list', async () => {
    const user = userEvent.setup();
    setup();
    await user.click(screen.getByTestId('space-drawer-trigger'));
    await openRowMenu(user, 'sp-1');
    const viewport = screen
      .getByTestId('space-drawer-list')
      .closest('[data-radix-scroll-area-viewport]');
    expect(viewport).not.toBeNull();
    expect(viewport?.contains(screen.getByRole('menu'))).toBe(false);
  });

  it('a locked Space offers delete greyed, says why, and opens no AlertDialog', async () => {
    const user = userEvent.setup();
    // Two spaces so the disabled state is due to LOCK, not last-space.
    setup({ spaces: [{ ...SPACE, locked: true }, SIBLING] });
    await user.click(screen.getByTestId('space-drawer-trigger'));
    await openRowMenu(user, 'sp-1');
    const item = screen.getByTestId('space-drawer-delete-sp-1');
    expect(item).toHaveAttribute('data-disabled');
    expect(item).toHaveTextContent('Locked spaces can\'t be deleted');
    await user.click(item);
    expect(
      screen.queryByTestId('space-drawer-delete-confirm-sp-1'),
    ).not.toBeInTheDocument();
  });

  it('the LAST remaining space offers delete greyed and says why (project keeps >=1)', async () => {
    const user = userEvent.setup();
    setup({ spaces: [SPACE] });
    await user.click(screen.getByTestId('space-drawer-trigger'));
    await openRowMenu(user, 'sp-1');
    const item = screen.getByTestId('space-drawer-delete-sp-1');
    expect(item).toHaveAttribute('data-disabled');
    expect(item).toHaveTextContent('A Project must keep at least one Space');
    await user.click(item);
    expect(
      screen.queryByTestId('space-drawer-delete-confirm-sp-1'),
    ).not.toBeInTheDocument();
  });

  it('opens as a modal sheet with a backdrop overlay, like dialogs', async () => {
    // User decision 2026-07-04: now that focus is managed as modal
    // (delete-confirm returns focus to the drawer), the visuals must
    // match — the chrome sheets show the same backdrop as dialogs.
    const user = userEvent.setup();
    setup();
    await user.click(screen.getByTestId('space-drawer-trigger'));
    expect(screen.getByTestId('sheet-overlay')).toBeInTheDocument();
  });

  it('fills the row you are on past the fill its siblings take under the pointer', async () => {
    // tokens.css semantics: --color-muted is a RECESS fill (avatar bg / track /
    // disabled) that sits below the card surface — using it on the selected row
    // made it darker than its siblings (user report 2026-07-04).
    const user = userEvent.setup();
    setup({ activeSpaceId: 'sp-1' });
    await user.click(screen.getByTestId('space-drawer-trigger'));
    const row = screen.getByTestId('space-drawer-row-sp-1');
    expectChosenFill(row);
    expect(row.className).not.toContain('bg-muted');
    expectHoverableSiblingFill(screen.getByTestId('space-drawer-row-sp-2'));
  });

  it('#1539: closing the delete-confirm dialog returns focus to the drawer, not <body>', async () => {
    const user = userEvent.setup();
    setup();
    await user.click(screen.getByTestId('space-drawer-trigger'));
    await openRowMenu(user, 'sp-1');
    await user.click(screen.getByTestId('space-drawer-delete-sp-1'));
    await screen.findByTestId('space-drawer-delete-confirm-sp-1');
    await user.click(screen.getAllByRole('button', { name: 'Cancel' })[0]);
    // Radix's default return target is the hover-revealed row trigger, which
    // fails here (modal dialog inside a non-modal sheet) and drops focus on
    // <body> - a keyboard user loses their place. The drawer panel must
    // reclaim focus so Tab continues inside the work surface.
    const drawer = screen.getByTestId('space-drawer');
    expect(document.body).not.toBe(document.activeElement);
    expect(drawer.contains(document.activeElement)).toBe(true);
  });

  it('lists the newest Space first, the order a project opens on', async () => {
    // The drawer is the way to every Space the strip does not carry, and a
    // project opens on its newest one. Listing in the order Yjs happens to
    // iterate put that Space anywhere, most often last (user 2026-09-12).
    const user = userEvent.setup();
    setup({
      spaces: [
        { ...SPACE, id: 'old', name: 'Old', createdAt: 1_000 },
        { ...SPACE, id: 'newest', name: 'Newest', createdAt: 3_000 },
        { ...SPACE, id: 'middle', name: 'Middle', createdAt: 2_000 },
      ],
    });
    await user.click(screen.getByTestId('space-drawer-trigger'));
    const names = screen
      .getAllByTestId(/^space-drawer-row-/)
      .map((row) => row.getAttribute('data-testid'));
    expect(names).toEqual([
      'space-drawer-row-newest',
      'space-drawer-row-middle',
      'space-drawer-row-old',
    ]);
  });

  it('the trigger says how many Spaces are behind it', () => {
    // Arriving at a project shows one tab whatever the project holds, so the
    // strip alone cannot say whether there is anything else (user 2026-09-12).
    setup();
    expect(screen.getByTestId('space-drawer-trigger')).toHaveTextContent('2');
  });

  it('a row second line says when the Space was made', async () => {
    // The type word the second line used to carry is what the icon beside it
    // already draws, so two Spaces of the same type read identically once
    // their names truncate.
    const user = userEvent.setup();
    setup({
      spaces: [
        { ...SPACE, createdAt: Date.now() - 2 * 60 * 60 * 1000 },
        SIBLING,
      ],
    });
    await user.click(screen.getByTestId('space-drawer-trigger'));
    expect(screen.getByTestId('space-drawer-row-sp-1')).toHaveTextContent(
      '2 hours ago',
    );
  });

  it('draws each row as its own block, with no rule between them', async () => {
    const user = userEvent.setup();
    setup();
    await user.click(screen.getByTestId('space-drawer-trigger'));
    expectGappedList(screen.getByTestId('space-drawer-list'));
    expectStandaloneRow(screen.getByTestId('space-drawer-row-sp-1'));
    expectStandaloneRow(screen.getByTestId('space-drawer-row-sp-2'));
  });

  it('keeps room on the row for the menu button so the name never runs under it', async () => {
    const user = userEvent.setup();
    setup();
    await user.click(screen.getByTestId('space-drawer-trigger'));
    expect(
      screen.getByTestId('space-drawer-actions-sp-1').className,
    ).toMatch(/(^|\s)absolute(\s|$)/);
    expect(
      screen.getByRole('button', { name: 'Open Reel' }).className,
    ).toMatch(/(^|\s)pr-12(\s|$)/);
  });
});
