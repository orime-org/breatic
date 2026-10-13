// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, it, expect, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import {
  ConversationHistorySheet,
  relativeTime,
  type ConversationRow,
  type RelativeTime,
} from '@web/pages/project/chat/ConversationHistorySheet';
import { expectNoA11yViolations } from '@web/test-utils/a11y';
import { expectEveryLocaleRenders } from '@web/test-utils/i18n-keys';
import {
  expectChosenFill,
  expectHoverableSiblingFill,
} from '@web/test-utils/selection-fill';

const CONVS: ConversationRow[] = [
  {
    id: 'c1',
    title: 'Main plot research',
    updatedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
  },
  {
    id: 'c2',
    title: 'Character design',
    updatedAt: new Date(Date.now() - 26 * 3_600_000).toISOString(),
  },
];

/** The handlers every case passes but none of these assert on. */
const NOOPS = {
  onRename: () => undefined,
  onDelete: async () => undefined,
  hasMore: false,
  onReachEnd: () => undefined,
  nextPageFailed: false,
  loadingMore: false,
};

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

  it('dates a conversation older than a year by the day of the reader', () => {
    const real = process.env['TZ'];
    try {
      process.env['TZ'] = 'Asia/Shanghai';
      const now = Date.parse('2026-10-03T00:00:00.000Z');
      // 23:00 UTC on 2 April 2025 is already 3 April in Shanghai.
      expect(relativeTime('2025-04-02T23:00:00.000Z', now)).toEqual({
        key: 'chat.relative.isoDate',
        params: { date: '2025-04-03' },
      });
    } finally {
      if (real === undefined) delete process.env['TZ'];
      else process.env['TZ'] = real;
    }
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
        {...NOOPS}
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
        {...NOOPS}
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
        {...NOOPS}
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
        {...NOOPS}
      />,
    );
    // On the row's own region rather than the row: the row is a container
    // holding that region and the menu, and a container is not what gets
    // selected.
    expect(screen.getByTestId('conversation-open-c1')).toHaveAttribute(
      'aria-current',
      'true',
    );
    expect(
      screen.getByTestId('conversation-open-c2').getAttribute('aria-current'),
    ).toBeNull();
  });

  it('fills the active row past the fill the others take under the pointer', () => {
    render(
      <ConversationHistorySheet
        open
        onOpenChange={() => undefined}
        conversations={CONVS}
        activeId='c1'
        onPick={() => undefined}
        {...NOOPS}
      />,
    );
    expectChosenFill(screen.getByTestId('conversation-c1'));
    expectHoverableSiblingFill(screen.getByTestId('conversation-c2'));
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
        {...NOOPS}
      />,
    );
    await user.click(screen.getByTestId('conversation-open-c2'));
    expect(onPick).toHaveBeenCalledWith('c2');
  });
});

describe('asking to delete a conversation', () => {
  it('leaves the question on screen for the reader to answer', async () => {
    // 走用户真实的三步:打开列表、打开那行的菜单、点删除。确认框必须还在 ——
    // 它要是跟着菜单一起消失,这条路上用户永远删不掉任何东西,而屏幕上只会
    // 闪一下,看不出发生过什么。
    const user = userEvent.setup();
    const onDelete = vi.fn().mockResolvedValue(undefined);
    render(
      <ConversationHistorySheet
        open
        onOpenChange={() => undefined}
        conversations={CONVS}
        activeId='c1'
        onPick={() => undefined}
        {...NOOPS}
        onDelete={onDelete}
      />,
    );

    await user.click(screen.getByTestId('conversation-menu-c2'));
    await user.click(await screen.findByTestId('conversation-delete-c2'));

    expect(await screen.findByTestId('conversation-delete-dialog')).toBeInTheDocument();

    await user.click(screen.getByTestId('conversation-delete-confirm'));
    expect(onDelete).toHaveBeenCalledWith('c2');
  });

  it('stays open and spinning while the delete is out, and closes once it is answered', async () => {
    const user = userEvent.setup();
    let answer: () => void = () => undefined;
    const onDelete = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          answer = resolve;
        }),
    );
    render(
      <ConversationHistorySheet
        open
        onOpenChange={() => undefined}
        conversations={CONVS}
        activeId='c1'
        onPick={() => undefined}
        {...NOOPS}
        onDelete={onDelete}
      />,
    );

    await user.click(screen.getByTestId('conversation-menu-c2'));
    await user.click(await screen.findByTestId('conversation-delete-c2'));
    const confirm = await screen.findByTestId('conversation-delete-confirm');
    await user.click(confirm);

    expect(onDelete).toHaveBeenCalledWith('c2');
    expect(screen.getByTestId('conversation-delete-dialog')).toBeInTheDocument();
    expect(confirm).toHaveAttribute('aria-busy', 'true');
    expect(confirm).toHaveAttribute('aria-disabled', 'true');

    await act(async () => {
      answer();
    });
    expect(screen.queryByTestId('conversation-delete-dialog')).toBeNull();
  });

  it('leaves a question asked later alone when an earlier delete is answered', async () => {
    const user = userEvent.setup();
    const answers: Array<() => void> = [];
    const onDelete = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          answers.push(resolve);
        }),
    );
    render(
      <ConversationHistorySheet
        open
        onOpenChange={() => undefined}
        conversations={CONVS}
        activeId='c1'
        onPick={() => undefined}
        {...NOOPS}
        onDelete={onDelete}
      />,
    );

    await user.click(screen.getByTestId('conversation-menu-c2'));
    await user.click(await screen.findByTestId('conversation-delete-c2'));
    await user.click(await screen.findByTestId('conversation-delete-confirm'));
    // Walked away from the wait, then asked about another row.
    await user.click(screen.getByTestId('conversation-delete-cancel'));
    await user.click(screen.getByTestId('conversation-menu-c1'));
    await user.click(await screen.findByTestId('conversation-delete-c1'));
    const confirm = await screen.findByTestId('conversation-delete-confirm');
    expect(confirm).not.toHaveAttribute('aria-busy');

    await act(async () => {
      answers[0]?.();
    });
    expect(screen.getByTestId('conversation-delete-dialog')).toBeInTheDocument();
  });

  it('spins the confirm for a row whose delete is still out after another row was deleted meanwhile', async () => {
    const user = userEvent.setup();
    const answers: Array<() => void> = [];
    const onDelete = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          answers.push(resolve);
        }),
    );
    render(
      <ConversationHistorySheet
        open
        onOpenChange={() => undefined}
        conversations={CONVS}
        activeId='c1'
        onPick={() => undefined}
        {...NOOPS}
        onDelete={onDelete}
      />,
    );

    // Delete c2, walk away, delete c1, walk away, come back to c2.
    await user.click(screen.getByTestId('conversation-menu-c2'));
    await user.click(await screen.findByTestId('conversation-delete-c2'));
    await user.click(await screen.findByTestId('conversation-delete-confirm'));
    await user.click(screen.getByTestId('conversation-delete-cancel'));
    await user.click(screen.getByTestId('conversation-menu-c1'));
    await user.click(await screen.findByTestId('conversation-delete-c1'));
    await user.click(await screen.findByTestId('conversation-delete-confirm'));
    await user.click(screen.getByTestId('conversation-delete-cancel'));
    await user.click(screen.getByTestId('conversation-menu-c2'));
    await user.click(await screen.findByTestId('conversation-delete-c2'));

    const confirm = await screen.findByTestId('conversation-delete-confirm');
    expect(confirm).toHaveAttribute('aria-busy', 'true');
    // c1's answer does not end c2's wait.
    await act(async () => {
      answers[1]?.();
    });
    expect(confirm).toHaveAttribute('aria-busy', 'true');
    await act(async () => {
      answers[0]?.();
    });
    expect(screen.queryByTestId('conversation-delete-dialog')).toBeNull();
  });
});

// inner#1440: a row's name only changes once the store does, which is after
// the server has answered, so the row shows what was committed until then.
describe('the name shown after a row rename is committed', () => {
  /**
   * Renders the sheet with the given rename handler and renames c2.
   * @param onRename - The handler the sheet calls.
   * @param name - What to type.
   */
  async function renameRow(
    onRename: (id: string, title: string) => Promise<void>,
    name: string,
  ): Promise<void> {
    const user = userEvent.setup();
    render(
      <ConversationHistorySheet
        open
        onOpenChange={() => undefined}
        conversations={CONVS}
        activeId='c1'
        onPick={() => undefined}
        {...NOOPS}
        onRename={onRename}
      />,
    );
    await user.click(screen.getByTestId('conversation-menu-c2'));
    await user.click(await screen.findByTestId('conversation-rename-c2'));
    const box = await screen.findByTestId('conversation-rename-input');
    await user.clear(box);
    await user.type(box, `${name}{Enter}`);
  }

  it('shows the new name while the row still holds the old one', async () => {
    await renameRow(() => new Promise<void>(() => undefined), 'Villain arc');
    expect(screen.getByTestId('conversation-open-c2')).toHaveTextContent('Villain arc');
  });

  it('goes back to the row name when the rename is refused', async () => {
    let refuse: (reason: Error) => void = () => undefined;
    await renameRow(() => new Promise<void>((_, reject) => { refuse = reject; }), 'Villain arc');
    await act(async () => { refuse(new Error('refused')); });
    expect(screen.getByTestId('conversation-open-c2')).toHaveTextContent('Character design');
  });
});
