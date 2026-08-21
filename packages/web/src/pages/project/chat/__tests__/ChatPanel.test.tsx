// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import * as React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type * as ChatApiModule from '@web/data/api/chat';

vi.mock('@web/data/api/chat', async (importOriginal) => ({
  ...(await importOriginal<typeof ChatApiModule>()),
  chatApi: {
    streamConfig: vi.fn(async () => ({ heartbeatIntervalMs: 5000 })),
    openChat: vi.fn(),
    messagesBefore: vi.fn(),
    renameConversation: vi.fn(),
    deleteConversation: vi.fn(),
    listConversations: vi.fn(),
    readConversation: vi.fn(),
    createConversation: vi.fn(),
  },
}));

import { chatApi } from '@web/data/api/chat';
import { ChatPanel } from '@web/pages/project/chat/ChatPanel';
import { conversationRuntime, _resetForTests } from '@web/stores/conversation-runtime';
import { evictAllChatSessions } from '@web/stores/chat-sessions';
import { stubChatWire, turnOpens } from '@web/test-utils/chat-wire';
import type { WatchedWire } from '@web/test-utils/chat-wire';

/** The conversation every case in this file is opened into. */
const CONV = 'c1';
import { expectNoA11yViolations } from '@web/test-utils/a11y';

/**
 * Render the panel with a query client of its own.
 * @param props - Props for the panel under test
 * @returns The render result
 */
function renderPanel(
  props: { projectId: string; historyOpen?: boolean } = { projectId: 'p1' },
): ReturnType<typeof render> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const { historyOpen = false, ...rest } = props;
  return render(
    <QueryClientProvider client={client}>
      <ChatPanel
        historyOpen={historyOpen}
        onHistoryOpenChange={() => undefined}
        {...rest}
      />
    </QueryClientProvider>,
  );
}

/** 这一轮的流，用例自己往里推东西。 */
let wire: WatchedWire;

/**
 * 让这一轮被拒。
 *
 * 传输层非 2xx 时抛的是 `new Error(await response.text())` —— body 而已，
 * 状态码不在上面。所以「服务器写了一句给读者的话」是靠信封认出来的：我们的
 * 错误答 `{ error: "..." }`。
 * @param body - 服务器的答复原文。
 * @param status - 状态码。
 */
function theTurnIsRefused(body: string, status = 500): void {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { status })));
}

/** 让这一轮的请求根本没连上，这是「什么都没答」那一种。 */
function theRequestNeverLeft(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))),
  );
}

/**
 * 让这一轮开始流，第一帧到位。
 * @param text - 回复的第一片。
 */
function theReplyStartsArriving(text: string): void {
  for (const chunk of turnOpens()) wire.current()?.push(chunk);
  wire.current()?.push({ type: 'text-delta', id: 't1', delta: text });
}

/**
 * Answer the open call with a conversation carrying the given messages.
 * @param texts - What has been said in it, in order
 */
function chatOpensWith(texts: string[]): void {
  vi.mocked(chatApi.openChat).mockResolvedValue({
    conversations: [{ id: 'c1' }],
    current: {
      conversation: { id: 'c1' },
      messages: texts.map((text, i) => ({
        id: `m${i}`,
        role: i % 2 === 0 ? 'user' : 'assistant',
        parts: [{ type: 'text', text }],
        metadata: { turnIndex: 1, ts: '2026-08-11T00:00:00Z' },
      })),
      hasMore: false,
    },
  } as unknown as Awaited<ReturnType<typeof chatApi.openChat>>);
}

describe('ChatPanel', () => {
  beforeEach(() => {
    // Reset, not clear: an unconsumed `mockImplementationOnce` left by an
    // earlier case survives `clearAllMocks` and fires in the next one.
    vi.resetAllMocks();
    // The conversation runtime is a module singleton, so it carries whatever
    // the last case left in it into the next one.
    _resetForTests();
    evictAllChatSessions();
    wire = stubChatWire();
    chatOpensWith([]);
    vi.mocked(chatApi.streamConfig).mockResolvedValue({ heartbeatIntervalMs: 5000 });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('has no a11y violations', async () => {
    const { container } = renderPanel();
    await expectNoA11yViolations(container);
  });

  it('renders the panel landmark with the projectId attribute', () => {
    renderPanel();
    expect(screen.getByTestId('chat-panel').getAttribute('data-project-id')).toBe('p1');
  });

  it('renders one bubble per message the server sent back', async () => {
    chatOpensWith(['Plan a launch', 'Sure, here is the plan…']);
    renderPanel();

    // Acceptance item 12: what the endpoint returned is what is on screen,
    // one for one.
    await waitFor(() => expect(screen.getAllByTestId('message-bubble')).toHaveLength(2));
  });

  it('typing in the composer writes to the chat store draft', async () => {
    const user = userEvent.setup();
    renderPanel();
    await waitFor(() => expect(chatApi.openChat).toHaveBeenCalled());
    await user.type(screen.getByTestId('chat-composer-textarea'), 'Hi!');
    expect(conversationRuntime.draftOf(CONV)).toBe('Hi!');
  });

  it('sends the trimmed draft, and empties the box when the server has it', async () => {
    const user = userEvent.setup();
    renderPanel();
    await waitFor(() => expect(chatApi.openChat).toHaveBeenCalled());

    conversationRuntime.setDraft(CONV, '  test  ');
    await user.click(screen.getByTestId('chat-composer-send'));

    await waitFor(() => {
      expect(wire.sent()[0]).toMatchObject({ message: 'test', conversation_id: 'c1' });
    });
    // Still in the box, because so far nothing has confirmed it went anywhere.
    // Emptying it now is a promise the browser is in no position to make: the
    // words would be gone from the only place they exist, with nothing on
    // screen to show for them.
    expect(conversationRuntime.draftOf(CONV)).toBe('  test  ');
    // And nothing to press: not send again, and not stop.
    expect(screen.getByTestId('chat-composer-sending')).toBeInTheDocument();

    act(() => {
      theReplyStartsArriving('好的');
    });

    // 服务端接下了这句话并且开始答。现在框空了,而值得按的只剩停止。
    await waitFor(() => expect(conversationRuntime.draftOf(CONV)).toBe(''));
    expect(screen.getByTestId('chat-composer-abort')).toBeInTheDocument();
  });

  it('takes nothing into the box while the server has not answered', async () => {
    const user = userEvent.setup();
    renderPanel();
    await waitFor(() => expect(chatApi.openChat).toHaveBeenCalled());

    conversationRuntime.setDraft(CONV, 'first question');
    await user.click(screen.getByTestId('chat-composer-send'));
    await waitFor(() => {
      expect(wire.current()).not.toBeNull();
    });

    // The box shows what was sent and accepts nothing more, so there is never
    // a moment where it holds one sentence of ours and another of theirs.
    const box = screen.getByTestId('chat-composer-textarea') as HTMLTextAreaElement;
    expect(box.readOnly).toBe(true);
    await user.type(box, ' and one more thing');
    expect(conversationRuntime.draftOf(CONV)).toBe('first question');

    act(() => {
      theReplyStartsArriving('好的');
    });

    // And then it is emptied, with no rule applied to the text: only one
    // thing could have been in it.
    await waitFor(() => expect(conversationRuntime.draftOf(CONV)).toBe(''));
    expect(screen.getByTestId('chat-composer-textarea')).toHaveProperty('readOnly', false);
  });

  it('says so on the composer when the message never went out', async () => {
    const user = userEvent.setup();
    theRequestNeverLeft();
    renderPanel();
    await waitFor(() => expect(chatApi.openChat).toHaveBeenCalled());

    conversationRuntime.setDraft(CONV, 'shorten this');
    await user.click(screen.getByTestId('chat-composer-send'));

    // No answer came back, so there is nothing to quote and nothing to add.
    // Two words: what to do about it is the reader's own business.
    await waitFor(() =>
      expect(screen.getByTestId('chat-notice')).toHaveTextContent('Network error'),
    );
  });

  it('says it again when it fails again, in the same words', async () => {
    const user = userEvent.setup();
    theRequestNeverLeft();
    renderPanel();
    await waitFor(() => expect(chatApi.openChat).toHaveBeenCalled());

    conversationRuntime.setDraft(CONV, 'is anyone there');
    await user.click(screen.getByTestId('chat-composer-send'));
    const firstLine = await screen.findByTestId('chat-notice');

    // Straight away, while the first line is still up -- which is when a
    // reader presses again, not four seconds later.
    await user.click(screen.getByTestId('chat-composer-send'));

    // Same words, so a line left in place is a line React does not touch: the
    // DOM would not move and a screen reader would announce nothing. The
    // second failure has to be its own line.
    await waitFor(() => expect(screen.getByTestId('chat-notice')).not.toBe(firstLine));
    // 两次按下,两次请求。第二次被吞掉就是「看着能按、按下去没反应」。
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2);
  });

  it('says what the server said when it refused', async () => {
    const user = userEvent.setup();
    // 信封照 `middleware/error-handler.ts` 写的那个形状，不是随手编一个。
    theTurnIsRefused(
      '{"error":{"code":403,"message":"You do not have access to this project"}}',
      403,
    );
    renderPanel();
    await waitFor(() => expect(chatApi.openChat).toHaveBeenCalled());

    conversationRuntime.setDraft(CONV, 'let me in');
    await user.click(screen.getByTestId('chat-composer-send'));

    // The server went to the trouble of saying why, in the reader's language.
    await waitFor(() =>
      expect(screen.getByTestId('chat-notice')).toHaveTextContent(
        'You do not have access to this project',
      ),
    );
  });

  it('has one place to say things, not two', async () => {
    vi.mocked(chatApi.openChat).mockRejectedValue(new Error('server said no'));
    renderPanel();

    // A chat that would not open used to have its own red bar at the top of
    // the panel. Two places that say things is one too many: the reader has
    // to learn where to look, and the two can disagree.
    await waitFor(() => expect(screen.getByTestId('chat-notice')).toBeInTheDocument());
    expect(screen.queryByTestId('chat-open-failed')).not.toBeInTheDocument();
    expect(screen.getAllByRole('alert')).toHaveLength(1);
  });

  it('says one thing about a chat that would not open, and offers nothing', async () => {
    vi.mocked(chatApi.openChat).mockRejectedValue(new Error('offline'));
    renderPanel();

    await waitFor(() =>
      expect(screen.getByTestId('chat-notice')).toHaveTextContent('Network error'),
    );
    // No button, no instruction. Reloading or trying again is the reader's own
    // business, and telling them to do it adds nothing they cannot see.
    expect(screen.queryByTestId('chat-notice-action')).not.toBeInTheDocument();
  });

  it('holds the box still until the chat has opened', async () => {
    // 打开期间不能打字(user 2026-08-16 拍定)——屏幕上还没有会话,这一刻打进去
    // 的话没有地方可去。这条测试此前断言的是反过来那条(已被推翻的规则),而且
    // 它问的是 `disabled` 而框用的是 `readOnly`,所以它两头都不会红。
    let land: (() => void) | undefined;
    vi.mocked(chatApi.openChat).mockImplementation(
      () =>
        new Promise((res) => {
          land = (): void =>
            res({
              conversations: [{ id: CONV }],
              hasMoreConversations: false,
              current: { conversation: { id: CONV }, messages: [], hasMore: false },
            } as never);
        }),
    );
    renderPanel();

    await waitFor(() => expect(chatApi.openChat).toHaveBeenCalled());
    expect(screen.getByTestId('chat-composer-textarea')).toHaveAttribute('readonly');

    await act(async () => {
      land?.();
      await Promise.resolve();
    });

    await waitFor(() =>
      expect(screen.getByTestId('chat-composer-textarea')).not.toHaveAttribute('readonly'),
    );
  });

  it('disables nothing of its own when the chat could not be opened', async () => {
    // The panel does not answer for this: what covers the column when its
    // conversations cannot be read is the column's own scrim, one layer up,
    // and it covers the header too. So nothing here is turned off -- there
    // would be no way to reach it anyway.
    vi.mocked(chatApi.openChat).mockRejectedValue(new Error('offline'));
    renderPanel();

    await waitFor(() =>
      expect(screen.getByTestId('chat-notice')).toHaveTextContent('Network error'),
    );

    expect(screen.getByTestId('chat-composer-textarea')).not.toBeDisabled();
  });

  it('keeps what the user typed when the chat could not be opened', async () => {
    const user = userEvent.setup();
    vi.mocked(chatApi.openChat).mockRejectedValue(new Error('server said no'));
    renderPanel();

    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());

    conversationRuntime.setDraft(CONV, 'please do not eat this');
    await user.click(screen.getByTestId('chat-composer-send'));

    // Clearing the draft on a send that never happened is how the words were
    // lost: nothing was sent, and there was nothing left to send again.
    expect(conversationRuntime.draftOf(CONV)).toBe('please do not eat this');
  });

  it('leaves the words where they are when the message never went out', async () => {
    const user = userEvent.setup();
    theRequestNeverLeft();
    renderPanel();
    await waitFor(() => expect(chatApi.openChat).toHaveBeenCalled());
    await waitFor(() =>
      expect(screen.getByTestId('chat-composer-textarea')).not.toBeDisabled(),
    );

    conversationRuntime.setDraft(CONV, 'is anyone there');
    await user.click(screen.getByTestId('chat-composer-send'));

    // Nothing was stored and nothing of the attempt is on screen, so the box
    // is the only place these words exist. They are still in it because the
    // one thing that empties it never happened -- there is no handing back to
    // get wrong, and nothing to get wrong it on top of.
    await waitFor(() =>
      expect(screen.queryByTestId('chat-composer-sending')).toBeNull(),
    );
    expect(conversationRuntime.draftOf(CONV)).toBe('is anyone there');
  });
});

describe('a conversation longer than one page', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    _resetForTests();
    vi.mocked(chatApi.openChat).mockResolvedValue({
      conversations: [{ id: 'c1' }],
      current: {
        conversation: { id: 'c1' },
        messages: [
          {
            id: 'm1',
            role: 'user',
            parts: [{ type: 'text', text: 'the oldest thing on screen' }],
            metadata: { turnIndex: 12, ts: '2026-08-13T00:00:00Z' },
          },
        ],
        hasMore: true,
      },
    } as unknown as Awaited<ReturnType<typeof chatApi.openChat>>);
  });

  it('stops saying it on its own, without waiting to be cleared', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    theRequestNeverLeft();
    renderPanel();
    await waitFor(() => expect(chatApi.openChat).toHaveBeenCalled());

    conversationRuntime.setDraft(CONV, 'shorten this');
    await user.click(screen.getByTestId('chat-composer-send'));
    await waitFor(() => expect(screen.getByTestId('chat-notice')).toBeInTheDocument());

    // It belongs to the moment it happened in, and that moment passes. A line
    // that waited to be cleared would still be standing there when the next
    // thing went wrong, saying the wrong thing about it.
    await act(async () => {
      vi.advanceTimersByTime(5000);
    });
    expect(screen.queryByTestId('chat-notice')).not.toBeInTheDocument();
    vi.useRealTimers();
  });

  it('offers to load what came before, and stops offering once it has', async () => {
    vi.mocked(chatApi.messagesBefore).mockResolvedValue({
      messages: [
        {
          id: 'm0',
          role: 'user',
          parts: [{ type: 'text', text: 'from further back' }],
          metadata: { turnIndex: 4, ts: '2026-08-12T00:00:00Z' },
        },
      ],
      hasMore: false,
    } as unknown as Awaited<ReturnType<typeof chatApi.messagesBefore>>);

    renderPanel();
    // Without this the conversation simply begins in the middle, with nothing
    // on screen saying that what came before it is still there.
    const button = await screen.findByTestId('chat-load-earlier');

    await userEvent.click(button);

    await screen.findByText('from further back');
    // Asked from where the loaded history reaches back to.
    expect(chatApi.messagesBefore).toHaveBeenCalledWith('c1', 12, expect.any(AbortSignal));
    // Nothing older left, so the offer goes away rather than sitting there
    // fetching nothing.
    await waitFor(() => expect(screen.queryByTestId('chat-load-earlier')).toBeNull());
  });
});


describe('where a failure about a row in the list is drawn', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetForTests();
  });

  /**
   * Answer the open call so the panel reaches its ready state.
   * @returns Nothing.
   */
  function opens(): void {
    vi.mocked(chatApi.openChat).mockResolvedValue({
      conversations: [{ id: 'c-1', title: 'one' }],
      current: { conversation: { id: 'c-1', title: 'one' }, messages: [], hasMore: false },
      hasMoreConversations: false,
    } as unknown as Awaited<ReturnType<typeof chatApi.openChat>>);
  }

  it('is drawn in the panel while the list is closed', async () => {
    // 顶栏也能改名,而那时抽屉是关着的。一条只画在抽屉里的提示,读者一个字都
    // 看不到 —— 去向由「读者现在看得见哪儿」定,不由「从哪儿按的」定。
    opens();
    renderPanel({ projectId: 'p1', historyOpen: false });
    await waitFor(() => expect(screen.getByTestId('chat-panel')).toBeInTheDocument());

    vi.mocked(chatApi.renameConversation).mockRejectedValue(new Error('offline'));
    await act(async () => {
      await conversationRuntime.rename('p1', 'c-1', 'a new name');
    });

    await waitFor(() => expect(screen.getByTestId('chat-notice')).toBeInTheDocument());
  });

  it('is drawn in the list while the list is open', async () => {
    opens();
    renderPanel({ projectId: 'p1', historyOpen: true });
    await waitFor(() => expect(screen.getByTestId('conversation-history-sheet')).toBeInTheDocument());

    vi.mocked(chatApi.renameConversation).mockRejectedValue(new Error('offline'));
    await act(async () => {
      await conversationRuntime.rename('p1', 'c-1', 'a new name');
    });

    await waitFor(() =>
      expect(screen.getByTestId('conversation-row-mishap')).toBeInTheDocument(),
    );
    expect(screen.queryByTestId('chat-notice')).toBeNull();
  });

  it('draws nothing at all while the conversation is still on its way', async () => {
    // 空会话的问候语是一句断言:这条会话没有消息。会话还没到手时那句话说不出
    // 口 —— 它可能有一整屏历史,只是还在路上。把它画出来,读者自己的历史就在
    // 眼前闪过去一下,像从来没有过。
    let land: (() => void) | undefined;
    vi.mocked(chatApi.openChat).mockImplementation(
      () =>
        new Promise((res) => {
          land = (): void =>
            res({
              conversations: [{ id: 'c-1', title: 'one' }],
              current: {
                conversation: { id: 'c-1', title: 'one' },
                messages: [],
                hasMore: false,
              },
              hasMoreConversations: false,
            } as never);
        }),
    );
    renderPanel({ projectId: 'p1' });
    await waitFor(() => expect(land).toBeDefined());

    expect(screen.queryByTestId('chat-empty')).toBeNull();

    await act(async () => {
      land?.();
      await Promise.resolve();
    });

    await waitFor(() => expect(screen.getByTestId('chat-empty')).toBeInTheDocument());
  });

  it('says nothing about a wait that is over before it is worth mentioning', async () => {
    // 骨架在 300 毫秒之后才出现,而绝大多数答复在那之前就回来了。立刻画一次
    // 再立刻收走,读作闪了一下,不读作「正在加载」。
    vi.useFakeTimers();
    try {
      vi.mocked(chatApi.openChat).mockImplementation(() => new Promise(() => {}));
      renderPanel({ projectId: 'p1' });

      await act(async () => {
        vi.advanceTimersByTime(299);
      });
      expect(screen.queryByTestId('message-skeleton')).toBeNull();

      await act(async () => {
        vi.advanceTimersByTime(2);
      });
      expect(screen.getByTestId('message-skeleton')).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('says so when a new conversation could not be started', async () => {
    // 「+」按下去之后页面一个字都不变,读者只能理解成这个按钮坏了。这一句是
    // 它唯一的回音,而它落在输入框上方:按「+」的同时抽屉就关掉了,所以列表
    // 那条路走不到。
    opens();
    renderPanel({ projectId: 'p1', historyOpen: false });
    await waitFor(() => expect(screen.getByTestId('chat-panel')).toBeInTheDocument());

    vi.mocked(chatApi.createConversation).mockRejectedValue(new Error('offline'));
    await act(async () => {
      await conversationRuntime.startNew('p1');
    });

    await waitFor(() => expect(screen.getByTestId('chat-notice')).toBeInTheDocument());
  });
});

describe('opening the list', () => {
  it('fetches its first page again', async () => {
    // 拍定的行为是「每次打开都重新全部加载」。store 那侧和抽屉那侧各有测试,
    // 中间这根线断了不会有任何东西红 —— 抽屉照样画,只是画的是上次留下的。
    vi.mocked(chatApi.openChat).mockResolvedValue({
      conversations: [{ id: 'c-1', title: 'one' }],
      current: { conversation: { id: 'c-1', title: 'one' }, messages: [], hasMore: false },
      hasMoreConversations: false,
    } as unknown as Awaited<ReturnType<typeof chatApi.openChat>>);
    vi.mocked(chatApi.listConversations).mockResolvedValue({
      conversations: [{ id: 'c-1', title: 'one' }],
      hasMore: false,
    } as unknown as Awaited<ReturnType<typeof chatApi.listConversations>>);

    const { rerender } = render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <ChatPanel projectId='p-open' historyOpen={false} onHistoryOpenChange={() => undefined} />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(chatApi.openChat).toHaveBeenCalled());
    expect(chatApi.listConversations).not.toHaveBeenCalled();

    rerender(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <ChatPanel projectId='p-open' historyOpen onHistoryOpenChange={() => undefined} />
      </QueryClientProvider>,
    );

    await waitFor(() => expect(chatApi.listConversations).toHaveBeenCalledTimes(1));
  });
});
