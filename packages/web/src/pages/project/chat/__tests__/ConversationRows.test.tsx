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
import { act, render, screen, within, waitFor } from '@testing-library/react';
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
  render(
    <ConversationHistorySheet
      open
      onOpenChange={vi.fn()}
      conversations={ROWS}
      activeId='c1'
      onPick={onPick}
      onRename={onRename}
      onDelete={onDelete}
      hasMore={false}
      onReachEnd={vi.fn()}
      nextPageFailed={false}
      loadingMore={false}
      {...over}
    />,
  );
  return { onPick, onRename, onDelete };
}


/**
 * 渲染抽屉,并留一个能改 props 重渲的口子。
 * @param props - 这次要给的 props。
 * @returns rerender,用来换一组 props 再渲一次。
 */
function renderSheetFor(props: Partial<React.ComponentProps<typeof ConversationHistorySheet>>) {
  const base = {
    open: true,
    onOpenChange: vi.fn(),
    conversations: ROWS,
    activeId: 'c1',
    onPick: vi.fn(),
    onRename: vi.fn(),
    onDelete: vi.fn(),
    hasMore: false,
    onReachEnd: vi.fn(),
    nextPageFailed: false,
    loadingMore: false,
  };
  const result = render(<ConversationHistorySheet {...base} {...props} />);
  return {
    rerender: (over: Partial<React.ComponentProps<typeof ConversationHistorySheet>>): void =>
      result.rerender(<ConversationHistorySheet {...base} {...over} />),
  };
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

describe('the sheet header', () => {
  it('leaves the top right corner to the close button', () => {
    // `SheetContent` 自带一个绝对定位在右上角的关闭按钮。头部再摆一个同尺寸的
    // 按钮就压在它下面 —— 屏幕上只看得见 ×,底下那个鼠标永远够不到,点下去关的
    // 是抽屉。新建的入口在列顶栏,抽屉开着时照样点得到。
    renderSheet();

    expect(screen.queryByTestId('conversation-start-new')).toBeNull();
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

describe('a page that arrives without filling the window', () => {
  let fire: (() => void) | undefined;
  let observeCalls = 0;

  beforeEach(() => {
    fire = undefined;
    observeCalls = 0;
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        constructor(cb: (entries: Array<{ isIntersecting: boolean }>) => void) {
          fire = () => cb([{ isIntersecting: true }]);
        }
        observe(): void {
          // 真的观察者一开始观察就投递一次当前状态。
          observeCalls += 1;
          fire?.();
        }
        disconnect(): void {}
      },
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('asks again while the end is still in view', () => {
    // 一页装不满窗口时,末尾从头到尾都在视野里 —— 而进入视野这件事只发生一次,
    // 之后它就一直在那儿。只认那一次的话,列表停在第二页,而读者滚不动、也没有
    // 别的办法把剩下的拿回来。
    const onReachEnd = vi.fn();
    const { rerender } = renderSheetFor({ hasMore: true, onReachEnd, conversations: ROWS });
    expect(onReachEnd).toHaveBeenCalledTimes(1);

    // 新的一页到手,行数变多,末尾仍在视野里。
    rerender({
      hasMore: true,
      onReachEnd,
      conversations: [...ROWS, { id: 'c9', title: 'just arrived', updatedAt: ROWS[0]!.updatedAt }],
    });

    expect(onReachEnd).toHaveBeenCalledTimes(2);
    expect(observeCalls).toBeGreaterThan(1);
  });
});

describe('while the next page is on its way', () => {
  it('shows that it is coming, at the foot of the list', () => {
    renderSheetFor({ hasMore: true, loadingMore: true });

    expect(screen.getByTestId('conversation-list-loading-more')).toBeInTheDocument();
  });

  it('shows nothing there when nothing is out', () => {
    renderSheetFor({ hasMore: true, loadingMore: false });

    expect(screen.queryByTestId('conversation-list-loading-more')).toBeNull();
  });
});

describe('when the next page cannot be fetched', () => {
  it('says so in the place the loading was, and offers nothing to press', () => {
    // 出错就在它该出现的位置说一句,不是给一个按钮。读者接着往下滑就再拉一次。
    renderSheetFor({ hasMore: true, nextPageFailed: true });

    expect(screen.getByTestId('conversation-list-more-failed')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /重新|reload|retry/i })).toBeNull();
  });

  it('takes the line away on its own', async () => {
    vi.useFakeTimers();
    try {
      renderSheetFor({ hasMore: true, nextPageFailed: true });
      expect(screen.getByTestId('conversation-list-more-failed')).toBeInTheDocument();

      await act(async () => {
        vi.advanceTimersByTime(4000);
      });

      expect(screen.queryByTestId('conversation-list-more-failed')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('what asks for the page again after one failed', () => {
  let fire: (() => void) | undefined;

  beforeEach(() => {
    fire = undefined;
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        constructor(cb: (entries: Array<{ isIntersecting: boolean }>) => void) {
          fire = () => cb([{ isIntersecting: true }]);
        }
        observe(): void {
          // 真的观察者一开始观察就投递一次当前状态。末尾此刻还在视野里,
          // 所以「重建观察者」本身就等于「再问一次」。
          fire?.();
        }
        disconnect(): void {}
      },
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('waits for the reader to reach the end again', () => {
    // 失败之后页面一个像素都没动。要是失败本身就能让观察者重建,重建又立刻
    // 上报「到底了」,请求就会一轮接一轮地打出去,而读者的手指一动没动。
    const onReachEnd = vi.fn();
    const { rerender } = renderSheetFor({ hasMore: true, onReachEnd, nextPageFailed: false });
    const asked = onReachEnd.mock.calls.length;

    rerender({ hasMore: true, onReachEnd, nextPageFailed: true });

    expect(onReachEnd).toHaveBeenCalledTimes(asked);
  });

  it('asks again once the reader scrolls', () => {
    // 这是「接着滑就再拉一次」的字面实现:失败之后盯的不再是「末尾在不在
    // 视野里」(那是个失败改不动的状态),而是一次滚动 —— 只有读者做得出来。
    const onReachEnd = vi.fn();
    renderSheetFor({ hasMore: true, onReachEnd, nextPageFailed: true });
    const asked = onReachEnd.mock.calls.length;

    const viewport = document.querySelector('[data-radix-scroll-area-viewport]');
    viewport!.dispatchEvent(new Event('scroll'));

    expect(onReachEnd).toHaveBeenCalledTimes(asked + 1);
  });

  it('says so in the list, where the reader is looking', () => {
    renderSheetFor({ hasMore: true, onReachEnd: vi.fn(), nextPageFailed: true });

    expect(screen.getByTestId('conversation-list-more-failed')).toBeInTheDocument();
  });

});

describe('when the sheet is taken away mid-confirmation', () => {
  it('takes the delete confirmation with it', async () => {
    // 确认框是抽屉的兄弟、还 portal 到 body,所以关掉抽屉留不下它,盖住这一列
    // 的蒙版也够不着它 —— 它会浮在一个自称完全不可操作的界面上,而按下去
    // 真的会删掉数据。
    const { rerender } = renderSheetFor({});
    await userEvent.click(screen.getByTestId('conversation-menu-c2'));
    await userEvent.click(await screen.findByTestId('conversation-delete-c2'));
    expect(screen.getByTestId('conversation-delete-dialog')).toBeInTheDocument();

    rerender({ open: false });

    await waitFor(() =>
      expect(screen.queryByTestId('conversation-delete-dialog')).toBeNull(),
    );
  });
});

describe('what the list says while it is being fetched', () => {
  it('does not claim the project has no conversations', () => {
    // 「一条都没有」是一句关于事实的断言,而这一刻前端还不知道有没有。读者会
    // 据此关掉列表、以为自己记错了,一两秒后它又自己冒出来 —— 这跟消息区那边
    // 已经堵住的错是同一个,只是换了个面。
    renderSheet({ conversations: [], listLoading: true });

    expect(screen.queryByText('No previous conversations')).toBeNull();
    expect(screen.getByTestId('conversation-list-loading')).toBeInTheDocument();
  });

  it('says so plainly once it knows there are none', () => {
    renderSheet({ conversations: [], listLoading: false });

    expect(screen.getByText('No previous conversations')).toBeInTheDocument();
    expect(screen.queryByTestId('conversation-list-loading')).toBeNull();
  });
});

describe('a rename or a delete that did not work', () => {
  it('says so in the list, where the reader is looking', () => {
    // 这两件事只能从列表里发起,而列表盖住整个 Agent 列 —— 面板底部那条线在
    // 抽屉底下,说什么读者都看不见。
    renderSheet({ rowMishap: { conversationId: 'c2', text: 'Could not rename it' } });

    const said = screen.getByTestId('conversation-row-mishap');
    expect(said).toHaveTextContent('Could not rename it');
    expect(screen.getByTestId('conversation-c2')).toBeInTheDocument();
  });

  it('puts it against the row it is about', () => {
    renderSheet({ rowMishap: { conversationId: 'c2', text: 'Could not rename it' } });

    const said = screen.getByTestId('conversation-row-mishap');
    const row = screen.getByTestId('conversation-c2').closest('li');
    expect(row?.nextElementSibling).toBe(said);
  });
});

describe('a failure about the whole list rather than one row', () => {
  it('is said at the top of it', () => {
    // 重取整份列表失败,说的不是某一行的事 —— 它没有行可贴,而列表顶部正是
    // 这句话该在的地方。
    renderSheet({ rowMishap: { conversationId: null, text: 'Could not fetch the list' } });

    const said = screen.getByTestId('conversation-list-mishap');
    expect(said).toHaveTextContent('Could not fetch the list');
    const list = screen.getByTestId('conversation-history-list');
    expect(list.firstElementChild).toBe(said);
  });
});
