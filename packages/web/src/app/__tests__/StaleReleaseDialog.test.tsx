// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const stale = vi.hoisted(() => ({ value: true }));
vi.mock('@web/data/deployment/stale-release', () => ({ useStaleRelease: () => stale.value }));
const reloadForUpdate = vi.hoisted(() => vi.fn());
vi.mock('@web/stores/reload-for-update', () => ({ reloadForUpdate }));

import { StaleReleaseDialog } from '@web/app/StaleReleaseDialog';

beforeEach(() => {
  stale.value = true;
  reloadForUpdate.mockReset();
});

describe('the dialog an out-of-date page cannot dismiss', () => {
  it('shows nothing while the page is current', () => {
    stale.value = false;
    render(<StaleReleaseDialog />);
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it('says the page was updated and offers only Update', () => {
    render(<StaleReleaseDialog />);
    const dialog = screen.getByRole('alertdialog');
    expect(dialog).toHaveTextContent('This page has been updated');
    expect(screen.getAllByRole('button')).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Update' })).toBeVisible();
  });

  it('does not close on Escape', async () => {
    const user = userEvent.setup();
    render(<StaleReleaseDialog />);
    await user.keyboard('{Escape}');
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
  });

  it('reloads on Update and stays open', async () => {
    const user = userEvent.setup();
    render(<StaleReleaseDialog />);
    await user.click(screen.getByRole('button', { name: 'Update' }));
    expect(reloadForUpdate).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
  });
});
