// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@web/components/ui/tooltip';
import { useSpaceOperationsStore } from '@web/stores/space-operations';
import { ProjectUpdateNotice } from '../ProjectUpdateNotice';

const release = vi.hoisted(() => ({ version: 'next' as string | null, dismiss: vi.fn() }));
vi.mock('@web/data/deployment/use-app-update', () => ({ useAppUpdate: () => release }));
beforeEach(() => { release.version = 'next'; release.dismiss.mockReset(); useSpaceOperationsStore.setState({ operations: {} }); });
const renderNotice = (status: 'connected' | 'disconnected' | 'authFailed' = 'connected') => render(<TooltipProvider><ProjectUpdateNotice status={status} /></TooltipProvider>);

describe('Project update notice', () => {
  it('does not open or steal focus when a release appears', () => {
    renderNotice();
    expect(screen.getByTestId('project-update-trigger')).toBeVisible();
    expect(screen.queryByTestId('project-update-refresh')).not.toBeInTheDocument();
    expect(screen.getByTestId('project-update-trigger')).not.toHaveFocus();
  });
  it.each(['disconnected', 'authFailed'] as const)('yields to %s and closes an open popover', async status => {
    const user = userEvent.setup();
    const view = renderNotice();
    await user.click(screen.getByTestId('project-update-trigger'));
    view.rerender(<TooltipProvider><ProjectUpdateNotice status={status} /></TooltipProvider>);
    expect(screen.queryByTestId('project-update-refresh')).not.toBeInTheDocument();
    expect(screen.queryByTestId('project-update-trigger')).not.toBeInTheDocument();
  });
  it('shows operations from every Space while keeping refresh available', async () => {
    const user = userEvent.setup(); renderNotice();
    await user.click(screen.getByTestId('project-update-trigger'));
    const normal = screen.getByRole('status').textContent;
    act(() => useSpaceOperationsStore.getState().register('other-space', 'upload'));
    expect(screen.getByRole('status').textContent).not.toBe(normal);
    expect(screen.getByTestId('project-update-refresh')).toBeEnabled();
    act(() => useSpaceOperationsStore.getState().unregister('other-space', 'upload'));
    expect(screen.getByRole('status').textContent).toBe(normal);
    expect(screen.getByTestId('project-update-refresh')).toBeInTheDocument();
  });
  it('dismisses only when Later is chosen; Escape just closes the popover', async () => {
    const user = userEvent.setup(); renderNotice();
    await user.click(screen.getByTestId('project-update-trigger'));
    await user.keyboard('{Escape}');
    expect(release.dismiss).not.toHaveBeenCalled();
    await user.click(screen.getByTestId('project-update-trigger'));
    await user.click(screen.getByRole('button', { name: 'Later' }));
    expect(release.dismiss).toHaveBeenCalledTimes(1);
  });
});
