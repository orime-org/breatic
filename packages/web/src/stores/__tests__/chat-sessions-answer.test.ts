// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The reader's answer to a questionnaire, sent through the conversation's own
 * session (inner#1542).
 *
 * An answer resumes the turn that asked, so it goes out the way the SDK's own
 * human-in-the-loop does: `sendMessage()` with no message, carrying on the
 * paused reply. What only makes sense for a typed message -- emptying the box,
 * reading the words and attachments off the last message, marking a refused
 * turn's reply as failed -- is left out for it.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { StoredUiMessage } from '@web/data/api/chat';

const tell = vi.fn();
vi.mock('@web/stores/chat-mishaps', () => ({ tell: (...args: unknown[]) => tell(...args) }));
vi.mock('@web/data/api/chat', () => ({ chatApi: { streamConfig: async () => ({ heartbeatIntervalMs: 600_000 }) } }));

const { answerInSession, chatSessionFor, evictAllChatSessions, sendInSession } = await import('@web/stores/chat-sessions');

/** What the paused reply holds: a card waiting on the reader. */
const PAUSED: StoredUiMessage[] = [
  { id: 'u-1', role: 'user', parts: [{ type: 'text', text: 'make me a poster' }], metadata: { turnIndex: 1, ts: '' } },
  {
    id: 'a-1',
    role: 'assistant',
    parts: [
      { type: 'text', text: 'Two things first.' },
      { type: 'tool-ask_user', toolCallId: 'ask-1', state: 'input-available', input: { questions: [] } },
      { type: 'data-ask-awaiting', data: { toolCallId: 'ask-1' } },
    ] as StoredUiMessage['parts'],
    metadata: { turnIndex: 1, ts: '' },
  },
];
const ANSWERS = [{ index: 0, selected: ['9:16'] }];

/**
 * A stream the server answers with.
 * @param chunks - Its chunks, in order.
 * @returns The response.
 */
function streaming(chunks: Array<Record<string, unknown>>): Response {
  const body = `${chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('')}data: [DONE]\n\n`;
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

/**
 * The server refusing before any stream, in its own envelope.
 * @param status - The status.
 * @param extra - What the body carries beside the envelope.
 * @returns The response.
 */
function refused(status: number, extra: Record<string, unknown> = {}): Response {
  return new Response(JSON.stringify({ error: { code: status, message: 'Refused.' }, ...extra }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

let answer: () => Response;
const sent: Array<Record<string, unknown>> = [];
const original = globalThis.fetch;
const firstFrames = vi.fn();

beforeEach(() => {
  evictAllChatSessions();
  tell.mockClear();
  firstFrames.mockClear();
  sent.length = 0;
  globalThis.fetch = ((_url: string, init?: RequestInit) => {
    sent.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return Promise.resolve(answer());
  }) as typeof globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = original;
});

/**
 * The paused conversation's session.
 * @returns It.
 */
function pausedChat(): ReturnType<typeof chatSessionFor> {
  return chatSessionFor({
    projectId: 'p-1',
    conversationId: 'c-1',
    history: structuredClone(PAUSED),
    onTitled: () => undefined,
    onFirstFrame: firstFrames,
  });
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

describe('answering a card', () => {
  it('sends the answer and no words, and leaves the box and the list as they were', async () => {
    answer = () => streaming([{ type: 'tool-output-available', toolCallId: 'ask-1', output: { answers: ANSWERS } }]);
    const chat = pausedChat();
    await answerInSession('c-1', 'ask-1', ANSWERS);

    expect(sent.at(-1)).toMatchObject({
      message: '',
      attached_chips: [],
      conversation_id: 'c-1',
      answer: { toolCallId: 'ask-1', answers: ANSWERS },
    });
    expect(chat.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(firstFrames).not.toHaveBeenCalled();
  });

  it('carries on the paused reply: the card is answered and what the turn says next follows it there', async () => {
    answer = () =>
      streaming([
        { type: 'tool-output-available', toolCallId: 'ask-1', output: { answers: ANSWERS } },
        { type: 'start' },
        { type: 'start-step' },
        { type: 'text-start', id: 't' },
        { type: 'text-delta', id: 't', delta: 'Here is the plan.' },
        { type: 'text-end', id: 't' },
        { type: 'finish-step' },
        { type: 'finish' },
      ]);
    const chat = pausedChat();
    await answerInSession('c-1', 'ask-1', ANSWERS);

    expect(chat.messages.map((m) => m.id)).toEqual(['u-1', 'a-1']);
    expect(askPart(chat)).toMatchObject({ state: 'output-available', output: { answers: ANSWERS } });
    expect(chat.messages[1]?.parts.at(-1)).toMatchObject({ type: 'text', text: 'Here is the plan.' });
  });

  it('draws what the store holds when the card was already answered elsewhere, and says nothing', async () => {
    answer = () => refused(409, { call: { status: 'success', output: { repliedInChat: true } } });
    const chat = pausedChat();
    await answerInSession('c-1', 'ask-1', ANSWERS);

    expect(askPart(chat)).toMatchObject({ state: 'output-available', output: { repliedInChat: true } });
    expect(chat.messages[1]?.parts.some((p) => p.type === 'data-failed')).toBe(false);
    expect(tell).not.toHaveBeenCalled();
  });

  it('leaves the card waiting when the answer is refused, and says why', async () => {
    answer = () => refused(402);
    const chat = pausedChat();
    await answerInSession('c-1', 'ask-1', ANSWERS);

    expect(askPart(chat)).toMatchObject({ state: 'input-available' });
    expect(chat.messages[1]?.parts.some((p) => p.type === 'data-failed')).toBe(false);
    expect(tell).toHaveBeenCalledWith(expect.objectContaining({ conversationId: 'c-1', kind: 'server', message: 'Refused.' }));
  });
});

describe('writing a message instead of answering', () => {
  it('shows the card it closed as replied to, in the earlier reply', async () => {
    answer = () =>
      streaming([
        { type: 'data-ask-replied', data: { toolCallId: 'ask-1' } },
        { type: 'start' },
        { type: 'text-start', id: 't' },
        { type: 'text-delta', id: 't', delta: 'Sure.' },
        { type: 'text-end', id: 't' },
        { type: 'finish' },
      ]);
    const chat = pausedChat();
    await sendInSession('c-1', 'never mind, something else');

    expect(askPart(chat)).toMatchObject({ state: 'output-available', output: { repliedInChat: true } });
  });
});
