import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import {
  ConversationHistorySheet,
  relativeTime,
  type ConversationSummary,
} from '@/pages/project/chat/ConversationHistorySheet';

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
});

describe('ConversationHistorySheet', () => {
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
