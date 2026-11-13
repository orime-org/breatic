// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import * as React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { t } from '@breatic/shared';
import type { ChatSendAnswer, ChatSyncAnswer } from '@breatic/shared';

const toastSpy = vi.hoisted(() => ({ error: vi.fn(), warning: vi.fn() }));
vi.mock('@web/lib/toast', () => ({ toast: { error: toastSpy.error, warning: toastSpy.warning, success: vi.fn(), info: vi.fn() } }));
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type * as ChatApiModule from '@web/data/api/chat';

vi.mock('@web/data/api/chat', async (importOriginal) => {
  const actual = await importOriginal<typeof ChatApiModule>();
  return {
    ...actual,
    chatApi: {
      streamConfig: vi.fn(async () => ({ heartbeatIntervalMs: 5000, attachmentMaxChars: 200_000, attachmentMaxItems: 10, currentSpaceMaxChars: 100_000, spaceListMaxItems: 200, spaceReadTimeoutMs: 20_000, runningPollIntervalMs: 5000, syncIntervalMs: 3_000 })),
      openChat: vi.fn(),
      messagesBefore: vi.fn(),
      renameConversation: vi.fn(),
      deleteConversation: vi.fn(),
      listConversations: vi.fn(),
      readConversation: vi.fn(),
      createConversation: vi.fn(),
      models: vi.fn(async () => ({ models: [{ id: 'deepseek/deepseek-v4.1-flash-1017', name: 'DeepSeek V4.1 Flash' }], lastUsed: 'deepseek/deepseek-v4.1-flash-1017' })),
      setModel: vi.fn(),
      running: vi.fn(),
      sync: vi.fn(),
      sendMessage: vi.fn(),
      stop: vi.fn(),
      removeQueued: vi.fn(),
      streamPath: actual.chatApi.streamPath,
    },
  };
});

vi.mock('@web/data/upload/transfer-body', () => ({
  bodyOrTransfer: async (_projectId: string, body: unknown) => body,
}));

import { chatApi } from '@web/data/api/chat';
import { ApiException } from '@web/data/api/types';
import { ChatPanel } from '@web/pages/project/chat/ChatPanel';
import { conversationRuntime, _resetForTests } from '@web/stores/conversation-runtime';
import { evictAllChatSessions } from '@web/stores/chat-sessions';
import { resetChatLiveForTests } from '@web/stores/chat-live';
import { resetRunOnceForTests } from '@web/stores/task-actions-in-flight';
import { chatAttachments, type TrayItem } from '@web/stores/chat-attachments';
import { replyOpens, stubRunWire } from '@web/test-utils/chat-run-wire';
import type { RunWire } from '@web/test-utils/chat-run-wire';
import { expectNoA11yViolations } from '@web/test-utils/a11y';

const LIMITS = { maxItems: 10, maxChars: 200_000 };
const READY_NOTE: TrayItem = {
  id: 'n-1',
  name: 'note',
  type: 'text',
  status: 'ready',
  chip: { id: 'n-1', type: 'text', name: 'note', data_snapshot: { text: 'hi' } },
};
const UPLOADING_FILE: TrayItem = { id: 'f-1', name: 'cover.png', type: 'image', status: 'uploading' };

/** The conversation every case in this file is opened into. */
const CONV = 'c1';

/** A sync answered while nothing holds the conversation. */
const IDLE: ChatSyncAnswer = { pending: [], running: false, awaiting: false, next_sync_ms: 3000 };

/** A send the server answered by opening a run for it. */
const STARTED: ChatSendAnswer = { status: 'start', pending: [], running: true };

/**
 * Answer the run routes the page asks while a conversation is on screen
 * (inner#1717): nothing holds it, a send opens a run, and its history read
 * again is the page the last open answered with.
 */
function answerRunRoutes(): void {
  vi.mocked(chatApi.readConversation).mockImplementation(async (id) => {
    const opened = vi.mocked(chatApi.openChat).mock.results.at(-1);
    const answer = opened === undefined ? undefined : ((await opened.value) as Awaited<ReturnType<typeof chatApi.openChat>>);
    return (answer?.current ?? { conversation: { id }, messages: [], hasMore: false }) as Awaited<ReturnType<typeof chatApi.readConversation>>;
  });
  vi.mocked(chatApi.sync).mockResolvedValue(IDLE);
  vi.mocked(chatApi.sendMessage).mockResolvedValue(STARTED);
  vi.mocked(chatApi.stop).mockResolvedValue({ stopped: true });
  vi.mocked(chatApi.running).mockResolvedValue([]);
}

afterEach(() => {
  resetChatLiveForTests();
  resetRunOnceForTests();
  evictAllChatSessions();
});

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
        activeSpace={undefined}
        spaces={[]}
        {...rest}
      />
    </QueryClientProvider>,
  );
}

/** The run streams the page reads. */
let wire: RunWire;

/**
 * Have the server refuse the next message, in the envelope
 * `middleware/error-handler.ts` writes, as axios hands it over.
 * @param status - The status.
 * @param message - The sentence the server wrote for the user.
 */
function theMessageIsRefused(status: number, message: string): void {
  vi.mocked(chatApi.sendMessage).mockRejectedValueOnce(new ApiException({ status, message, fromServer: true }));
}

/**
 * Have every send never reach the server: no answer at all. Syncs are spaced
 * an hour apart, so running the re-sends out does not also run thousands of
 * syncs.
 */
function theRequestNeverLeaves(): void {
  vi.mocked(chatApi.sync).mockResolvedValue({ ...IDLE, next_sync_ms: 3_600_000 });
  vi.mocked(chatApi.sendMessage).mockRejectedValue(
    new ApiException({ status: 0, message: 'Network error', network: true, fromServer: false }),
  );
}

/**
 * Hold the next send's answer until the case gives it.
 * @returns Gives the answer.
 */
function holdTheAnswer(): (answer?: ChatSendAnswer) => void {
  let give: (answer: ChatSendAnswer) => void = () => undefined;
  vi.mocked(chatApi.sendMessage).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        give = resolve;
      }),
  );
  return (answer = STARTED) => {
    give(answer);
  };
}

/**
 * Start the reply on the run's stream the page attached to.
 * @param text - The reply's first piece.
 */
function theReplyStartsArriving(text: string): void {
  for (const chunk of replyOpens()) wire.last()?.push(chunk);
  wire.last()?.push({ type: 'text-delta', id: 't1', delta: text });
}

/**
 * Answer the open call with a conversation carrying the given messages.
 * @param texts - What has been said in it, in order
 */
function chatOpensWith(texts: string[]): void {
  vi.mocked(chatApi.openChat).mockResolvedValue({
    conversations: [{ id: 'c1' }],
    current: {
      conversation: { id: 'c1', agentModel: { id: 'deepseek/deepseek-v4.1-flash-1017', name: 'DeepSeek V4.1 Flash' } },
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

/**
 * Press send with fake timers running, so a re-send's waits can be run out.
 */
function pressSend(): void {
  act(() => {
    fireEvent.click(screen.getByTestId('chat-composer-send'));
  });
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
    wire = stubRunWire();
    chatOpensWith([]);
    answerRunRoutes();
    vi.mocked(chatApi.streamConfig).mockResolvedValue({ heartbeatIntervalMs: 5000, attachmentMaxChars: 200_000, attachmentMaxItems: 10, currentSpaceMaxChars: 100_000, spaceListMaxItems: 200, spaceReadTimeoutMs: 20_000, runningPollIntervalMs: 5000, syncIntervalMs: 3_000 });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
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
    await user.type(screen.getByTestId('chat-composer-box'), 'Hi!');
    expect(conversationRuntime.draftOf(CONV)).toBe('Hi!');
  });

  it('sends the trimmed draft, and empties the box when the server has it', async () => {
    const user = userEvent.setup();
    const answer = holdTheAnswer();
    renderPanel();
    await waitFor(() => expect(chatApi.openChat).toHaveBeenCalled());

    conversationRuntime.setDraft(CONV, '  test  ');
    await user.click(screen.getByTestId('chat-composer-send'));

    await waitFor(() => {
      expect(vi.mocked(chatApi.sendMessage).mock.calls[0]?.[0]).toMatchObject({ message: 'test', conversation_id: 'c1' });
    });
    // Still in the box, because so far nothing has confirmed it went anywhere.
    // Emptying it now is a promise the browser is in no position to make: the
    // words would be gone from the only place they exist, with nothing on
    // screen to show for them.
    expect(conversationRuntime.draftOf(CONV)).toBe('  test  ');
    // And nothing to press: not send again, and not stop.
    expect(screen.getByTestId('chat-composer-sending')).toBeInTheDocument();

    act(() => {
      answer();
    });

    // The server holds the message: the box is empty now.
    await waitFor(() => expect(conversationRuntime.draftOf(CONV)).toBe(''));
    await waitFor(() => expect(wire.last()).not.toBeNull());
    act(() => {
      theReplyStartsArriving('Sure');
    });

    // And while the run answers, stop is there to press.
    await waitFor(() => expect(screen.getByTestId('chat-composer-abort')).toBeInTheDocument());
  });

  it('sends what is attached beside the words, and clears it when the server has it', async () => {
    const user = userEvent.setup();
    const answer = holdTheAnswer();
    renderPanel();
    await waitFor(() => expect(chatApi.openChat).toHaveBeenCalled());
    chatAttachments.add(CONV, [READY_NOTE], LIMITS);

    conversationRuntime.setDraft(CONV, 'look at this');
    await user.click(screen.getByTestId('chat-composer-send'));

    await waitFor(() => {
      expect(vi.mocked(chatApi.sendMessage).mock.calls[0]?.[0]).toMatchObject({ attached_chips: [READY_NOTE.chip] });
    });
    // Still above the box until the server has taken the message.
    expect(chatAttachments.trayOf(CONV)).toHaveLength(1);

    act(() => {
      answer();
    });

    await waitFor(() => expect(chatAttachments.trayOf(CONV)).toEqual([]));
  });

  it('keeps what is attached when the message is refused', async () => {
    const user = userEvent.setup();
    theMessageIsRefused(422, 'no');
    renderPanel();
    await waitFor(() => expect(chatApi.openChat).toHaveBeenCalled());
    chatAttachments.add(CONV, [READY_NOTE], LIMITS);

    conversationRuntime.setDraft(CONV, 'look at this');
    await user.click(screen.getByTestId('chat-composer-send'));

    await waitFor(() => expect(toastSpy.error).toHaveBeenCalled());
    expect(chatAttachments.trayOf(CONV)).toHaveLength(1);
  });

  it('will not send while an attached file is still uploading', async () => {
    renderPanel();
    await waitFor(() => expect(chatApi.openChat).toHaveBeenCalled());
    act(() => {
      chatAttachments.add(CONV, [UPLOADING_FILE], LIMITS);
      conversationRuntime.setDraft(CONV, 'look at this');
    });

    expect(screen.getByTestId('chat-composer-send')).toBeDisabled();
  });

  it('shows each attached item above the box, and takes one out on its remove button', async () => {
    const user = userEvent.setup();
    renderPanel();
    await waitFor(() => expect(chatApi.openChat).toHaveBeenCalled());
    act(() => {
      chatAttachments.add(CONV, [READY_NOTE], LIMITS);
    });

    expect(screen.getByTestId('chat-chip-n-1')).toHaveTextContent('note');
    await user.click(screen.getByRole('button', { name: /note/ }));

    expect(chatAttachments.trayOf(CONV)).toEqual([]);
  });

  it('takes nothing into the box while the server has not answered', async () => {
    const user = userEvent.setup();
    const answer = holdTheAnswer();
    renderPanel();
    await waitFor(() => expect(chatApi.openChat).toHaveBeenCalled());

    conversationRuntime.setDraft(CONV, 'first question');
    await user.click(screen.getByTestId('chat-composer-send'));
    await waitFor(() => {
      expect(chatApi.sendMessage).toHaveBeenCalled();
    });

    // The box shows what was sent and accepts nothing more, so there is never
    // a moment where it holds one sentence of ours and another of theirs.
    const box = screen.getByTestId('chat-composer-box');
    expect(box).toHaveAttribute('contenteditable', 'false');
    expect(box).toHaveAttribute('aria-readonly', 'true');
    await user.type(box, ' and one more thing');
    expect(conversationRuntime.draftOf(CONV)).toBe('first question');

    act(() => {
      answer();
    });

    // And then it is emptied, with no rule applied to the text: only one
    // thing could have been in it.
    await waitFor(() => expect(conversationRuntime.draftOf(CONV)).toBe(''));
    expect(screen.getByTestId('chat-composer-box')).toHaveAttribute('contenteditable', 'true');
  });

  it('says so once it gives up on a message that never got an answer', async () => {
    vi.useFakeTimers();
    theRequestNeverLeaves();
    renderPanel();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(chatApi.openChat).toHaveBeenCalled();

    act(() => {
      conversationRuntime.setDraft(CONV, 'shorten this');
    });
    pressSend();
    // Sent again under the same id until the server can be asked no longer
    // (WB-08, WB-08e); nothing is said while it is.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(toastSpy.error).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(25 * 60 * 60 * 1000);
    });

    // No answer came back, so there is nothing to quote: the user is told it
    // could not be confirmed.
    expect(toastSpy.error).toHaveBeenCalledWith(t('common.runOnce.unknownResult'));
  });

  it('says it again when it fails again, in the same words', async () => {
    const user = userEvent.setup();
    theMessageIsRefused(403, 'You do not have access to this project');
    theMessageIsRefused(403, 'You do not have access to this project');
    renderPanel();
    await waitFor(() => expect(chatApi.openChat).toHaveBeenCalled());

    conversationRuntime.setDraft(CONV, 'is anyone there');
    await user.click(screen.getByTestId('chat-composer-send'));
    await waitFor(() => expect(toastSpy.error).toHaveBeenCalledTimes(1));

    // Straight away, while the first line is still up -- which is when a
    // user presses again, not four seconds later.
    await user.click(screen.getByTestId('chat-composer-send'));

    // Same words, said again: the toast is told twice, which refreshes the
    // one on screen rather than leaving the second failure unsaid.
    await waitFor(() => expect(toastSpy.error).toHaveBeenCalledTimes(2));
    expect(toastSpy.error.mock.calls[1]?.[0]).toBe(toastSpy.error.mock.calls[0]?.[0]);
    // Two presses, two requests. A second one swallowed is "it looks
    // pressable, and pressing it does nothing".
    expect(chatApi.sendMessage).toHaveBeenCalledTimes(2);
  });

  it('says what the server said when it refused', async () => {
    const user = userEvent.setup();
    theMessageIsRefused(403, 'You do not have access to this project');
    renderPanel();
    await waitFor(() => expect(chatApi.openChat).toHaveBeenCalled());

    conversationRuntime.setDraft(CONV, 'let me in');
    await user.click(screen.getByTestId('chat-composer-send'));

    // The server went to the trouble of saying why, in the user's language.
    await waitFor(() =>
      expect(toastSpy.error).toHaveBeenCalledWith('You do not have access to this project'),
    );
  });

  it('says it in a toast and draws nothing of its own in the panel', async () => {
    vi.mocked(chatApi.openChat).mockRejectedValue(new Error('server said no'));
    renderPanel();

    // A chat that would not open used to have its own red bar at the top of
    // the panel. Two places that say things is one too many: the user has
    // to learn where to look, and the two can disagree.
    await waitFor(() => expect(toastSpy.error).toHaveBeenCalled());
    expect(screen.queryByTestId('chat-open-failed')).not.toBeInTheDocument();
    expect(screen.queryAllByRole('alert')).toHaveLength(0);
  });

  it('says one thing about a chat that would not open, and offers nothing', async () => {
    vi.mocked(chatApi.openChat).mockRejectedValue(new Error('offline'));
    renderPanel();

    await waitFor(() =>
      expect(toastSpy.error).toHaveBeenCalledWith('Network error'),
    );
    // No button, no instruction. Reloading or trying again is the user's own
    // business, and telling them to do it adds nothing they cannot see.
  });

  it('keeps the keyboard on the box when the chat it waited for opens', async () => {
    let land: (() => void) | undefined;
    vi.mocked(chatApi.openChat).mockImplementation(
      () =>
        new Promise((res) => {
          land = (): void =>
            res({
              conversations: [{ id: CONV }],
              hasMoreConversations: false,
              current: { conversation: { id: CONV, agentModel: { id: 'deepseek/deepseek-v4.1-flash-1017', name: 'DeepSeek V4.1 Flash' } }, messages: [], hasMore: false },
            } as never);
        }),
    );
    renderPanel();
    await waitFor(() => expect(chatApi.openChat).toHaveBeenCalled());
    const waiting = screen.getByTestId('chat-composer-box');
    act(() => waiting.focus());

    await act(async () => {
      land?.();
      await Promise.resolve();
    });
    await waitFor(() =>
      expect(screen.getByTestId('chat-composer-box')).toHaveAttribute('contenteditable', 'true'),
    );

    expect(screen.getByTestId('chat-composer-box')).toBe(waiting);
    expect(document.activeElement).toBe(waiting);
  });

  it('holds the box still until the chat has opened', async () => {
    // No typing while it opens (user 2026-08-16): there is no conversation on
    // screen yet, and words typed now would have nowhere to go. The box is
    // `readOnly`, not `disabled`, so that is what is asked.
    let land: (() => void) | undefined;
    vi.mocked(chatApi.openChat).mockImplementation(
      () =>
        new Promise((res) => {
          land = (): void =>
            res({
              conversations: [{ id: CONV }],
              hasMoreConversations: false,
              current: { conversation: { id: CONV, agentModel: { id: 'deepseek/deepseek-v4.1-flash-1017', name: 'DeepSeek V4.1 Flash' } }, messages: [], hasMore: false },
            } as never);
        }),
    );
    renderPanel();

    await waitFor(() => expect(chatApi.openChat).toHaveBeenCalled());
    expect(screen.getByTestId('chat-composer-box')).toHaveAttribute('aria-readonly', 'true');

    await act(async () => {
      land?.();
      await Promise.resolve();
    });

    await waitFor(() =>
      expect(screen.getByTestId('chat-composer-box')).toHaveAttribute('contenteditable', 'true'),
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
      expect(toastSpy.error).toHaveBeenCalledWith('Network error'),
    );

    expect(screen.getByTestId('chat-composer-box')).not.toBeDisabled();
  });

  it('keeps what the user typed when the chat could not be opened', async () => {
    const user = userEvent.setup();
    vi.mocked(chatApi.openChat).mockRejectedValue(new Error('server said no'));
    renderPanel();

    await waitFor(() => expect(toastSpy.error).toHaveBeenCalled());

    conversationRuntime.setDraft(CONV, 'please do not eat this');
    await user.click(screen.getByTestId('chat-composer-send'));

    // Clearing the draft on a send that never happened is how the words were
    // lost: nothing was sent, and there was nothing left to send again.
    expect(conversationRuntime.draftOf(CONV)).toBe('please do not eat this');
  });

  it('leaves the words where they are when the message never got an answer', async () => {
    vi.useFakeTimers();
    theRequestNeverLeaves();
    renderPanel();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    act(() => {
      conversationRuntime.setDraft(CONV, 'is anyone there');
    });
    pressSend();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(25 * 60 * 60 * 1000);
    });

    // Nothing was stored and nothing of the attempt is on screen, so the box
    // is the only place these words exist. They are still in it because the
    // one thing that empties it -- the server's answer -- never came.
    expect(screen.queryByTestId('chat-composer-sending')).toBeNull();
    expect(conversationRuntime.draftOf(CONV)).toBe('is anyone there');
  });
});

describe('a conversation longer than one page', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    _resetForTests();
    answerRunRoutes();
    vi.mocked(chatApi.openChat).mockResolvedValue({
      conversations: [{ id: 'c1' }],
      current: {
        conversation: { id: 'c1', agentModel: { id: 'deepseek/deepseek-v4.1-flash-1017', name: 'DeepSeek V4.1 Flash' } },
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

  it('spins on the load-earlier button until the page lands', async () => {
    let land: (value: Awaited<ReturnType<typeof chatApi.messagesBefore>>) => void = () => undefined;
    vi.mocked(chatApi.messagesBefore).mockImplementation(
      () =>
        new Promise((resolve) => {
          land = resolve;
        }),
    );

    renderPanel();
    const button = await screen.findByTestId('chat-load-earlier');
    await userEvent.click(button);

    expect(button).toHaveAttribute('aria-busy', 'true');
    expect(button).toHaveAttribute('aria-disabled', 'true');

    await act(async () => {
      land({ messages: [], hasMore: true } as unknown as Awaited<
        ReturnType<typeof chatApi.messagesBefore>
      >);
    });
    await waitFor(() => expect(button).not.toHaveAttribute('aria-busy'));
  });

  it('stops spinning on the load-earlier button when the page fails to arrive', async () => {
    let fail: (err: Error) => void = () => undefined;
    vi.mocked(chatApi.messagesBefore).mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          fail = reject;
        }),
    );

    renderPanel();
    const button = await screen.findByTestId('chat-load-earlier');
    await userEvent.click(button);
    expect(button).toHaveAttribute('aria-busy', 'true');

    await act(async () => {
      fail(new Error('offline'));
    });
    await waitFor(() => expect(button).not.toHaveAttribute('aria-busy'));
  });
});


describe('a failure about a row in the list', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetForTests();
    answerRunRoutes();
  });

  /**
   * Answer the open call so the panel reaches its ready state.
   * @returns Nothing.
   */
  function opens(): void {
    vi.mocked(chatApi.openChat).mockResolvedValue({
      conversations: [{ id: 'c-1', title: 'one' }],
      current: { conversation: { id: 'c-1', title: 'one', agentModel: { id: 'deepseek/deepseek-v4.1-flash-1017', name: 'DeepSeek V4.1 Flash' } }, messages: [], hasMore: false },
      hasMoreConversations: false,
    } as unknown as Awaited<ReturnType<typeof chatApi.openChat>>);
  }

  it('is told in a toast while the list is closed', async () => {
    // The header can rename too, while the list is closed. A line drawn only
    // in the list would go unseen: where it is said follows what the user can
    // see now, not where they pressed.
    opens();
    renderPanel({ projectId: 'p1', historyOpen: false });
    await waitFor(() => expect(screen.getByTestId('chat-panel')).toBeInTheDocument());

    vi.mocked(chatApi.renameConversation).mockRejectedValue(new Error('offline'));
    await act(async () => {
      await expect(conversationRuntime.rename('p1', 'c-1', 'a new name')).rejects.toThrow('offline');
    });

    await waitFor(() => expect(toastSpy.error).toHaveBeenCalled());
  });

  it('is told in a toast while the list is open', async () => {
    opens();
    renderPanel({ projectId: 'p1', historyOpen: true });
    await waitFor(() => expect(screen.getByTestId('conversation-history-sheet')).toBeInTheDocument());

    vi.mocked(chatApi.renameConversation).mockRejectedValue(new Error('offline'));
    await act(async () => {
      await expect(conversationRuntime.rename('p1', 'c-1', 'a new name')).rejects.toThrow('offline');
    });

    await waitFor(() => expect(toastSpy.error).toHaveBeenCalled());
  });

  it('draws nothing at all while the conversation is still on its way', async () => {
    // The empty conversation's greeting says this conversation has no
    // messages, which cannot be said before it arrives -- it may have a screen
    // of history on its way. Drawn now, the user's own history would flash
    // past as if it never existed.
    let land: (() => void) | undefined;
    vi.mocked(chatApi.openChat).mockImplementation(
      () =>
        new Promise((res) => {
          land = (): void =>
            res({
              conversations: [{ id: 'c-1', title: 'one' }],
              current: {
                conversation: { id: 'c-1', title: 'one', agentModel: { id: 'deepseek/deepseek-v4.1-flash-1017', name: 'DeepSeek V4.1 Flash' } },
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
    // The skeleton shows after 300 milliseconds, and most answers are back
    // before that. Drawn and taken away at once reads as a flicker, not as
    // "loading".
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
    // If nothing on the page changes after "+", the user can only read the
    // button as broken. This line is its only answer, and the list cannot say
    // it: pressing "+" closes the list.
    opens();
    renderPanel({ projectId: 'p1', historyOpen: false });
    await waitFor(() => expect(screen.getByTestId('chat-panel')).toBeInTheDocument());

    vi.mocked(chatApi.createConversation).mockRejectedValue(new Error('offline'));
    await act(async () => {
      await conversationRuntime.startNew('p1');
    });

    await waitFor(() => expect(toastSpy.error).toHaveBeenCalled());
  });
});

describe('opening the list', () => {
  beforeEach(() => {
    answerRunRoutes();
  });

  it('fetches its first page again', async () => {
    // Decided: every opening loads the list again from the top. The store and
    // the list each have tests, and the wire between them breaking turns
    // nothing red -- the list still draws, only what was left last time.
    vi.mocked(chatApi.openChat).mockResolvedValue({
      conversations: [{ id: 'c-1', title: 'one' }],
      current: { conversation: { id: 'c-1', title: 'one', agentModel: { id: 'deepseek/deepseek-v4.1-flash-1017', name: 'DeepSeek V4.1 Flash' } }, messages: [], hasMore: false },
      hasMoreConversations: false,
    } as unknown as Awaited<ReturnType<typeof chatApi.openChat>>);
    vi.mocked(chatApi.listConversations).mockResolvedValue({
      conversations: [{ id: 'c-1', title: 'one' }],
      hasMore: false,
    } as unknown as Awaited<ReturnType<typeof chatApi.listConversations>>);

    const { rerender } = render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <ChatPanel projectId='p-open' historyOpen={false} onHistoryOpenChange={() => undefined} activeSpace={undefined} spaces={[]} />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(chatApi.openChat).toHaveBeenCalled());
    expect(chatApi.listConversations).not.toHaveBeenCalled();

    rerender(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <ChatPanel projectId='p-open' historyOpen onHistoryOpenChange={() => undefined} activeSpace={undefined} spaces={[]} />
      </QueryClientProvider>,
    );

    await waitFor(() => expect(chatApi.listConversations).toHaveBeenCalledTimes(1));
  });
});

describe('deleting a conversation from the list', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    _resetForTests();
    answerRunRoutes();
    vi.mocked(chatApi.streamConfig).mockResolvedValue({ heartbeatIntervalMs: 5000, attachmentMaxChars: 200_000, attachmentMaxItems: 10, currentSpaceMaxChars: 100_000, spaceListMaxItems: 200, spaceReadTimeoutMs: 20_000, runningPollIntervalMs: 5000 , syncIntervalMs: 3_000});
    vi.mocked(chatApi.openChat).mockResolvedValue({
      conversations: [
        { id: 'c-1', title: 'one' },
        { id: 'c-2', title: 'two' },
      ],
      current: { conversation: { id: 'c-1', title: 'one', agentModel: { id: 'deepseek/deepseek-v4.1-flash-1017', name: 'DeepSeek V4.1 Flash' } }, messages: [], hasMore: false },
      hasMoreConversations: false,
    } as unknown as Awaited<ReturnType<typeof chatApi.openChat>>);
    vi.mocked(chatApi.listConversations).mockResolvedValue({
      conversations: [
        { id: 'c-1', title: 'one' },
        { id: 'c-2', title: 'two' },
      ],
      hasMore: false,
    } as unknown as Awaited<ReturnType<typeof chatApi.listConversations>>);
  });

  /**
   * Open the list, ask to delete the second row, and confirm.
   * @returns The confirm button, pressed.
   */
  async function confirmDeletingTheSecondRow(): Promise<HTMLElement> {
    renderPanel({ projectId: 'p-del', historyOpen: true });
    await userEvent.click(await screen.findByTestId('conversation-menu-c-2'));
    await userEvent.click(await screen.findByTestId('conversation-delete-c-2'));
    const confirm = await screen.findByTestId('conversation-delete-confirm');
    await userEvent.click(confirm);
    return confirm;
  }

  it('keeps the question open and spinning until the server answers, then closes', async () => {
    let done: () => void = () => undefined;
    vi.mocked(chatApi.deleteConversation).mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          done = resolve;
        }) as unknown as ReturnType<typeof chatApi.deleteConversation>,
    );

    const confirm = await confirmDeletingTheSecondRow();

    expect(screen.getByTestId('conversation-delete-dialog')).toBeInTheDocument();
    expect(confirm).toHaveAttribute('aria-busy', 'true');
    expect(confirm).toHaveAttribute('aria-disabled', 'true');

    await act(async () => {
      done();
    });
    await waitFor(() =>
      expect(screen.queryByTestId('conversation-delete-dialog')).toBeNull(),
    );
  });

  it('closes the question once a failed delete is answered, and says so', async () => {
    let fail: (err: Error) => void = () => undefined;
    vi.mocked(chatApi.deleteConversation).mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          fail = reject;
        }) as unknown as ReturnType<typeof chatApi.deleteConversation>,
    );

    const confirm = await confirmDeletingTheSecondRow();
    expect(confirm).toHaveAttribute('aria-busy', 'true');

    await act(async () => {
      fail(new Error('offline'));
    });
    await waitFor(() =>
      expect(screen.queryByTestId('conversation-delete-dialog')).toBeNull(),
    );
    expect(toastSpy.error).toHaveBeenCalled();
  });
});
