import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import type { ProjectMessageEntry } from '@breatic/shared';
import {
  ProjectMessagesButton,
  relativeTime,
} from '@/pages/project/chrome/tab-bar/ProjectMessagesButton';

const M_DELETED: ProjectMessageEntry = {
  id: 'm-del',
  kind: 'space-deleted',
  actor: 'Yuki',
  spaceId: 'sp-1',
  spaceName: 'Main',
  createdAt: Date.now() - 60_000,
};

const M_CREATED: ProjectMessageEntry = {
  id: 'm-new',
  kind: 'space-created',
  actor: 'Yuki',
  spaceId: 'sp-2',
  spaceName: 'Reel',
  createdAt: Date.now() - 600_000,
};

const M_MISSING: ProjectMessageEntry = {
  id: 'm-miss',
  kind: 'missing-node',
  message: 'spaces.history.kind.missingNode',
  context: { nodeId: 'n-1' },
  createdAt: Date.now() - 30_000,
};

describe('ProjectMessagesButton', () => {
  it('renders trigger with red dot when messages list is non-empty', () => {
    render(<ProjectMessagesButton messages={[M_DELETED]} />);
    expect(screen.getByTestId('project-messages-trigger')).toBeInTheDocument();
    expect(screen.getByTestId('project-messages-dot')).toBeInTheDocument();
  });

  it('omits red dot when messages list is empty', () => {
    render(<ProjectMessagesButton messages={[]} />);
    expect(screen.getByTestId('project-messages-trigger')).toBeInTheDocument();
    expect(screen.queryByTestId('project-messages-dot')).toBeNull();
  });

  it('renders one row per message after opening the popover', async () => {
    const user = userEvent.setup();
    render(
      <ProjectMessagesButton messages={[M_DELETED, M_CREATED, M_MISSING]} />,
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

  it('hides Restore button for non-owner viewers', async () => {
    const user = userEvent.setup();
    render(
      <ProjectMessagesButton
        messages={[M_DELETED]}
        currentUserRole='edit'
        onRestore={vi.fn()}
      />,
    );
    await user.click(screen.getByTestId('project-messages-trigger'));
    expect(
      screen.queryByTestId('project-messages-restore-m-del'),
    ).toBeNull();
  });

  it('shows Clear all only for owner with non-empty list', async () => {
    const user = userEvent.setup();
    const onClearAll = vi.fn();
    render(
      <ProjectMessagesButton
        messages={[M_DELETED]}
        currentUserRole='owner'
        onClearAll={onClearAll}
      />,
    );
    await user.click(screen.getByTestId('project-messages-trigger'));
    const clearBtn = screen.getByTestId('project-messages-clear-all');
    await user.click(clearBtn);
    expect(onClearAll).toHaveBeenCalled();
  });

  it('hides Clear all for non-owners', async () => {
    const user = userEvent.setup();
    render(
      <ProjectMessagesButton
        messages={[M_DELETED]}
        currentUserRole='edit'
        onClearAll={vi.fn()}
      />,
    );
    await user.click(screen.getByTestId('project-messages-trigger'));
    expect(screen.queryByTestId('project-messages-clear-all')).toBeNull();
  });

  it('renders empty-state copy when no messages', async () => {
    const user = userEvent.setup();
    render(<ProjectMessagesButton messages={[]} />);
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
    render(<ProjectMessagesButton messages={[old, newer]} />);
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
