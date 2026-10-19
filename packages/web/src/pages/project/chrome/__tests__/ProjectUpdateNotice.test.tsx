// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@web/components/ui/tooltip';
import { useSpaceOperationsStore } from '@web/stores/space-operations';
import { ProjectUpdateNotice } from '../ProjectUpdateNotice';

const release = vi.hoisted(() => ({ version: 'next' as string | null, autoOpen: true, dismiss: vi.fn() }));
vi.mock('@web/data/deployment/use-app-update', () => ({ useAppUpdate: () => release }));
const stale = vi.hoisted(() => ({ value: false }));
vi.mock('@web/data/deployment/stale-release', () => ({ useStaleRelease: () => stale.value }));
const reloadForUpdate = vi.hoisted(() => vi.fn());
vi.mock('@web/stores/reload-for-update', () => ({ reloadForUpdate }));

beforeEach(() => {
  release.version = 'next';
  release.autoOpen = true;
  release.dismiss.mockReset();
  stale.value = false;
  reloadForUpdate.mockReset();
  useSpaceOperationsStore.setState({ operations: {} });
});
const renderNotice = (status: 'connected' | 'disconnected' | 'authFailed' = 'connected') =>
  render(<TooltipProvider><ProjectUpdateNotice status={status} /></TooltipProvider>);

describe('Project update notice', () => {
  it('opens the dialog by itself when a release appears', () => {
    renderNotice();
    expect(screen.getByRole('alertdialog')).toHaveTextContent('A new version is available');
    expect(screen.getByTestId('project-update-trigger')).toBeVisible();
  });

  it('stays closed for a release postponed earlier, with the top-bar notice still there', () => {
    release.autoOpen = false;
    renderNotice();
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(screen.getByTestId('project-update-trigger')).toHaveTextContent('New version');
  });

  it.each([
    ['Later', async (user: ReturnType<typeof userEvent.setup>) => { await user.click(screen.getByRole('button', { name: 'Later' })); }],
    ['Escape', async (user: ReturnType<typeof userEvent.setup>) => { await user.keyboard('{Escape}'); }],
  ])('postpones on %s, closes the dialog and keeps the notice', async (_name, close) => {
    const user = userEvent.setup();
    renderNotice();
    await close(user);
    expect(release.dismiss).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(screen.getByTestId('project-update-trigger')).toBeVisible();
  });

  it('opens the same dialog again from the top-bar notice', async () => {
    release.autoOpen = false;
    const user = userEvent.setup();
    renderNotice();
    await user.click(screen.getByTestId('project-update-trigger'));
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
  });

  it('reloads on Update and stays open, so a cancelled leave prompt leaves it in reach', async () => {
    const user = userEvent.setup();
    renderNotice();
    await user.click(screen.getByTestId('project-update-refresh'));
    expect(reloadForUpdate).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    expect(release.dismiss).not.toHaveBeenCalled();
  });

  it('warns about operations from every Space while keeping Update available', () => {
    renderNotice();
    const normal = screen.getByRole('alertdialog').textContent;
    act(() => useSpaceOperationsStore.getState().register('other-space', 'upload'));
    expect(screen.getByRole('alertdialog').textContent).not.toBe(normal);
    expect(screen.getByTestId('project-update-refresh')).toBeEnabled();
    act(() => useSpaceOperationsStore.getState().unregister('other-space', 'upload'));
    expect(screen.getByRole('alertdialog').textContent).toBe(normal);
  });

  it.each(['disconnected', 'authFailed'] as const)('yields to %s', (status) => {
    const view = renderNotice();
    view.rerender(<TooltipProvider><ProjectUpdateNotice status={status} /></TooltipProvider>);
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(screen.queryByTestId('project-update-trigger')).not.toBeInTheDocument();
  });

  it('gives way to the forced dialog once the page is found out of date', () => {
    stale.value = true;
    renderNotice();
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(screen.queryByTestId('project-update-trigger')).not.toBeInTheDocument();
  });
});
