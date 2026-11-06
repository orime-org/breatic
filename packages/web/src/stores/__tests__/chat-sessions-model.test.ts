// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Every message carries the model of its conversation (#1363), read when it
 * is sent, so a pick made a moment before goes with the next message. A send
 * the server refuses is told, so the picker asks for the list of models
 * again: a page that predates a model being taken off is told so by the
 * refusal. The session is opened the way the chat panel opens it, reading the
 * model from the runtime store and counting a refusal there.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@web/data/api/chat', () => ({
  chatApi: {
    streamConfig: vi.fn(async () => ({
      heartbeatIntervalMs: 60_000,
      attachmentMaxChars: 200_000,
      attachmentMaxItems: 10, currentSpaceMaxChars: 100_000, spaceListMaxItems: 200,
    })),
  },
}));

const { chatSessionFor, evictAllChatSessions, sendInSession } = await import('@web/stores/chat-sessions');
const { useConversationRuntime, conversationRuntime } = await import('@web/stores/conversation-runtime');

/** A stream that opens a turn and ends it. */
const OPENS_AND_ENDS = 'data: {"type":"start"}\n\ndata: {"type":"finish"}\n\ndata: [DONE]\n\n';

let sent: Array<RequestInit | undefined> = [];
let answer: () => Response;
const original = globalThis.fetch;

beforeEach(() => {
  evictAllChatSessions();
  sent = [];
  answer = () => new Response(OPENS_AND_ENDS, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  globalThis.fetch = ((_url: string, init?: RequestInit) => {
    sent.push(init);
    return Promise.resolve(answer());
  }) as typeof globalThis.fetch;
  useConversationRuntime.setState({
    conversations: {
      'c-1': {
        projectId: 'p-1',
        messages: [],
        hasMore: false,
        oldestLoadedTurn: null,
        title: null,
        agentModel: { id: 'anthropic/claude-opus-5.5', name: 'Claude Opus 5.5' },
      },
    },
  });
});

afterEach(() => {
  globalThis.fetch = original;
  useConversationRuntime.setState({ conversations: {} });
  vi.restoreAllMocks();
});

/**
 * Open a session for the conversation.
 * @throws {never} Never.
 */
function openSession(): void {
  chatSessionFor({
    projectId: 'p-1',
    conversationId: 'c-1',
    history: [],
    onTitled: () => undefined,
    onFirstFrame: () => undefined,
    modelOf: () => useConversationRuntime.getState().conversations['c-1']?.agentModel.id,
    onRefused: conversationRuntime.noteRefused,
  });
}

describe('the model on a message', () => {
  it('sends the model of the conversation as it stands when the message is sent', async () => {
    openSession();
    useConversationRuntime.setState((s) => ({
      conversations: {
        ...s.conversations,
        'c-1': { ...s.conversations['c-1']!, agentModel: { id: 'anthropic/claude-sonnet-5.5', name: 'Claude Sonnet 5.5' } },
      },
    }));

    await sendInSession('c-1', 'hello');

    expect(JSON.parse(String(sent.at(-1)?.body))).toMatchObject({ model: 'anthropic/claude-sonnet-5.5' });
  });

  it('counts a send the server refused', async () => {
    answer = () =>
      new Response(JSON.stringify({ error: { code: 422, message: 'The selected model is no longer available.' } }), {
        status: 422,
        headers: { 'Content-Type': 'application/json' },
      });
    openSession();
    const before = useConversationRuntime.getState().refusals;

    await sendInSession('c-1', 'hello').catch(() => undefined);

    expect(useConversationRuntime.getState().refusals).toBe(before + 1);
  });
});
