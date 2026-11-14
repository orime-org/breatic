// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The user's answer to a request to look at Spaces (inner#1552, design 4.4),
 * as it goes since the run belongs to the server (inner#1717).
 *
 * It goes out the way a questionnaire answer does: `POST /chat/message` with
 * no words, `shared_spaces` beside the usual Space context, through the same
 * over-the-limit transfer as any message. When a run resumed, the page reads
 * the history back (which holds the settled card) and attaches to the run,
 * whose reply carries on the paused one. A refused answer is said and leaves
 * the card waiting; one the server says was already settled is drawn as the
 * server holds it.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { bodyOrTransfer } = vi.hoisted(() => ({
  bodyOrTransfer: vi.fn(async (_projectId: string, body: unknown) => body),
}));
vi.mock('@web/data/upload/transfer-body', () => ({
  bodyOrTransfer: (projectId: string, body: unknown) => bodyOrTransfer(projectId, body),
}));

import type { ChatSendAnswer, ChatSyncAnswer } from '@breatic/shared';
import { chatApi } from '@web/data/api/chat';
import type { ConversationRead, StoredUiMessage } from '@web/data/api/chat';
import { ApiException } from '@web/data/api/types';
import { chatSessionFor, evictAllChatSessions } from '@web/stores/chat-sessions';
import { chatLive, resetChatLiveForTests } from '@web/stores/chat-live';
import { watchChatMishaps, type ChatMishap } from '@web/stores/chat-mishaps';
import { replyEnds, replyOpens, settle, storesWhatIsDrawn, stubRunWire, type RunWire } from '@web/test-utils/chat-run-wire';

const IDLE: ChatSyncAnswer = { pending: [], running: false, awaiting: false, next_sync_ms: 3000 };
const INPUT = { reason: 'To answer about the cast.', spaces: [{ id: 'c1' }] };

/**
 * The paused conversation as the server stores it.
 * @param request - The request call as it stands.
 * @returns The messages, oldest first.
 */
function paused(request: Record<string, unknown> = { state: 'input-available' }): StoredUiMessage[] {
  return [
    { id: 'u-1', role: 'user', parts: [{ type: 'text', text: 'what do the characters wear?' }], metadata: { turnIndex: 1, ts: '' } },
    {
      id: 'a-1',
      role: 'assistant',
      parts: [
        { type: 'text', text: 'Let me look first.' },
        { type: 'tool-request_space_content', toolCallId: 'req-1', input: INPUT, ...request },
        { type: 'data-ask-awaiting', data: { toolCallId: 'req-1' } },
      ] as StoredUiMessage['parts'],
      metadata: { turnIndex: 1, ts: '' },
    },
  ];
}

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

/** What the server answers when the answer resumed a run. */
const STARTED: ChatSendAnswer = { status: 'start', pending: [], running: true };

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
 * The request part in the session's messages.
 * @param chat - The session.
 * @returns The part.
 */
function requestPart(chat: ReturnType<typeof chatSessionFor>): Record<string, unknown> | undefined {
  return chat.messages.flatMap((m) => m.parts).find((p) => (p as { toolCallId?: string }).toolCallId === 'req-1') as
    | Record<string, unknown>
    | undefined;
}

/**
 * Answer the request card.
 * @param shared - The answer.
 * @returns When the answer is settled.
 */
function share(shared: Parameters<typeof chatLive.answerCard>[0]['card'] = { shared_spaces: SHARED }): Promise<void> {
  return chatLive.answerCard({ projectId: 'p-1', conversationId: 'c-1', toolCallId: 'req-1', card: shared, spaces: CONTEXT });
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
  bodyOrTransfer.mockClear();
  vi.spyOn(chatApi, 'streamConfig').mockResolvedValue({
    heartbeatIntervalMs: 600_000, attachmentMaxChars: 200_000, attachmentMaxItems: 10, currentSpaceMaxChars: 100_000,
    spaceListMaxItems: 200, spaceReadTimeoutMs: 20_000, runningPollIntervalMs: 5000, syncIntervalMs: 3000,
  });
  vi.spyOn(chatApi, 'readConversation').mockResolvedValue(page(paused()));
  vi.spyOn(chatApi, 'sync').mockResolvedValue(IDLE);
  vi.spyOn(chatApi, 'sendMessage').mockResolvedValue(STARTED);
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

describe('answering a request card', () => {
  it('sends shared_spaces with the usual Space context and no words, and leaves the list as it was', async () => {
    const chat = pausedChat();
    vi.mocked(chatApi.readConversation).mockResolvedValue(
      page(paused({ state: 'output-available', output: { spaces: [{ id: 'c1', name: 'Cast', kind: 'canvas', state: 'read' }] } })),
    );

    await share();
    await settle();

    expect(bodies()).toHaveLength(1);
    expect(bodies()[0]).toMatchObject({
      message: '',
      project_id: 'p-1',
      conversation_id: 'c-1',
      shared_spaces: SHARED,
      ...CONTEXT,
    });
    expect(bodies()[0]).not.toHaveProperty('answer');
    expect(chat.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
  });

  it('sends a declined answer the same way', async () => {
    const chat = pausedChat();
    vi.mocked(chatApi.readConversation).mockResolvedValue(page(paused({ state: 'output-available', output: { declined: true } })));

    await share({ shared_spaces: { toolCallId: 'req-1', decision: 'declined' } });
    await settle();

    expect(bodies()[0]).toMatchObject({ message: '', shared_spaces: { toolCallId: 'req-1', decision: 'declined' } });
    expect(requestPart(chat)).toMatchObject({ state: 'output-available', output: { declined: true } });
  });

  it('goes through the over-the-limit transfer, as every message does', async () => {
    pausedChat();

    await share();

    expect(bodyOrTransfer).toHaveBeenCalledTimes(1);
    expect(bodyOrTransfer).toHaveBeenCalledWith('p-1', expect.objectContaining({ shared_spaces: SHARED }));
  });

  it('draws the card settled from the store, and what the run says next as a reply of its own after it', async () => {
    const chat = pausedChat();
    vi.mocked(chatApi.readConversation).mockResolvedValue(
      page(paused({ state: 'output-available', output: { spaces: [{ id: 'c1', name: 'Cast', kind: 'canvas', state: 'read' }] } })),
    );

    await share();
    await settle();
    const s = wire.last()!;
    storesWhatIsDrawn(() => chat.messages, 'c-1');
    for (const f of replyOpens('t')) s.push(f);
    s.push({ type: 'text-delta', id: 't', delta: 'They wear red.' });
    for (const f of replyEnds('t')) s.push(f);
    s.close();
    await settle();

    expect(chat.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'assistant']);
    expect(chat.messages[1]?.id).toBe('a-1');
    expect(requestPart(chat)).toMatchObject({ state: 'output-available', output: { spaces: [{ id: 'c1', state: 'read' }] } });
    expect(chat.messages[2]?.parts.at(-1)).toMatchObject({ type: 'text', text: 'They wear red.' });
  });

  it('draws what the server holds when the card was already settled, and says nothing', async () => {
    const chat = pausedChat();
    vi.mocked(chatApi.sendMessage).mockRejectedValueOnce(refused(409, { code: 409, call: { status: 'success', output: { declined: true } } }));

    await share();

    expect(requestPart(chat)).toMatchObject({ state: 'output-available', output: { declined: true } });
    expect(chat.messages[1]?.parts.some((p) => p.type === 'data-failed')).toBe(false);
    expect(told).toEqual([]);
  });

  it('leaves the card waiting when the answer is refused, and says the server\'s words', async () => {
    const chat = pausedChat();
    vi.mocked(chatApi.sendMessage).mockRejectedValueOnce(refused(422));

    await share();

    expect(requestPart(chat)).toMatchObject({ state: 'input-available' });
    expect(chat.messages[1]?.parts.some((p) => p.type === 'data-failed')).toBe(false);
    expect(told).toContainEqual(expect.objectContaining({ conversationId: 'c-1', kind: 'server', message: 'Refused.' }));
  });
});

describe('writing a message instead of answering', () => {
  it('shows the request card it closed as replied to', async () => {
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
    s.push({ type: 'data-ask-replied', data: { toolCallId: 'req-1' } });
    s.push({ type: 'start', messageId: 'named-by-the-server' });
    s.push({ type: 'text-start', id: 't' });
    s.push({ type: 'text-delta', id: 't', delta: 'Sure.' });
    s.push({ type: 'text-end', id: 't' });
    s.push({ type: 'finish' });
    s.close();
    await settle();

    expect(requestPart(chat)).toMatchObject({ state: 'output-available', output: { repliedInChat: true } });
  });
});
