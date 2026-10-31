// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type * as React from 'react';

import { SPACE_NAME_MAX_LEN } from '@breatic/shared';

import { SpaceDrawer } from '@web/pages/project/chrome/tab-bar/SpaceDrawer';
import { toast } from '@web/lib/toast';
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
      activeSpaceId=''
      projectId='proj-1'
      onActivate={vi.fn()}
      onDeleteSpace={onDeleteSpace}
      onRenameSpace={vi.fn()}
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

  /**
   * Open the delete question for `sp-1` and press its delete.
   * @param user - The user-event instance.
   * @returns The confirm button, pressed.
   */
  async function confirmDeletingFirstSpace(
    user: ReturnType<typeof userEvent.setup>,
  ): Promise<HTMLElement> {
    await user.click(screen.getByTestId('space-drawer-trigger'));
    await openRowMenu(user, 'sp-1');
    await user.click(screen.getByTestId('space-drawer-delete-sp-1'));
    const confirm = await screen.findByTestId('space-drawer-delete-confirm-action-sp-1');
    await user.click(confirm);
    return confirm;
  }

  it('keeps the delete question open and spinning while the RPC runs, and closes on success', async () => {
    const user = userEvent.setup();
    let done: () => void = () => undefined;
    const onDeleteSpace = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          done = resolve;
        }),
    );
    setup({ onDeleteSpace });

    const confirm = await confirmDeletingFirstSpace(user);

    expect(onDeleteSpace).toHaveBeenCalledWith('sp-1');
    expect(screen.getByTestId('space-drawer-delete-confirm-sp-1')).toBeInTheDocument();
    expect(confirm).toHaveAttribute('aria-busy', 'true');
    expect(confirm).toHaveAttribute('aria-disabled', 'true');

    await act(async () => {
      done();
    });
    expect(screen.queryByTestId('space-drawer-delete-confirm-sp-1')).toBeNull();
  });

  it('keeps the delete question open after a failed RPC, so it can be pressed again', async () => {
    const user = userEvent.setup();
    let fail: (err: Error) => void = () => undefined;
    const onDeleteSpace = vi.fn(
      () =>
        new Promise<void>((_resolve, reject) => {
          fail = reject;
        }),
    );
    setup({ onDeleteSpace });

    const confirm = await confirmDeletingFirstSpace(user);
    expect(confirm).toHaveAttribute('aria-busy', 'true');

    await act(async () => {
      fail(new Error('refused'));
    });
    expect(screen.getByTestId('space-drawer-delete-confirm-sp-1')).toBeInTheDocument();
    expect(confirm).not.toHaveAttribute('aria-busy');
  });

  it('puts view, rename, lock and delete in the row menu', async () => {
    const user = userEvent.setup();
    setup();
    await user.click(screen.getByTestId('space-drawer-trigger'));
    await openRowMenu(user, 'sp-1');
    const items = screen.getAllByRole('menuitem').map((item) => item.textContent);
    expect(items).toEqual(['View', 'Rename', 'Lock', 'Delete']);
    // Delete is red, as every delete is (docs/ARCHITECTURE.md, design tokens).
    expect(screen.getByTestId('space-drawer-delete-sp-1').className).toContain(
      'text-status-error-foreground',
    );
    expect(screen.getByTestId('space-drawer-lock-sp-1').className).not.toContain(
      'text-status-error-foreground',
    );
  });

  it('View opens the Space as a tab, as pressing its row does', async () => {
    const user = userEvent.setup();
    const onActivate = vi.fn();
    setup({ onActivate });
    await user.click(screen.getByTestId('space-drawer-trigger'));
    await openRowMenu(user, 'sp-1');
    await user.click(screen.getByTestId('space-drawer-view-sp-1'));
    expect(onActivate).toHaveBeenCalledWith('sp-1');
    expect(screen.queryByTestId('space-drawer')).toBeNull();
  });

  it('offers no Rename when the drawer is given no rename handler', async () => {
    // A viewer gets no handler, as on the tab strip.
    const user = userEvent.setup();
    setup({ onRenameSpace: undefined });
    await user.click(screen.getByTestId('space-drawer-trigger'));
    await openRowMenu(user, 'sp-1');
    const items = screen.getAllByRole('menuitem').map((item) => item.textContent);
    expect(items).toEqual(['View', 'Lock', 'Delete']);
  });

  it('leaves the failure notice of a lock toggle to the RPC layer', async () => {
    const user = userEvent.setup();
    const errorSpy = vi.spyOn(toast, 'error');
    const onSetSpaceLocked = vi.fn(() => Promise.reject(new Error('Space sp-1 not found')));
    setup({ spaces: [SPACE, SIBLING], onSetSpaceLocked });
    await user.click(screen.getByTestId('space-drawer-trigger'));
    await openRowMenu(user, 'sp-1');
    await user.click(screen.getByTestId('space-drawer-lock-sp-1'));
    await act(async () => {
      await Promise.resolve();
    });
    expect(onSetSpaceLocked).toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
    errorSpy.mockRestore();
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
    // Greyed, not red: the action is not on offer.
    expect(item.className).not.toContain('text-status-error-foreground');
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

  /**
   * Choose Rename on `spaceId`'s row and return the box it opens.
   * @param user - The user-event instance.
   * @param spaceId - The row's Space id.
   * @returns The rename box.
   */
  async function startRename(
    user: ReturnType<typeof userEvent.setup>,
    spaceId: string,
  ): Promise<HTMLInputElement> {
    await user.click(screen.getByTestId('space-drawer-trigger'));
    await openRowMenu(user, spaceId);
    await user.click(screen.getByTestId(`space-drawer-rename-${spaceId}`));
    return (await screen.findByTestId(
      `space-drawer-rename-input-${spaceId}`,
    )) as HTMLInputElement;
  }

  it('Rename turns the name into a box holding the whole name, selected', async () => {
    const user = userEvent.setup();
    setup();
    const box = await startRename(user, 'sp-1');
    expect(box.value).toBe('Reel');
    expect(document.activeElement).toBe(box);
    expect(box.selectionStart).toBe(0);
    expect(box.selectionEnd).toBe(4);
    // Selected from the end back, so a long name shows its start.
    expect(box.selectionDirection).toBe('backward');
    expect(box.maxLength).toBe(SPACE_NAME_MAX_LEN);
  });

  it('Enter saves the trimmed name, shows it at once and gives the keyboard to the row menu', async () => {
    const user = userEvent.setup();
    const onRenameSpace = vi.fn(() => new Promise<void>(() => undefined));
    setup({ onRenameSpace });
    const box = await startRename(user, 'sp-1');
    await user.clear(box);
    await user.type(box, '  Cut 2  {Enter}');
    expect(onRenameSpace).toHaveBeenCalledWith('sp-1', 'Cut 2');
    expect(screen.queryByTestId('space-drawer-rename-input-sp-1')).toBeNull();
    expect(screen.getByTestId('space-drawer-row-sp-1')).toHaveTextContent('Cut 2');
    expect(document.activeElement).toBe(screen.getByTestId('space-drawer-menu-sp-1'));
  });

  it('pressing away saves the name', async () => {
    const user = userEvent.setup();
    const onRenameSpace = vi.fn();
    setup({ onRenameSpace });
    const box = await startRename(user, 'sp-1');
    await user.clear(box);
    await user.type(box, 'Cut 3');
    await user.click(screen.getByTestId('space-drawer'));
    expect(onRenameSpace).toHaveBeenCalledWith('sp-1', 'Cut 3');
  });

  it('Escape leaves the name as it was, keeps the drawer and gives the keyboard to the row menu', async () => {
    const user = userEvent.setup();
    const onRenameSpace = vi.fn();
    setup({ onRenameSpace });
    const box = await startRename(user, 'sp-1');
    await user.type(box, 'zzz');
    await user.keyboard('{Escape}');
    expect(onRenameSpace).not.toHaveBeenCalled();
    expect(screen.getByTestId('space-drawer')).toBeInTheDocument();
    expect(screen.getByTestId('space-drawer-row-sp-1')).toHaveTextContent('Reel');
    expect(document.activeElement).toBe(screen.getByTestId('space-drawer-menu-sp-1'));
  });

  it('an empty or unchanged name sends nothing', async () => {
    const user = userEvent.setup();
    const onRenameSpace = vi.fn();
    setup({ onRenameSpace });
    await startRename(user, 'sp-1');
    await user.keyboard('{Enter}');
    await openRowMenu(user, 'sp-1');
    await user.click(screen.getByTestId('space-drawer-rename-sp-1'));
    const box = await screen.findByTestId('space-drawer-rename-input-sp-1');
    await user.clear(box);
    await user.type(box, '   {Enter}');
    expect(onRenameSpace).not.toHaveBeenCalled();
    expect(screen.getByTestId('space-drawer-row-sp-1')).toHaveTextContent('Reel');
  });

  it('goes back to the saved name when the rename is refused', async () => {
    const user = userEvent.setup();
    let refuse: (err: Error) => void = () => undefined;
    const onRenameSpace = vi.fn(
      () =>
        new Promise<void>((_resolve, reject) => {
          refuse = reject;
        }),
    );
    setup({ onRenameSpace });
    const box = await startRename(user, 'sp-1');
    await user.clear(box);
    await user.type(box, 'Cut 4{Enter}');
    expect(screen.getByTestId('space-drawer-row-sp-1')).toHaveTextContent('Cut 4');
    await act(async () => {
      refuse(new Error('refused'));
    });
    expect(screen.getByTestId('space-drawer-row-sp-1')).toHaveTextContent('Reel');
  });

  it('a press inside the box does not open the Space', async () => {
    const user = userEvent.setup();
    const onActivate = vi.fn();
    setup({ onActivate });
    const box = await startRename(user, 'sp-1');
    await user.click(box);
    expect(onActivate).not.toHaveBeenCalled();
    expect(screen.getByTestId('space-drawer')).toBeInTheDocument();
    expect(document.activeElement).toBe(box);
  });

  it('sizes the box to the name line and lets it shrink before the menu button', async () => {
    const user = userEvent.setup();
    setup();
    const box = await startRename(user, 'sp-1');
    for (const cls of ['min-w-0', 'flex-1', 'h-7', 'py-1', '-my-1', 'leading-[18px]', 'text-sm', 'font-normal']) {
      expect(box.className.split(/\s+/)).toContain(cls);
    }
    expect(box).toHaveAttribute('autocomplete', 'off');
  });

  it('a locked Space offers Rename greyed, says why, and opens no box', async () => {
    const user = userEvent.setup();
    setup({ spaces: [{ ...SPACE, locked: true }, SIBLING] });
    await user.click(screen.getByTestId('space-drawer-trigger'));
    await openRowMenu(user, 'sp-1');
    const item = screen.getByTestId('space-drawer-rename-sp-1');
    expect(item).toHaveAttribute('data-disabled');
    expect(item).toHaveTextContent('Locked spaces can\'t be renamed');
    await user.click(item);
    expect(screen.queryByTestId('space-drawer-rename-input-sp-1')).toBeNull();
  });

  it('sets the name and the time as the conversation history does', async () => {
    const user = userEvent.setup();
    setup();
    await user.click(screen.getByTestId('space-drawer-trigger'));
    const name = screen.getByTestId('space-drawer-name-sp-1');
    for (const cls of ['text-sm', 'font-normal', 'text-foreground']) {
      expect(name.className.split(/\s+/)).toContain(cls);
    }
    const time = screen.getByTestId('space-drawer-row-sp-1').querySelector('.tabular-nums');
    expect(time?.className.split(/\s+/)).toContain('text-2xs');
  });

  it('draws the type icon on its own, centred on the row', async () => {
    const user = userEvent.setup();
    setup();
    await user.click(screen.getByTestId('space-drawer-trigger'));
    const icon = screen.getByTestId('space-drawer-type-icon-sp-1');
    expect(icon.getAttribute('class')?.split(/\s+/)).toEqual(expect.arrayContaining(['h-5', 'w-5', 'self-center']));
    expect(icon.parentElement?.className ?? '').not.toMatch(/bg-muted/);
  });

  it('centres the Editing mark on the row at its right end, at the same level as the type icon', async () => {
    const user = userEvent.setup();
    setup({ activeSpaceId: 'sp-1' });
    await user.click(screen.getByTestId('space-drawer-trigger'));
    const editing = screen.getByText('Editing');
    expect(editing.className.split(/\s+/)).toEqual(expect.arrayContaining(['ml-auto', 'self-center']));
    expect(editing.parentElement).toBe(screen.getByTestId('space-drawer-type-icon-sp-1').parentElement);
  });

  it('marks only the Space being edited, with an outline', async () => {
    const user = userEvent.setup();
    setup({ activeSpaceId: 'sp-1' });
    await user.click(screen.getByTestId('space-drawer-trigger'));
    const editing = screen.getByText('Editing');
    expect(editing.className.split(/\s+/)).toEqual(
      expect.arrayContaining(['border', 'border-border', 'text-foreground-secondary']),
    );
    expect(editing.className).not.toMatch(/bg-muted|status-info/);
    expect(screen.getAllByText('Editing')).toHaveLength(1);
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
    ).toMatch(/(^|\s)pr-8(\s|$)/);
  });
});
