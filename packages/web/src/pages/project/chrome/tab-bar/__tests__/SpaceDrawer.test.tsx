// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  render as rtlRender,
  screen,
  type RenderOptions,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type * as React from 'react';

import { SpaceDrawer } from '@web/pages/project/chrome/tab-bar/SpaceDrawer';
import { TooltipProvider } from '@web/components/ui/tooltip';
import { useUIStore } from '@web/stores/ui';
import type { ProjectSpace } from '@web/data/yjs/project-meta';

// SpaceDrawer's trigger and the row's delete action both wrap their
// buttons in shadcn `Tooltip`, which throws without a `TooltipProvider`
// up the tree. App.tsx supplies one at runtime — tests add it here.
const render = (ui: React.ReactElement, options?: RenderOptions) =>
  rtlRender(ui, { wrapper: TooltipProvider, ...options });

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

  it('opens the delete-confirm AlertDialog from the row delete action', async () => {
    const user = userEvent.setup();
    setup();
    await user.click(screen.getByTestId('space-drawer-trigger'));
    await user.click(screen.getByTestId('space-drawer-delete-sp-1'));
    expect(
      await screen.findByTestId('space-drawer-delete-confirm-sp-1'),
    ).toBeInTheDocument();
  });

  it('closing the delete-confirm dialog does not re-pop the delete action tooltip', async () => {
    // C mechanism, AlertDialog family — the only AlertDialog site and the
    // only one wired via RowAction's indirect `onFocusCapture` prop. The
    // guarantee this PR makes is "no stray tooltip after the overlay
    // closes", which holds here.
    //
    // NOTE on focus: unlike the other 8 sites, this modal AlertDialog is
    // nested inside the non-modal Sheet (drawer) AND its trigger is an
    // `opacity-0` hover-action. On close, Radix lands focus on <body>
    // rather than the (invisible) trigger button — verified in a real
    // browser, and PRE-EXISTING (this PR only adds `onFocusCapture`; it
    // never touched the AlertDialog's focus restoration). Because focus
    // never reaches the trigger, the tooltip can't re-pop anyway; the
    // `onFocusCapture` here is defensive. We therefore assert the real
    // guarantee (no tooltip) and do NOT assert focus-returns-to-trigger
    // — returning focus to an invisible button is a separate, design-laden
    // a11y question tracked outside this tooltip PR.
    const user = userEvent.setup();
    setup();
    await user.click(screen.getByTestId('space-drawer-trigger'));
    const deleteBtn = screen.getByTestId('space-drawer-delete-sp-1');
    await user.click(deleteBtn);
    await screen.findByTestId('space-drawer-delete-confirm-sp-1');
    await user.keyboard('{Escape}');
    expect(
      screen.queryByTestId('space-drawer-delete-confirm-sp-1'),
    ).not.toBeInTheDocument();
    expect(
      document.querySelector(
        '[data-state="instant-open"],[data-state="delayed-open"]',
      ),
    ).toBeNull();
  });

  it('locked spaces show a disabled delete action with no AlertDialog', async () => {
    const user = userEvent.setup();
    // Two spaces so the disabled state is due to LOCK, not last-space.
    setup({ spaces: [{ ...SPACE, locked: true }, SIBLING] });
    await user.click(screen.getByTestId('space-drawer-trigger'));
    const deleteBtn = screen.getByTestId('space-drawer-delete-sp-1');
    expect(deleteBtn).toBeDisabled();
    await user.click(deleteBtn);
    expect(
      screen.queryByTestId('space-drawer-delete-confirm-sp-1'),
    ).not.toBeInTheDocument();
  });

  it('the LAST remaining space has a disabled delete action (project keeps >=1)', async () => {
    // Only one space — its delete must be disabled (you cannot delete the last
    // one). Backend refuses too; this is the UI gate so the affordance is never
    // offered.
    const user = userEvent.setup();
    setup({ spaces: [SPACE] });
    await user.click(screen.getByTestId('space-drawer-trigger'));
    const deleteBtn = screen.getByTestId('space-drawer-delete-sp-1');
    expect(deleteBtn).toBeDisabled();
    await user.click(deleteBtn);
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

  it('the active (editing) row uses the accent hover fill, not the recessed muted fill', async () => {
    // tokens.css semantics: --color-accent is the "global hover" lift,
    // --color-muted is a RECESS fill (avatar bg / track / disabled) that
    // sits below the card surface — using it on the selected row made it
    // darker than its siblings (user report 2026-07-04).
    const user = userEvent.setup();
    setup({ activeSpaceId: 'sp-1' });
    await user.click(screen.getByTestId('space-drawer-trigger'));
    const row = screen.getByTestId('space-drawer-row-sp-1');
    expect(row.className).toContain('bg-accent');
    expect(row.className).not.toContain('bg-muted');
  });

  it('#1539: closing the delete-confirm dialog returns focus to the drawer, not <body>', async () => {
    const user = userEvent.setup();
    setup();
    await user.click(screen.getByTestId('space-drawer-trigger'));
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
});
