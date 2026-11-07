// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The user's answer to a request to look at Spaces, sent through the
 * conversation's own session (inner#1552, design 4.4).
 *
 * It goes out the way a questionnaire answer does: no message of the
 * user's, the paused reply carried on, one request at a time on a
 * conversation. The body carries `shared_spaces` beside the usual Space
 * context and goes through the same over-the-limit transfer as any turn. A
 * refused answer is said and leaves the card waiting; one the server says
 * was already settled is drawn as the server holds it.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { StoredUiMessage } from '@web/data/api/chat';

const tell = vi.fn();
const bodyOrTransfer = vi.fn(async (_projectId: string, body: unknown) => body);
vi.mock('@web/stores/chat-mishaps', () => ({ tell: (...args: unknown[]) => tell(...args) }));
vi.mock('@web/data/api/chat', () => ({ chatApi: { streamConfig: async () => ({ heartbeatIntervalMs: 600_000 }) } }));
vi.mock('@web/data/upload/transfer-body', () => ({
  bodyOrTransfer: (projectId: string, body: unknown) => bodyOrTransfer(projectId, body),
}));

const { chatSessionFor, evictAllChatSessions, sendInSession, shareSpacesInSession } = await import('@web/stores/chat-sessions');

const INPUT = { reason: 'To answer about the cast.', spaces: [{ id: 'c1' }] };

/** What the paused reply holds: a request card waiting on the user. */
const PAUSED: StoredUiMessage[] = [
  { id: 'u-1', role: 'user', parts: [{ type: 'text', text: 'what do the characters wear?' }], metadata: { turnIndex: 1, ts: '' } },
  {
    id: 'a-1',
    role: 'assistant',
    parts: [
      { type: 'text', text: 'Let me look first.' },
      { type: 'tool-request_space_content', toolCallId: 'req-1', state: 'input-available', input: INPUT },
      { type: 'data-ask-awaiting', data: { toolCallId: 'req-1' } },
    ] as StoredUiMessage['parts'],
    metadata: { turnIndex: 1, ts: '' },
  },
];

const SHARED = {
  toolCallId: 'req-1',
  decision: 'shared' as const,
  spaces: [{ id: 'c1', name: 'Cast', kind: 'canvas' as const, state: 'read' as const, content: '{"nodes":[],"edges":[]}', total_chars: 23, detail: { selected_total: 0, selected_attached: 0, selected_whole: 0, slim: false, texts_cut: 0, names_only: 0, edges_not_listed: 0, nodes_not_listed: 0, groups_not_listed: 0 } }],
};
const CONTEXT = {
  spaces: [{ id: 'c1', name: 'Cast', kind: 'canvas' as const }, { id: 'd1', name: 'Script', kind: 'document' as const }],
  spaces_total: 2,
  current_space: { id: 'd1', name: 'Script', kind: 'document' as const, state: 'loading' as const },
};

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

beforeEach(() => {
  evictAllChatSessions();
  tell.mockClear();
  bodyOrTransfer.mockClear();
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
    onFirstFrame: () => undefined,
  });
}

/**
 * The request part in the session's messages.
 * @param chat - The session.
 * @returns The part.
 */
function requestPart(chat: ReturnType<typeof chatSessionFor>): Record<string, unknown> | undefined {
  return chat.messages.flatMap((m) => m.parts).find((p) => (p as { toolCallId?: string }).toolCallId === 'req-1') as
    | Record<string, unknown>
    | undefined;
}

describe('answering a request card', () => {
  it('sends shared_spaces with the usual Space context and no words, and leaves the list as it was', async () => {
    answer = () => streaming([{ type: 'tool-output-available', toolCallId: 'req-1', output: { spaces: [{ id: 'c1', name: 'Cast', kind: 'canvas', state: 'read' }] } }]);
    const chat = pausedChat();

    await shareSpacesInSession('c-1', SHARED, CONTEXT);

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      message: '',
      attached_chips: [],
      project_id: 'p-1',
      conversation_id: 'c-1',
      shared_spaces: SHARED,
      ...CONTEXT,
    });
    expect(sent[0]).not.toHaveProperty('answer');
    expect(chat.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
  });

  it('sends a declined answer the same way', async () => {
    answer = () => streaming([{ type: 'tool-output-available', toolCallId: 'req-1', output: { declined: true } }]);
    const chat = pausedChat();

    await shareSpacesInSession('c-1', { toolCallId: 'req-1', decision: 'declined' }, CONTEXT);

    expect(sent[0]).toMatchObject({ message: '', shared_spaces: { toolCallId: 'req-1', decision: 'declined' } });
    expect(requestPart(chat)).toMatchObject({ state: 'output-available', output: { declined: true } });
  });

  it('goes through the over-the-limit transfer, as every turn does', async () => {
    answer = () => streaming([{ type: 'tool-output-available', toolCallId: 'req-1', output: { declined: true } }]);
    pausedChat();

    await shareSpacesInSession('c-1', SHARED, CONTEXT);

    expect(bodyOrTransfer).toHaveBeenCalledTimes(1);
    expect(bodyOrTransfer).toHaveBeenCalledWith('p-1', expect.objectContaining({ shared_spaces: SHARED }));
  });

  it('carries on the paused reply: the card settles and what the turn says next follows it there', async () => {
    answer = () =>
      streaming([
        { type: 'tool-output-available', toolCallId: 'req-1', output: { spaces: [{ id: 'c1', name: 'Cast', kind: 'canvas', state: 'read' }] } },
        { type: 'start', messageId: 'named-by-the-server' },
        { type: 'start-step' },
        { type: 'text-start', id: 't' },
        { type: 'text-delta', id: 't', delta: 'They wear red.' },
        { type: 'text-end', id: 't' },
        { type: 'finish-step' },
        { type: 'finish' },
      ]);
    const chat = pausedChat();

    await shareSpacesInSession('c-1', SHARED, CONTEXT);

    expect(chat.messages.map((m) => m.id)).toEqual(['u-1', 'a-1']);
    expect(requestPart(chat)).toMatchObject({ state: 'output-available', output: { spaces: [{ id: 'c1', state: 'read' }] } });
    expect(chat.messages[1]?.parts.at(-1)).toMatchObject({ type: 'text', text: 'They wear red.' });
  });

  it('draws what the server holds when the card was already settled, and says nothing', async () => {
    answer = () => refused(409, { call: { status: 'success', output: { declined: true } } });
    const chat = pausedChat();

    await shareSpacesInSession('c-1', SHARED, CONTEXT);

    expect(requestPart(chat)).toMatchObject({ state: 'output-available', output: { declined: true } });
    expect(chat.messages[1]?.parts.some((p) => p.type === 'data-failed')).toBe(false);
    expect(tell).not.toHaveBeenCalled();
  });

  it('leaves the card waiting when the answer is refused, and says the server\'s words', async () => {
    answer = () => refused(422);
    const chat = pausedChat();

    await shareSpacesInSession('c-1', SHARED, CONTEXT);

    expect(requestPart(chat)).toMatchObject({ state: 'input-available' });
    expect(chat.messages[1]?.parts.some((p) => p.type === 'data-failed')).toBe(false);
    expect(tell).toHaveBeenCalledWith(expect.objectContaining({ conversationId: 'c-1', kind: 'server', message: 'Refused.' }));
  });
});

describe('a turn already running in the conversation', () => {
  it('takes no answer until it is over, so one request runs at a time', async () => {
    const held = new Promise<Response>(() => undefined);
    globalThis.fetch = ((_url: string, init?: RequestInit) => {
      sent.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return held;
    }) as typeof globalThis.fetch;
    pausedChat();
    void sendInSession('c-1', 'never mind, something else');
    await vi.waitFor(() => expect(sent).toHaveLength(1));

    await shareSpacesInSession('c-1', SHARED, CONTEXT);

    expect(sent).toHaveLength(1);
    expect(sent[0]).not.toHaveProperty('shared_spaces');
  });
});

describe('writing a message instead of answering', () => {
  it('shows the request card it closed as replied to', async () => {
    answer = () =>
      streaming([
        { type: 'data-ask-replied', data: { toolCallId: 'req-1' } },
        { type: 'start', messageId: 'named-by-the-server' },
        { type: 'text-start', id: 't' },
        { type: 'text-delta', id: 't', delta: 'Sure.' },
        { type: 'text-end', id: 't' },
        { type: 'finish' },
      ]);
    const chat = pausedChat();

    await sendInSession('c-1', 'never mind, something else');

    expect(requestPart(chat)).toMatchObject({ state: 'output-available', output: { repliedInChat: true } });
  });
});
