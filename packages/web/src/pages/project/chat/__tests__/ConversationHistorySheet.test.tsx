import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import {
  ConversationHistorySheet,
  formatRelative,
  type ConversationSummary,
} from '@/pages/project/chat/ConversationHistorySheet';

const CONVS: ConversationSummary[] = [
  {
    id: 'c1',
    name: '主线剧情研究',
    preview: '我们讨论了赛博朋克设定和…',
    updatedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
    messageCount: 5,
  },
  {
    id: 'c2',
    name: '角色性格设计',
    preview: '林夏的成长弧线和动机…',
    updatedAt: new Date(Date.now() - 26 * 3_600_000).toISOString(),
    messageCount: 12,
  },
];

describe('formatRelative', () => {
  const NOW = Date.parse('2026-05-21T12:00:00Z');

  it('returns minute granularity within the hour', () => {
    expect(
      formatRelative(new Date(NOW - 5 * 60_000).toISOString(), NOW),
    ).toBe('5 分钟前');
  });

  it('returns hour granularity within the day', () => {
    expect(
      formatRelative(new Date(NOW - 3 * 3_600_000).toISOString(), NOW),
    ).toBe('3 小时前');
  });

  it('returns "昨天" for 24-48h ago', () => {
    expect(
      formatRelative(new Date(NOW - 26 * 3_600_000).toISOString(), NOW),
    ).toBe('昨天');
  });

  it('returns "N 天前" within the week', () => {
    expect(
      formatRelative(new Date(NOW - 3 * 86_400_000).toISOString(), NOW),
    ).toBe('3 天前');
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
    ).toHaveTextContent('暂无历史会话');
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
