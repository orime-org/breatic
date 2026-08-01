// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * The role chip, and the two things a viewer can do from it.
 *
 * A viewer may hold at most one live request per project, so the chip has two
 * states and the second one is not cosmetic: while a request is outstanding it
 * is the ONLY place to withdraw it, and without withdrawing, an unanswered ask
 * locks the viewer out of asking again until it times out a week later.
 *
 * The chip's own label stays "Viewer" throughout — that is still their role,
 * and role names are frozen product vocabulary. What changes is the icon and
 * what the popover contains.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('@web/data/api/role-upgrade-requests', () => ({
  roleUpgradeRequestsApi: {
    submit: vi.fn(),
    mine: vi.fn(),
    decide: vi.fn(),
    cancel: vi.fn(),
  },
}));

import { RoleTag } from '@web/pages/project/chrome/top-bar/RoleTag';
import { roleUpgradeRequestsApi } from '@web/data/api/role-upgrade-requests';
import type { ProjectRole } from '@web/stores';

const PID = 'p-1';
const REQ = 'r-1';
// Passed as constants rather than JSX literals: `RoleTag`'s prop is named
// `role`, which jsx-a11y reads as the ARIA attribute when it sees a literal.
const OWNER: ProjectRole = 'owner';
const VIEWER: ProjectRole = 'viewer';

/**
 * Render inside a fresh QueryClientProvider — the chip reads its own live
 * request and invalidates that read after submitting or withdrawing.
 * @param ui - The element under test.
 * @returns The render result.
 */
function renderTag(ui: ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>{ui}</QueryClientProvider>,
  );
}

/**
 * A live request expiring a week out.
 * @returns The live request shape the chip reads.
 */
function liveRequest(): { id: string; expiresAt: string } {
  return {
    id: REQ,
    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
  };
}

describe('RoleTag', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(roleUpgradeRequestsApi.mine).mockResolvedValue(null);
  });

  it('is a read-only chip for owners and editors', () => {
    renderTag(<RoleTag role={OWNER} projectId={PID} />);
    expect(screen.getByTestId('role-tag')).toHaveTextContent('Owner');
    expect(screen.getByTestId('role-tag').tagName).toBe('SPAN');
    // No request of their own to look up — owners and editors never ask.
    expect(roleUpgradeRequestsApi.mine).not.toHaveBeenCalled();
  });

  it('offers the request form to a viewer with nothing outstanding', async () => {
    const user = userEvent.setup();
    renderTag(<RoleTag role={VIEWER} projectId={PID} />);
    await user.click(screen.getByTestId('role-tag'));

    expect(await screen.findByTestId('role-tag-submit')).toBeInTheDocument();
    expect(screen.queryByTestId('role-tag-pending')).not.toBeInTheDocument();
    expect(
      screen.queryByTestId('role-tag-pending-icon'),
    ).not.toBeInTheDocument();
  });

  it('shows the outstanding request instead of a second form', async () => {
    // Sending again would just answer 409 — one live request per person per
    // project — so offering the form again would be offering a dead end.
    vi.mocked(roleUpgradeRequestsApi.mine).mockResolvedValue(liveRequest());
    const user = userEvent.setup();
    renderTag(<RoleTag role={VIEWER} projectId={PID} />);

    expect(
      await screen.findByTestId('role-tag-pending-icon'),
    ).toBeInTheDocument();
    await user.click(screen.getByTestId('role-tag'));

    expect(await screen.findByTestId('role-tag-pending')).toBeInTheDocument();
    expect(screen.queryByTestId('role-tag-submit')).not.toBeInTheDocument();
    // The deadline is shown: it is the difference between "waiting" and
    // "waiting for something already over".
    expect(screen.getByTestId('role-tag-pending-expiry')).toHaveTextContent(
      /7/,
    );
  });

  it('withdraws the request it is showing, not some other one', async () => {
    vi.mocked(roleUpgradeRequestsApi.mine).mockResolvedValue(liveRequest());
    vi.mocked(roleUpgradeRequestsApi.cancel).mockResolvedValue({ ok: true });
    const user = userEvent.setup();
    renderTag(<RoleTag role={VIEWER} projectId={PID} />);
    await user.click(await screen.findByTestId('role-tag'));
    await user.click(await screen.findByTestId('role-tag-withdraw'));

    await waitFor(() => {
      expect(roleUpgradeRequestsApi.cancel).toHaveBeenCalledWith(REQ);
    });
  });

  it('keeps the label on the role, which has not changed', async () => {
    // "Viewer" is what they are while they wait; the request is a separate
    // fact, and role names are frozen product vocabulary either way.
    vi.mocked(roleUpgradeRequestsApi.mine).mockResolvedValue(liveRequest());
    renderTag(<RoleTag role={VIEWER} projectId={PID} />);
    expect(
      await screen.findByTestId('role-tag-pending-icon'),
    ).toBeInTheDocument();
    expect(screen.getByTestId('role-tag')).toHaveTextContent('Viewer');
  });
});
