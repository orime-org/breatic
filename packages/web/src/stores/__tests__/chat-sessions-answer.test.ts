// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The user's answer to a questionnaire (inner#1542), as it goes since the run
 * belongs to the server (inner#1717).
 *
 * An answer is a request of its own, `POST /chat/message` with no words and
 * the answer beside them. It leaves the box alone. When the server says a run
 * resumed, the page reads the history back (which holds the answered card)
 * and attaches to the run, whose reply carries on the paused one. A card the
 * server says was already answered is drawn as the server holds it; any other
 * refusal leaves the card waiting and tells the server's sentence.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('@web/data/upload/transfer-body', () => ({
  bodyOrTransfer: async (_projectId: string, body: unknown) => body,
}));

import type { ChatSendAnswer, ChatSyncAnswer } from '@breatic/shared';
import { chatApi } from '@web/data/api/chat';
import type { ConversationRead, StoredUiMessage } from '@web/data/api/chat';
import { ApiException } from '@web/data/api/types';
import { chatSessionFor, evictAllChatSessions } from '@web/stores/chat-sessions';
import { chatLive, resetChatLiveForTests } from '@web/stores/chat-live';
import { conversationRuntime } from '@web/stores/conversation-runtime';
import { watchChatMishaps, type ChatMishap } from '@web/stores/chat-mishaps';
import { replyEnds, replyOpens, settle, storesWhatIsDrawn, stubRunWire, type RunWire } from '@web/test-utils/chat-run-wire';

const IDLE: ChatSyncAnswer = { pending: [], running: false, awaiting: false, next_sync_ms: 3000 };
const ANSWERS = [{ index: 0, selected: ['9:16'] }];

/**
 * The paused conversation as the server stores it.
 * @param ask - The questionnaire call as it stands.
 * @returns The messages, oldest first.
 */
function paused(ask: Record<string, unknown> = { state: 'input-available' }): StoredUiMessage[] {
  return [
    { id: 'u-1', role: 'user', parts: [{ type: 'text', text: 'make me a poster' }], metadata: { turnIndex: 1, ts: '' } },
    {
      id: 'a-1',
      role: 'assistant',
      parts: [
        { type: 'text', text: 'Two things first.' },
        { type: 'tool-ask_user', toolCallId: 'ask-1', input: { questions: [] }, ...ask },
        { type: 'data-ask-awaiting', data: { toolCallId: 'ask-1' } },
      ] as StoredUiMessage['parts'],
      metadata: { turnIndex: 1, ts: '' },
    },
  ];
}

/** The stored conversation once the answer resumed it. */
const ANSWERED = paused({ state: 'output-available', output: { answers: ANSWERS } });

/**
 * The newest page of history.
 * @param messages - What it holds.
 * @returns The answer.
 */
function page(messages: StoredUiMessage[]): ConversationRead {
  return { conversation: { id: 'c-1' } as never, messages, hasMore: false };
}

/**
 * A refusal as axios hands it over.
 * @param status - The HTTP status.
 * @param details - The server's `error` body.
 * @returns The exception.
 */
function refused(status: number, details: Record<string, unknown> = {}): ApiException {
  return new ApiException({ status, message: 'Refused.', fromServer: true, details });
}

/**
 * What the server answers a message or an answer with.
 * @param running - Whether a run holds the conversation.
 * @returns The answer.
 */
function started(running = true): ChatSendAnswer {
  return { status: 'start', pending: [], running };
}

let wire: RunWire;
let told: ChatMishap[];
let unwatch: () => void;

/**
 * The paused conversation's session.
 * @returns It.
 */
function pausedChat(): ReturnType<typeof chatSessionFor> {
  return chatSessionFor({ projectId: 'p-1', conversationId: 'c-1', history: paused(), onTitled: () => undefined });
}

/**
 * The `ask_user` part in the session's messages.
 * @param chat - The session.
 * @returns The part.
 */
function askPart(chat: ReturnType<typeof chatSessionFor>): Record<string, unknown> | undefined {
  return chat.messages.flatMap((m) => m.parts).find((p) => (p as { toolCallId?: string }).toolCallId === 'ask-1') as
    | Record<string, unknown>
    | undefined;
}

/**
 * Answer the questionnaire.
 * @returns When the answer is settled.
 */
function answerIt(): Promise<void> {
  return chatLive.answerCard({
    projectId: 'p-1',
    conversationId: 'c-1',
    toolCallId: 'ask-1',
    card: { answer: { toolCallId: 'ask-1', answers: ANSWERS } },
    spaces: {},
  });
}

/**
 * The bodies sent, in order.
 * @returns Each body.
 */
function bodies(): Array<Record<string, unknown>> {
  return vi.mocked(chatApi.sendMessage).mock.calls.map((c) => c[0] as Record<string, unknown>);
}

beforeEach(async () => {
  wire = stubRunWire();
  vi.spyOn(chatApi, 'streamConfig').mockResolvedValue({
    heartbeatIntervalMs: 600_000, attachmentMaxChars: 200_000, attachmentMaxItems: 10, currentSpaceMaxChars: 100_000,
    spaceListMaxItems: 200, spaceReadTimeoutMs: 20_000, runningPollIntervalMs: 5000, syncIntervalMs: 3000,
  });
  vi.spyOn(chatApi, 'readConversation').mockResolvedValue(page(paused()));
  vi.spyOn(chatApi, 'sync').mockResolvedValue(IDLE);
  vi.spyOn(chatApi, 'sendMessage').mockResolvedValue(started());
  told = [];
  unwatch = watchChatMishaps((m) => told.push(m));
  chatLive.show('p-1', 'c-1');
  await settle();
});

afterEach(() => {
  unwatch();
  resetChatLiveForTests();
  evictAllChatSessions();
  vi.restoreAllMocks();
});

describe('answering a card', () => {
  it('sends the answer and no words, and leaves the box and the list as they were', async () => {
    const chat = pausedChat();
    conversationRuntime.setDraft('c-1', 'half a thought');
    vi.mocked(chatApi.readConversation).mockResolvedValue(page(ANSWERED));

    await answerIt();
    await settle();

    expect(bodies().at(-1)).toMatchObject({
      message: '',
      conversation_id: 'c-1',
      answer: { toolCallId: 'ask-1', answers: ANSWERS },
    });
    expect(chat.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(conversationRuntime.draftOf('c-1')).toBe('half a thought');
  });

  it('draws the card answered from the store, and what the run says next as a reply of its own after it', async () => {
    // The server stores a resumed run's reply as a row of its own after the
    // reply that asked, and reads the answer back on the card.
    const chat = pausedChat();
    vi.mocked(chatApi.readConversation).mockResolvedValue(page(ANSWERED));

    await answerIt();
    await settle();
    const s = wire.last()!;
    storesWhatIsDrawn(() => chat.messages, 'c-1');
    for (const f of replyOpens('t')) s.push(f);
    s.push({ type: 'text-delta', id: 't', delta: 'Here is the plan.' });
    for (const f of replyEnds('t')) s.push(f);
    s.close();
    await settle();

    expect(chat.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'assistant']);
    expect(chat.messages[1]?.id).toBe('a-1');
    expect(askPart(chat)).toMatchObject({ state: 'output-available', output: { answers: ANSWERS } });
    expect(chat.messages[2]?.parts.at(-1)).toMatchObject({ type: 'text', text: 'Here is the plan.' });
  });

  it('draws what the store holds when the card was already answered elsewhere, and says nothing', async () => {
    const chat = pausedChat();
    vi.mocked(chatApi.sendMessage).mockRejectedValueOnce(
      refused(409, { code: 409, call: { status: 'success', output: { repliedInChat: true } } }),
    );

    await answerIt();

    expect(askPart(chat)).toMatchObject({ state: 'output-available', output: { repliedInChat: true } });
    expect(chat.messages[1]?.parts.some((p) => p.type === 'data-failed')).toBe(false);
    expect(told).toEqual([]);
  });

  it('leaves the card waiting when the answer is refused, and says why', async () => {
    const chat = pausedChat();
    vi.mocked(chatApi.sendMessage).mockRejectedValueOnce(refused(402));

    await answerIt();

    expect(askPart(chat)).toMatchObject({ state: 'input-available' });
    expect(chat.messages[1]?.parts.some((p) => p.type === 'data-failed')).toBe(false);
    expect(told).toContainEqual(expect.objectContaining({ conversationId: 'c-1', kind: 'server', message: 'Refused.' }));
  });
});

describe('writing a message instead of answering', () => {
  it('shows the card it closed as replied to and adds one reply for the run when the frames arrive in the order the server writes them', async () => {
    // A named conversation's run opens with its title, then the cards the
    // message closed, then the model's reply under the server's own id.
    const chat = pausedChat();
    vi.mocked(chatApi.readConversation).mockResolvedValue(
      page([
        ...paused(),
        { id: 'u-2', role: 'user', parts: [{ type: 'text', text: 'never mind, something else' }], metadata: { turnIndex: 2, ts: '' } },
      ]),
    );

    await chatLive.send({ projectId: 'p-1', conversationId: 'c-1', words: 'never mind, something else', chips: [], spaces: {} });
    await settle();
    const s = wire.last()!;
    storesWhatIsDrawn(() => chat.messages, 'c-1');
    s.push({ type: 'data-conversation-titled', data: { title: 'Poster' } });
    s.push({ type: 'data-ask-replied', data: { toolCallId: 'ask-1' } });
    s.push({ type: 'start', messageId: 'named-by-the-server' });
    s.push({ type: 'text-start', id: 't' });
    s.push({ type: 'text-delta', id: 't', delta: 'Sure.' });
    s.push({ type: 'text-end', id: 't' });
    s.push({ type: 'finish' });
    s.close();
    await settle();

    expect(chat.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(askPart(chat)).toMatchObject({ state: 'output-available', output: { repliedInChat: true } });
  });
});
