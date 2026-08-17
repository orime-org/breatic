// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * The agent column: its header, its chat, and the scrim over both.
 *
 * What is pinned here is the part neither the header nor the panel can answer
 * for on its own -- what the column shows when its conversations cannot be
 * read, and what the header says about the conversation on screen.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('@web/data/api/chat', () => ({
  chatApi: {
    openChat: vi.fn(),
    streamMessage: vi.fn(() => new Promise<void>(() => {})),
    messagesBefore: vi.fn(),
    readConversation: vi.fn(),
    createConversation: vi.fn(),
    renameConversation: vi.fn(),
    deleteConversation: vi.fn(),
  },
}));

import { TooltipProvider } from '@web/components/ui/tooltip';
import { chatApi } from '@web/data/api/chat';
import { AgentColumn } from '@web/pages/project/chrome/AgentColumn';
import { _resetForTests, useConversationRuntime } from '@web/stores/conversation-runtime';

const PROJECT = 'p-1';

/**
 * Render the column under a tooltip provider, the way the app does.
 *
 * The app has exactly one, on `App.tsx`; a test that renders a subtree has to
 * stand in for it. This is the one place a second provider is allowed.
 * @returns The render result.
 */
function renderColumn(): ReturnType<typeof render> {
  return render(
    <TooltipProvider>
      <AgentColumn projectId={PROJECT} />
    </TooltipProvider>,
  );
}

/**
 * Answer the open call with a list and the one that is current.
 * @param conversations - The list as the server would give it.
 */
function opensWith(conversations: Array<{ id: string; title: string | null }>): void {
  vi.mocked(chatApi.openChat).mockResolvedValue({
    conversations,
    current: {
      conversation: conversations[0],
      messages: [],
      hasMore: false,
    },
  } as unknown as Awaited<ReturnType<typeof chatApi.openChat>>);
}

describe('when the conversations cannot be read', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetForTests();
  });

  it('covers the column, header included', async () => {
    // With no list, the entries in the header have nothing to act on. Leaving
    // them reachable would be putting up buttons whose only outcome is to
    // fail again.
    vi.mocked(chatApi.openChat).mockRejectedValue(new Error('offline'));
    renderColumn();

    const scrim = await screen.findByTestId('chat-unreachable');
    const column = screen.getByTestId('agent-column');
    expect(column).toContainElement(scrim);
    expect(within(column).getByTestId('agent-col-header')).toBeInTheDocument();
  });

  it('takes what it covers out of the tab order', async () => {
    // 一层只挡像素的蒙版，Tab 照样走得进它底下的按钮，而其中一个按钮打开的
    // 抽屉 portal 到 body、层级在蒙版之上 —— 于是「被挡住的东西」画在蒙版上面
    // 并且完全可用。「不可操作」要成立，被盖的内容必须真的退出 tab 序。
    vi.mocked(chatApi.openChat).mockRejectedValue(new Error('offline'));
    renderColumn();
    await screen.findByTestId('chat-unreachable');

    const header = screen.getByTestId('agent-col-header');
    expect(header.closest('[inert]')).not.toBeNull();
  });

  it('gives the reader one thing to do about it', async () => {
    vi.mocked(chatApi.openChat).mockRejectedValue(new Error('offline'));
    renderColumn();
    await screen.findByTestId('chat-unreachable');
    vi.mocked(chatApi.openChat).mockClear();

    await userEvent.click(screen.getByTestId('chat-reload'));

    expect(chatApi.openChat).toHaveBeenCalled();
  });

  it('says what went wrong in the language the reader is reading', async () => {
    vi.mocked(chatApi.openChat).mockRejectedValue(new Error('offline'));
    renderColumn();

    const scrim = await screen.findByTestId('chat-unreachable');
    // Not the English the server would have sent: the placeholder and the
    // reason are both chosen here, where the language is known.
    expect(scrim).toHaveTextContent('Network error');
  });
});

describe('when they can', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetForTests();
  });

  it('shows nothing over the column', async () => {
    opensWith([{ id: 'c-1', title: 'Storyboard notes' }]);
    renderColumn();

    await waitFor(() => expect(screen.getByTestId('agent-col-header')).toBeInTheDocument());
    expect(screen.queryByTestId('chat-unreachable')).toBeNull();
  });

  it('names the conversation on screen in the header', async () => {
    opensWith([{ id: 'c-1', title: 'Storyboard notes' }]);
    renderColumn();

    await waitFor(() =>
      expect(screen.getByTestId('agent-col-header')).toHaveTextContent('Storyboard notes'),
    );
  });

  it('stands in for one that has no name yet', async () => {
    opensWith([{ id: 'c-1', title: null }]);
    renderColumn();

    await waitFor(() =>
      expect(screen.getByTestId('agent-col-header')).toHaveTextContent(
        'Untitled conversation',
      ),
    );
  });

  it('takes a name that reads exactly like the stand-in', async () => {
    // 会话还没名字时顶栏显示的那句话是个替身,不是它的名字。用户偏要给它取
    // 这个名,那也是一次命名 —— 拿屏幕上的字去比对,这次命名就被丢掉了,而
    // 屏幕上什么都不会变,用户看不出自己刚才做的事没算数。
    opensWith([{ id: 'c-1', title: null }]);
    vi.mocked(chatApi.renameConversation).mockResolvedValue(undefined as never);
    const user = userEvent.setup();
    renderColumn();
    await waitFor(() => expect(screen.getByTestId('agent-col-header')).toBeInTheDocument());

    await user.dblClick(within(screen.getByTestId('agent-col-header')).getByTestId('title-display'));
    await user.type(await screen.findByTestId('title-input'), 'Untitled conversation');
    await user.keyboard('{Enter}');

    await waitFor(() =>
      expect(chatApi.renameConversation).toHaveBeenCalledWith(
        'c-1',
        PROJECT,
        'Untitled conversation',
      ),
    );
  });

  it('counts the conversations, not the messages', async () => {
    // 分页之后手上这份数组的长度不是总数,而这个数本来就不必显示。
    opensWith([
      { id: 'c-1', title: 'one' },
      { id: 'c-2', title: 'two' },
      { id: 'c-3', title: null },
    ]);
    renderColumn();

    await waitFor(() => expect(screen.getByTestId('agent-col-header')).toBeInTheDocument());
    expect(screen.queryByTestId('conversation-count-chip')).toBeNull();
  });
});

describe('a history sheet left open when the list goes unreadable', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetForTests();
  });

  it('is closed rather than left floating above the scrim', async () => {
    // 抽屉 portal 到 body,而蒙版的 inert 只沿它自己那棵树生效 —— 一个已经
    // 打开的抽屉会浮在蒙版之上照常可用,而这一列正声称完全不可操作。
    let failOpen: (() => void) | undefined;
    vi.mocked(chatApi.openChat).mockImplementation(
      () => new Promise((_r, reject) => (failOpen = () => reject(new Error('offline')))),
    );
    renderColumn();

    await userEvent.click(await screen.findByTestId('open-conversation-history'));
    expect(screen.getByTestId('conversation-history-sheet')).toBeInTheDocument();

    failOpen?.();
    await screen.findByTestId('chat-unreachable');

    await waitFor(() =>
      expect(screen.queryByTestId('conversation-history-sheet')).toBeNull(),
    );
  });

  it('closes the list when the same button is pressed again', async () => {
    // 这个按钮说的是「开关」,不是「打开」。抽屉是非模态的,所以按在它上面先被
    // 判成「点了抽屉外面」把抽屉关掉,紧接着按钮自己的 click 又把它打开 —— 读者
    // 按了一下什么也没发生,而且多打了一次整份列表的请求。
    renderColumn();

    await userEvent.click(await screen.findByTestId('open-conversation-history'));
    expect(screen.getByTestId('conversation-history-sheet')).toBeInTheDocument();

    await userEvent.click(screen.getByTestId('open-conversation-history'));

    await waitFor(() =>
      expect(screen.queryByTestId('conversation-history-sheet')).toBeNull(),
    );
  });
});

describe('the header while the conversation is still on its way', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetForTests();
  });

  it('says nothing about a name it does not have yet', async () => {
    // 「未命名对话」是一句断言:这条会话没有名字。会话还没到手时说不出这句话
    // —— 它可能有名字,只是还没到。消息区在这一刻什么都不画(D6),顶栏是同一
    // 条不变量的另一半。
    vi.mocked(chatApi.openChat).mockImplementation(() => new Promise(() => {}));
    renderColumn();

    await waitFor(() => expect(screen.getByTestId('agent-col-header')).toBeInTheDocument());

    expect(screen.getByTestId('agent-col-header')).not.toHaveTextContent('Untitled conversation');
  });
});

describe('the header when the list no longer holds the conversation on screen', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetForTests();
  });

  it('still calls it by its name', async () => {
    // 打开列表会重取第一页,而当前这条很久没用过、不在那一页里。名字是会话
    // 自己的属性,不该跟着一页列表一起消失 —— 顶栏说它「未命名」是在陈述一件
    // 假的事。
    opensWith([{ id: 'c-1', title: 'Storyboard notes' }]);
    renderColumn();
    await waitFor(() =>
      expect(screen.getByTestId('agent-col-header')).toHaveTextContent('Storyboard notes'),
    );

    act(() => {
      useConversationRuntime.setState((s) => ({
        listByProject: { ...s.listByProject, [PROJECT]: [] },
      }));
    });

    expect(screen.getByTestId('agent-col-header')).toHaveTextContent('Storyboard notes');
  });
});
