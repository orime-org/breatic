// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const stale = vi.hoisted(() => ({ value: true }));
vi.mock('@web/data/deployment/stale-release', () => ({ useStaleRelease: () => stale.value }));
const reloadForUpdate = vi.hoisted(() => vi.fn());
// The real pending state, with the reload itself counted: jsdom only reports it.
vi.mock('@web/stores/reload-for-update', async (importOriginal) => {
  const real = await importOriginal<typeof import('@web/stores/reload-for-update')>();
  return {
    ...real,
    reloadForUpdate: (): void => {
      reloadForUpdate();
      real.reloadForUpdate();
    },
  };
});

import { StaleReleaseDialog } from '@web/app/StaleReleaseDialog';

beforeEach(() => {
  stale.value = true;
  reloadForUpdate.mockReset();
  // Leave no Update pending from the test before; jsdom reports the reload it cannot do.
  window.dispatchEvent(new Event('pointerdown'));
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

describe('the dialog an out-of-date page cannot dismiss', () => {
  it('shows nothing while the page is current', () => {
    stale.value = false;
    render(<StaleReleaseDialog />);
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it('says the page is out of date and offers only Update', () => {
    render(<StaleReleaseDialog />);
    const dialog = screen.getByRole('alertdialog');
    expect(dialog).toHaveTextContent('Page out of date');
    expect(screen.getAllByRole('button')).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Update' })).toBeVisible();
  });

  it('does not close on Escape', async () => {
    const user = userEvent.setup();
    render(<StaleReleaseDialog />);
    await user.keyboard('{Escape}');
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
  });

  // inner#1729: the page stays while the next one loads, so Update shows it is working.
  it('spins on Update while the next page loads', async () => {
    const user = userEvent.setup();
    render(<StaleReleaseDialog />);
    const update = screen.getByRole('button', { name: 'Update' });
    await user.click(update);
    expect(update).toHaveAttribute('aria-busy', 'true');
  });

  it('reloads on Update and stays open', async () => {
    const user = userEvent.setup();
    render(<StaleReleaseDialog />);
    await user.click(screen.getByRole('button', { name: 'Update' }));
    expect(reloadForUpdate).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
  });
});
