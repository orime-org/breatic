// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * A row in the conversation list, and the two things that can be done to it.
 *
 * The sibling file covers the relative-time buckets and the sheet's own
 * rendering. This one is about the row: what it says when the conversation has
 * no name, what pressing it does, and what pressing the menu on it does
 * instead.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import {
  ConversationHistorySheet,
  type ConversationRow,
} from '@web/pages/project/chat/ConversationHistorySheet';

const ROWS: ConversationRow[] = [
  {
    id: 'c1',
    title: 'Main plot research',
    updatedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
  },
  {
    id: 'c2',
    title: null,
    updatedAt: new Date(Date.now() - 26 * 3_600_000).toISOString(),
  },
];

/**
 * Render the sheet open, with every handler a spy.
 * @param over - Props to override on top of the defaults.
 * @returns The spies, so a case can assert on what was called.
 */
function renderSheet(over: Partial<React.ComponentProps<typeof ConversationHistorySheet>> = {}) {
  const onPick = vi.fn();
  const onRename = vi.fn();
  const onDelete = vi.fn();
  const onStartNew = vi.fn();
  render(
    <ConversationHistorySheet
      open
      onOpenChange={vi.fn()}
      conversations={ROWS}
      activeId='c1'
      onPick={onPick}
      onRename={onRename}
      onDelete={onDelete}
      onStartNew={onStartNew}
      hasMore={false}
      onReachEnd={vi.fn()}
      nextPageFailed={false}
      {...over}
    />,
  );
  return { onPick, onRename, onDelete, onStartNew };
}

describe('what a row says', () => {
  it('shows the name a conversation has', () => {
    renderSheet();
    expect(screen.getByText('Main plot research')).toBeInTheDocument();
  });

  it('stands in for a conversation with no name of its own', () => {
    // The server stores null rather than a placeholder, because the reader's
    // language is known here and nowhere else.
    renderSheet();
    const row = screen.getByTestId('conversation-c2');
    expect(within(row).getByTestId('conversation-untitled')).toBeInTheDocument();
  });
});

describe('pressing a row', () => {
  it('picks that conversation', async () => {
    // The row's own region, which takes everything but the menu. Whether a
    // press on the blank part of the row lands there is a question of layout,
    // and jsdom has none -- that half is checked in the browser.
    const { onPick } = renderSheet();
    await userEvent.click(screen.getByTestId('conversation-open-c2'));
    expect(onPick).toHaveBeenCalledWith('c2');
  });

  it('does not pick it when the press was on its menu', async () => {
    // Opening the menu on a row the reader is not in must not take them to it:
    // they came to rename or delete it, not to read it.
    const { onPick } = renderSheet();
    await userEvent.click(screen.getByTestId('conversation-menu-c2'));
    expect(onPick).not.toHaveBeenCalled();
  });
});

describe('naming a conversation from its row', () => {
  it('turns the row into a box and hands over what was typed', async () => {
    const { onRename } = renderSheet();

    await userEvent.click(screen.getByTestId('conversation-menu-c2'));
    await userEvent.click(await screen.findByTestId('conversation-rename-c2'));

    const box = await screen.findByTestId('conversation-rename-input');
    await userEvent.clear(box);
    await userEvent.type(box, 'Storyboard notes{Enter}');

    expect(onRename).toHaveBeenCalledWith('c2', 'Storyboard notes');
  });

  it('keeps the name to itself when the reader presses Escape', async () => {
    const { onRename } = renderSheet();

    await userEvent.click(screen.getByTestId('conversation-menu-c2'));
    await userEvent.click(await screen.findByTestId('conversation-rename-c2'));
    const box = await screen.findByTestId('conversation-rename-input');
    await userEvent.type(box, 'never mind{Escape}');

    expect(onRename).not.toHaveBeenCalled();
    expect(screen.queryByTestId('conversation-rename-input')).not.toBeInTheDocument();
  });

  it('refuses a name of nothing but spaces', async () => {
    const { onRename } = renderSheet();

    await userEvent.click(screen.getByTestId('conversation-menu-c1'));
    await userEvent.click(await screen.findByTestId('conversation-rename-c1'));
    const box = await screen.findByTestId('conversation-rename-input');
    await userEvent.clear(box);
    await userEvent.type(box, '   {Enter}');

    expect(onRename).not.toHaveBeenCalled();
  });
});

describe('deleting a conversation from its row', () => {
  it('asks first, and deletes once the reader says so', async () => {
    const { onDelete } = renderSheet();

    await userEvent.click(screen.getByTestId('conversation-menu-c2'));
    await userEvent.click(await screen.findByTestId('conversation-delete-c2'));

    // Nothing has gone yet: this is destructive and irreversible, which is the
    // one shape in this repo that always asks.
    expect(onDelete).not.toHaveBeenCalled();
    await userEvent.click(await screen.findByTestId('conversation-delete-confirm'));
    expect(onDelete).toHaveBeenCalledWith('c2');
  });

  it('deletes nothing when the reader backs out', async () => {
    const { onDelete } = renderSheet();

    await userEvent.click(screen.getByTestId('conversation-menu-c2'));
    await userEvent.click(await screen.findByTestId('conversation-delete-c2'));
    await userEvent.click(await screen.findByTestId('conversation-delete-cancel'));

    expect(onDelete).not.toHaveBeenCalled();
  });
});

describe('starting one from the sheet', () => {
  it('has an entry for it at the top', async () => {
    const { onStartNew } = renderSheet();
    await userEvent.click(screen.getByTestId('conversation-start-new'));
    expect(onStartNew).toHaveBeenCalled();
  });
});

describe('the shape of a row', () => {
  it('puts no button inside another button', () => {
    // The menu trigger renders a button, and so does the row. Nesting them is
    // invalid markup that browsers reparent, and the click behaviour that
    // comes out of it differs between them.
    renderSheet();
    for (const button of screen.getAllByRole('button')) {
      expect(button.querySelector('button')).toBeNull();
    }
  });
});

describe('backing out of a rename', () => {
  it('leaves the list open', async () => {
    // Escape 在这里的意思是「不改了」，只该撤销这一次改名。这一按若继续冒泡，
    // 抽屉自己的关闭机制会收到它，读者连会话列表一起失去，要重新打开。
    const onOpenChange = vi.fn();
    renderSheet({ onOpenChange });

    await userEvent.click(screen.getByTestId('conversation-menu-c2'));
    await userEvent.click(await screen.findByTestId('conversation-rename-c2'));

    const box = await screen.findByTestId('conversation-rename-input');
    box.focus();
    await userEvent.keyboard('{Escape}');

    expect(screen.queryByTestId('conversation-rename-input')).toBeNull();
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });
});

describe('reaching the end of the list', () => {
  let fire: (() => void) | undefined;

  beforeEach(() => {
    // jsdom 没有 IntersectionObserver。这个替身把回调存下来，让用例自己决定
    // 「末尾进入视野」是什么时候发生的。
    fire = undefined;
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        constructor(cb: (entries: Array<{ isIntersecting: boolean }>) => void) {
          fire = () => cb([{ isIntersecting: true }]);
        }
        observe(): void {}
        disconnect(): void {}
      },
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('asks for the next page', () => {
    const onReachEnd = vi.fn();
    renderSheet({ hasMore: true, onReachEnd });

    fire?.();

    expect(onReachEnd).toHaveBeenCalled();
  });

  it('asks for nothing once the list has run out', () => {
    const onReachEnd = vi.fn();
    renderSheet({ hasMore: false, onReachEnd });

    // 列完了就没有观察者，末尾进入视野也不该有人被叫。
    fire?.();

    expect(onReachEnd).not.toHaveBeenCalled();
  });
});
