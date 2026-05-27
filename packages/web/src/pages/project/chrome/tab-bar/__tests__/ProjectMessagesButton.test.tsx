import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import type { ProjectMessageEntry } from '@breatic/shared';
import {
  ProjectMessagesButton,
  relativeTime,
} from '@/pages/project/chrome/tab-bar/ProjectMessagesButton';
import { useUIStore } from '@/stores/ui';

beforeEach(() => {
  // Reset the global exclusive-overlay state — `useExclusiveOverlay`
  // reads it, so a leftover `activeOverlayId` from a sibling test
  // would either open or block this test's sheet incorrectly.
  useUIStore.setState({ activeOverlayId: null });
});

// Q11 v2 — `actor` is a userId, name is rendered via the `usersById`
// prop's live Yjs lookup. `spaceName` snapshot field was removed for
// active entries; `space-deleted` keeps `spaceSnapshot.name` because
// the spaceId leaves `meta.spaces` at delete time and there's no live
// row left to look up against.
const USERS_BY_ID: ReadonlyMap<string, { name: string }> = new Map([
  ['u-yuki', { name: 'Yuki' }],
]);
const SPACES_BY_ID: ReadonlyMap<string, { name: string }> = new Map([
  ['sp-2', { name: 'Reel' }],
]);

const M_DELETED: ProjectMessageEntry = {
  id: 'm-del',
  kind: 'space-deleted',
  actor: 'u-yuki',
  spaceId: 'sp-1',
  spaceSnapshot: { id: 'sp-1', name: 'Main', type: 'canvas' },
  createdAt: Date.now() - 60_000,
};

const M_CREATED: ProjectMessageEntry = {
  id: 'm-new',
  kind: 'space-created',
  actor: 'u-yuki',
  spaceId: 'sp-2',
  createdAt: Date.now() - 600_000,
};

const M_RENAMED: ProjectMessageEntry = {
  id: 'm-rename',
  kind: 'space-renamed',
  actor: 'u-yuki',
  spaceId: 'sp-2',
  spaceName: 'Reel v2',
  oldSpaceName: 'Reel',
  createdAt: Date.now() - 90_000,
};

const M_MISSING: ProjectMessageEntry = {
  id: 'm-miss',
  kind: 'missing-node',
  message: 'spaces.history.kind.missingNode',
  context: { nodeId: 'n-1' },
  createdAt: Date.now() - 30_000,
};

describe('ProjectMessagesButton', () => {
  it('renders trigger without any unread / dot indicator', () => {
    // Project messages channel has no read / unread state — the trigger
    // never decorates with a dot, regardless of message count.
    render(<ProjectMessagesButton messages={[M_DELETED]} usersById={USERS_BY_ID} spacesById={SPACES_BY_ID} />);
    expect(screen.getByTestId('project-messages-trigger')).toBeInTheDocument();
    expect(screen.queryByTestId('project-messages-dot')).toBeNull();
  });

  it('renders one row per message after opening the popover', async () => {
    const user = userEvent.setup();
    render(
      <ProjectMessagesButton messages={[M_DELETED, M_CREATED, M_MISSING]} usersById={USERS_BY_ID} spacesById={SPACES_BY_ID} />,
    );
    await user.click(screen.getByTestId('project-messages-trigger'));
    expect(screen.getByTestId('project-messages-entry-m-del')).toBeInTheDocument();
    expect(screen.getByTestId('project-messages-entry-m-new')).toBeInTheDocument();
    expect(screen.getByTestId('project-messages-entry-m-miss')).toBeInTheDocument();
  });

  it('shows Restore button only for owner on space-deleted entries', async () => {
    const user = userEvent.setup();
    const onRestore = vi.fn();
    render(
      <ProjectMessagesButton
        messages={[M_DELETED, M_CREATED]}
        usersById={USERS_BY_ID}
        spacesById={SPACES_BY_ID}
        currentUserRole='owner'
        onRestore={onRestore}
      />,
    );
    await user.click(screen.getByTestId('project-messages-trigger'));
    expect(
      screen.getByTestId('project-messages-restore-m-del'),
    ).toBeInTheDocument();
    expect(
      screen.queryByTestId('project-messages-restore-m-new'),
    ).toBeNull();
    await user.click(screen.getByTestId('project-messages-restore-m-del'));
    expect(onRestore).toHaveBeenCalledWith('sp-1');
  });

  it('replaces Restore button with a disabled "已恢复" badge when the deleted entry has restored=true', async () => {
    // Owner just clicked Restore once — collab's space:restore RPC
    // mutated `restored=true` on the original deleted entry inside
    // the same transact that wrote the space-restored audit entry.
    // The bell sheet now disables the button via that single
    // boolean read so a second click can't round-trip to the
    // server and fail with "No deletion record found" (the canvas
    // row was already un-soft-deleted).
    const user = userEvent.setup();
    const M_DELETED_RESTORED: ProjectMessageEntry = {
      ...M_DELETED,
      restored: true,
    };
    const onRestore = vi.fn();
    render(
      <ProjectMessagesButton
        messages={[M_DELETED_RESTORED]}
        usersById={USERS_BY_ID}
        spacesById={SPACES_BY_ID}
        currentUserRole='owner'
        onRestore={onRestore}
      />,
    );
    await user.click(screen.getByTestId('project-messages-trigger'));
    // Restore button gone, restored badge in its place.
    expect(
      screen.queryByTestId('project-messages-restore-m-del'),
    ).toBeNull();
    const badge = screen.getByTestId('project-messages-restored-badge-m-del');
    expect(badge).toBeDisabled();
    expect(badge.textContent).toMatch(/已恢复|Restored|復元済み|已還原/);
  });

  it('hides Restore button for non-owner viewers', async () => {
    const user = userEvent.setup();
    render(
      <ProjectMessagesButton
        messages={[M_DELETED]}
        usersById={USERS_BY_ID}
        spacesById={SPACES_BY_ID}
        currentUserRole='edit'
        onRestore={vi.fn()}
      />,
    );
    await user.click(screen.getByTestId('project-messages-trigger'));
    expect(
      screen.queryByTestId('project-messages-restore-m-del'),
    ).toBeNull();
  });

  it('hides Clear all for everyone (Q11 v2.1 design — projectMessages is the audit log)', async () => {
    // The clear-all button was removed in Q11 v2.1: projectMessages
    // now functions as an append-only audit log for rename / lock /
    // delete / restore events. Letting the owner wipe it loses
    // provenance the very moment we lean on it as the source of
    // truth. Re-enable once a "soft clear" / archive workflow ships.
    const user = userEvent.setup();
    render(
      <ProjectMessagesButton
        messages={[M_DELETED]}
        usersById={USERS_BY_ID}
        spacesById={SPACES_BY_ID}
        currentUserRole='owner'
        onClearAll={vi.fn()}
      />,
    );
    await user.click(screen.getByTestId('project-messages-trigger'));
    // Owner — still hidden.
    expect(screen.queryByTestId('project-messages-clear-all')).toBeNull();
  });

  it('renders space-renamed entry citing both old and new names', async () => {
    // Q12 design: rename is its own audit event. We show
    //   "Yuki renamed Reel → Reel v2"
    // so the historical Reel name is preserved alongside the current
    // one (the live space row already moved on). Both names must
    // appear verbatim in the rendered row text.
    const user = userEvent.setup();
    render(
      <ProjectMessagesButton
        messages={[M_RENAMED]}
        usersById={USERS_BY_ID}
        spacesById={SPACES_BY_ID}
      />,
    );
    await user.click(screen.getByTestId('project-messages-trigger'));
    const row = screen.getByTestId('project-messages-entry-m-rename');
    expect(row.textContent).toMatch(/Yuki/);
    expect(row.textContent).toMatch(/Reel\b/); // old name as a whole word
    expect(row.textContent).toMatch(/Reel v2/); // new name
  });

  it('renders empty-state copy when no messages', async () => {
    const user = userEvent.setup();
    render(<ProjectMessagesButton messages={[]} usersById={USERS_BY_ID} spacesById={SPACES_BY_ID} />);
    await user.click(screen.getByTestId('project-messages-trigger'));
    expect(screen.getByText(/messages yet|no messages/i)).toBeInTheDocument();
  });

  it('shows newest first (reverse insertion order)', async () => {
    const user = userEvent.setup();
    const old: ProjectMessageEntry = {
      id: 'old',
      kind: 'space-created',
      spaceId: 's',
      createdAt: 1,
    };
    const newer: ProjectMessageEntry = {
      id: 'new',
      kind: 'space-deleted',
      spaceId: 's',
      createdAt: 2,
    };
    render(<ProjectMessagesButton messages={[old, newer]} usersById={USERS_BY_ID} spacesById={SPACES_BY_ID} />);
    await user.click(screen.getByTestId('project-messages-trigger'));
    const list = screen.getByTestId('project-messages-list');
    const items = list.querySelectorAll('[data-testid^="project-messages-entry-"]');
    expect(items[0].getAttribute('data-testid')).toBe('project-messages-entry-new');
    expect(items[1].getAttribute('data-testid')).toBe('project-messages-entry-old');
  });
});

describe('relativeTime — pure bucket', () => {
  const NOW = 1_700_000_000_000;
  it('buckets < 1 min → justNow', () => {
    expect(relativeTime(NOW - 30_000, NOW).key).toBe(
      'spaces.history.relative.justNow',
    );
  });
  it('buckets minutes / hours / yesterday / days / weeks / months / iso', () => {
    expect(relativeTime(NOW - 5 * 60_000, NOW).key).toBe(
      'spaces.history.relative.minutesAgo',
    );
    expect(relativeTime(NOW - 5 * 3_600_000, NOW).key).toBe(
      'spaces.history.relative.hoursAgo',
    );
    expect(relativeTime(NOW - 30 * 3_600_000, NOW).key).toBe(
      'spaces.history.relative.yesterday',
    );
    expect(relativeTime(NOW - 3 * 86_400_000, NOW).key).toBe(
      'spaces.history.relative.daysAgo',
    );
    expect(relativeTime(NOW - 10 * 86_400_000, NOW).key).toBe(
      'spaces.history.relative.weeksAgo',
    );
    expect(relativeTime(NOW - 60 * 86_400_000, NOW).key).toBe(
      'spaces.history.relative.monthsAgo',
    );
    expect(relativeTime(NOW - 400 * 86_400_000, NOW).key).toBe(
      'spaces.history.relative.isoDate',
    );
  });
});
