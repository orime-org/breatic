// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import {
  ConversationHistorySheet,
  relativeTime,
  type ConversationSummary,
  type RelativeTime,
} from '@web/pages/project/chat/ConversationHistorySheet';
import { expectNoA11yViolations } from '@web/test-utils/a11y';
import { expectEveryLocaleRenders } from '@web/test-utils/i18n-keys';

const CONVS: ConversationSummary[] = [
  {
    id: 'c1',
    name: 'Main plot research',
    preview: 'We discussed cyberpunk setting and…',
    updatedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
    messageCount: 5,
  },
  {
    id: 'c2',
    name: 'Character design',
    preview: 'Lin Xia\'s growth arc and motives…',
    updatedAt: new Date(Date.now() - 26 * 3_600_000).toISOString(),
    messageCount: 12,
  },
];

describe('relativeTime', () => {
  const NOW = Date.parse('2026-05-21T12:00:00Z');

  it('returns minute bucket within the hour', () => {
    expect(
      relativeTime(new Date(NOW - 5 * 60_000).toISOString(), NOW),
    ).toEqual({ key: 'chat.relative.minutesAgo', params: { count: 5 } });
  });

  it('returns hour bucket within the day', () => {
    expect(
      relativeTime(new Date(NOW - 3 * 3_600_000).toISOString(), NOW),
    ).toEqual({ key: 'chat.relative.hoursAgo', params: { count: 3 } });
  });

  it('returns yesterday bucket for 24-48h ago', () => {
    expect(
      relativeTime(new Date(NOW - 26 * 3_600_000).toISOString(), NOW),
    ).toEqual({ key: 'chat.relative.yesterday' });
  });

  it('returns day bucket within the week', () => {
    expect(
      relativeTime(new Date(NOW - 3 * 86_400_000).toISOString(), NOW),
    ).toEqual({ key: 'chat.relative.daysAgo', params: { count: 3 } });
  });

  // Every branch, including the two that name `isoDate` — the one past a year
  // and the one for a timestamp that will not parse. Those two shipped naming
  // a key no catalog had. Nobody read `chat.relative.isoDate` off a screen,
  // because nothing feeds this sheet yet: ProjectPage renders ChatPanel with
  // no `conversations`, so the list is always empty and this function is never
  // called in the product. A latent miss, waiting for that wiring.
  it('renders to real text in every locale, in every branch', () => {
    // One entry per member of `RelativeTime['key']`. Widening that union
    // without adding the key here is a type error, which is the only
    // mechanical tie between the branches this test walks and the branches the
    // function can take — a hand-written count of distinct keys cannot notice
    // a ninth one arriving.
    const EVERY_KEY: Record<RelativeTime['key'], true> = {
      'chat.relative.justNow': true,
      'chat.relative.minutesAgo': true,
      'chat.relative.hoursAgo': true,
      'chat.relative.yesterday': true,
      'chat.relative.daysAgo': true,
      'chat.relative.weeksAgo': true,
      'chat.relative.monthsAgo': true,
      'chat.relative.isoDate': true,
    };
    const branches = [
      relativeTime(new Date(NOW - 30_000).toISOString(), NOW),
      relativeTime(new Date(NOW - 5 * 60_000).toISOString(), NOW),
      relativeTime(new Date(NOW - 3 * 3_600_000).toISOString(), NOW),
      relativeTime(new Date(NOW - 26 * 3_600_000).toISOString(), NOW),
      relativeTime(new Date(NOW - 3 * 86_400_000).toISOString(), NOW),
      relativeTime(new Date(NOW - 10 * 86_400_000).toISOString(), NOW),
      relativeTime(new Date(NOW - 60 * 86_400_000).toISOString(), NOW),
      relativeTime(new Date(NOW - 400 * 86_400_000).toISOString(), NOW),
      relativeTime('not a timestamp', NOW),
    ];
    // The list above is only as good as its coverage of the branches, so pin
    // that it does reach every key the return type allows.
    expect(new Set(branches.map((b) => b.key))).toEqual(
      new Set(Object.keys(EVERY_KEY)),
    );

    expectEveryLocaleRenders(branches);
  });
});

describe('ConversationHistorySheet', () => {
  it('has no a11y violations when open with content', async () => {
    render(
      <ConversationHistorySheet
        open
        onOpenChange={() => {}}
        conversations={CONVS}
        activeId='c1'
        onPick={() => {}}
      />,
    );
    await expectNoA11yViolations(document.body);
  });

  it('renders the empty fallback when there are no conversations', () => {
    render(
      <ConversationHistorySheet
        open
        onOpenChange={() => undefined}
        conversations={[]}
        onPick={() => undefined}
      />,
    );
    expect(
      screen.getByTestId('conversation-history-list'),
    ).toHaveTextContent('No previous conversations');
  });

  it('renders one row per conversation', () => {
    render(
      <ConversationHistorySheet
        open
        onOpenChange={() => undefined}
        conversations={CONVS}
        onPick={() => undefined}
      />,
    );
    expect(screen.getByTestId('conversation-c1')).toBeInTheDocument();
    expect(screen.getByTestId('conversation-c2')).toBeInTheDocument();
  });

  it('marks the active row with aria-current', () => {
    render(
      <ConversationHistorySheet
        open
        onOpenChange={() => undefined}
        conversations={CONVS}
        activeId='c1'
        onPick={() => undefined}
      />,
    );
    expect(screen.getByTestId('conversation-c1')).toHaveAttribute(
      'aria-current',
      'true',
    );
    expect(
      screen.getByTestId('conversation-c2').getAttribute('aria-current'),
    ).toBeNull();
  });

  it('clicking a row fires onPick with that id', async () => {
    const user = userEvent.setup();
    const onPick = vi.fn();
    render(
      <ConversationHistorySheet
        open
        onOpenChange={() => undefined}
        conversations={CONVS}
        onPick={onPick}
      />,
    );
    await user.click(screen.getByTestId('conversation-c2'));
    expect(onPick).toHaveBeenCalledWith('c2');
  });
});
