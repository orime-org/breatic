// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The tab bar at the Space cap (inner#1140): the new-Space button and the
 * activity panel's Restore are unavailable at 200 Spaces but stay reachable by
 * keyboard; pressing one says why in a warning toast, hovering one says why in
 * a tooltip, and the reason never appears when nobody is hovering.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  render as rtlRender,
  screen,
  act,
  fireEvent,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type * as React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { MAX_SPACES_PER_PROJECT, type ProjectActivityEntry } from '@breatic/shared';
import { SpaceTabBar } from '@web/pages/project/chrome/tab-bar/SpaceTabBar';
import type { ProjectSpace } from '@web/data/yjs/project-meta';
import { TooltipProvider } from '@web/components/ui/tooltip';
import { useUIStore } from '@web/stores';

const { listMock, toastWarningMock } = vi.hoisted(() => ({
  listMock: vi.fn(),
  toastWarningMock: vi.fn(),
}));
vi.mock('@web/data/api/activities', () => ({
  activitiesApi: { list: listMock },
}));
vi.mock('@web/lib/toast', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@web/lib/toast')>();
  return { ...actual, toast: { ...actual.toast, warning: toastWarningMock } };
});

const LIMIT_TEXT = 'Reached the limit of 200 Spaces';

/**
 * A project's Spaces, `count` of them.
 * @param count - How many.
 * @returns The Spaces.
 */
function spaces(count: number): ProjectSpace[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `s${i}`,
    name: `Space ${i}`,
    type: 'canvas' as const,
  }));
}

/**
 * The bar as the project page mounts it, with the providers the app supplies.
 * @param allSpaces - The project's Spaces.
 * @returns A rerender that swaps the Spaces on the same mounted bar.
 */
function renderBar(allSpaces: ProjectSpace[]): (next: ProjectSpace[]) => void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const Wrapper = ({ children }: { children: React.ReactNode }): React.JSX.Element => (
    <QueryClientProvider client={client}>
      <TooltipProvider delayDuration={0}>{children}</TooltipProvider>
    </QueryClientProvider>
  );
  const bar = (list: ProjectSpace[]): React.JSX.Element => (
    <SpaceTabBar
      spaces={list.slice(0, 1)}
      allSpaces={list}
      activeSpaceId='s0'
      projectId='p1'
      onActivate={vi.fn()}
      onCreate={vi.fn()}
      currentUserRole='owner'
      onRestoreSpace={vi.fn()}
    />
  );
  const view = rtlRender(bar(allSpaces), { wrapper: Wrapper });
  return (next) => view.rerender(bar(next));
}

describe('SpaceTabBar at the Space cap', () => {
  const realScrollTo = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTo');

  beforeEach(() => {
    useUIStore.setState({ activeOverlayId: null });
    useUIStore.getState().setChatPanelCollapsed(false);
    Element.prototype.scrollTo = vi.fn();
    listMock.mockReset();
    listMock.mockResolvedValue({ items: [], nextCursor: null });
    toastWarningMock.mockReset();
  });

  afterEach(() => {
    if (realScrollTo) {
      Object.defineProperty(Element.prototype, 'scrollTo', realScrollTo);
    } else {
      delete (Element.prototype as unknown as Record<string, unknown>).scrollTo;
    }
  });

  it('says the limit is reached when the unavailable new-Space button is hovered', async () => {
    renderBar(spaces(MAX_SPACES_PER_PROJECT));
    const button = screen.getByTestId('new-space-button');
    expect(button).toHaveAttribute('aria-disabled', 'true');

    fireEvent.pointerMove(button, { pointerType: 'mouse' });

    expect(await screen.findByRole('tooltip')).toHaveTextContent(LIMIT_TEXT);
  });

  it('keeps the new-Space button reachable by keyboard at the cap', () => {
    renderBar(spaces(MAX_SPACES_PER_PROJECT));
    const button = screen.getByTestId('new-space-button');

    act(() => button.focus());

    expect(button).not.toBeDisabled();
    expect(button).toHaveFocus();
  });

  it('says why with a warning toast and opens no dialog when the new-Space button is clicked at the cap', async () => {
    renderBar(spaces(MAX_SPACES_PER_PROJECT));

    await userEvent.setup().click(screen.getByTestId('new-space-button'));

    expect(toastWarningMock).toHaveBeenCalledWith(LIMIT_TEXT);
    expect(screen.queryByTestId('new-space-dialog')).toBeNull();
  });

  it('says why with a warning toast and opens no dialog when Enter is pressed on the new-Space button at the cap', async () => {
    renderBar(spaces(MAX_SPACES_PER_PROJECT));
    const user = userEvent.setup();
    act(() => screen.getByTestId('new-space-button').focus());

    await user.keyboard('{Enter}');

    expect(toastWarningMock).toHaveBeenCalledWith(LIMIT_TEXT);
    expect(screen.queryByTestId('new-space-dialog')).toBeNull();
  });

  it('opens the dialog and shows no toast below the cap', async () => {
    renderBar(spaces(MAX_SPACES_PER_PROJECT - 1));

    await userEvent.setup().click(screen.getByTestId('new-space-button'));

    expect(await screen.findByTestId('new-space-dialog')).toBeInTheDocument();
    expect(toastWarningMock).not.toHaveBeenCalled();
  });

  it('does not show the reason by itself when a collaborator fills the project after a hover', async () => {
    const setSpaces = renderBar(spaces(MAX_SPACES_PER_PROJECT - 1));
    const button = screen.getByTestId('new-space-button');
    fireEvent.pointerMove(button, { pointerType: 'mouse' });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    fireEvent.pointerLeave(button, { pointerType: 'mouse' });

    setSpaces(spaces(MAX_SPACES_PER_PROJECT));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('does not show the reason by itself when focus comes back to the button and the project fills', async () => {
    // Closing the new-Space dialog hands focus back to the button, and a
    // tooltip opens on focus without waiting for a hover.
    const setSpaces = renderBar(spaces(MAX_SPACES_PER_PROJECT - 1));
    act(() => screen.getByTestId('new-space-button').focus());

    setSpaces(spaces(MAX_SPACES_PER_PROJECT));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('marks Restore unavailable in the activity panel it mounts once the project holds the cap', async () => {
    const deleted: ProjectActivityEntry = {
      id: 'del-1',
      projectId: 'p1',
      actorUserId: 'u-1',
      actorName: 'Yuki',
      type: 'space:deleted',
      spaceId: 'gone',
      nodeId: null,
      taskId: null,
      payload: { spaceName: 'Old', spaceSnapshot: { id: 'gone' } },
      restored: false,
      createdAt: Date.now() - 60_000,
    };
    listMock.mockResolvedValue({ items: [deleted], nextCursor: null });
    renderBar(spaces(MAX_SPACES_PER_PROJECT));

    await userEvent.setup().click(screen.getByTestId('project-activity-trigger'));

    expect(await screen.findByTestId('project-activity-restore-del-1')).toHaveAttribute(
      'aria-disabled',
      'true',
    );
  });
});
