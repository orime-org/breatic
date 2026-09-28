// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * A message that carries attached items, from the press to the first frame.
 *
 * The items ride on the message itself, as data parts ahead of the words, so
 * the bubble that appears on the press can show them and the request can read
 * them off it. When the turn opens, the items it carried are named back so
 * they can leave the list above the box.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ATTACHMENT_DATA_PART } from '@breatic/shared';
import type { ChatAttachedChip } from '@breatic/shared';

vi.mock('@web/data/api/chat', () => ({
  chatApi: {
    streamConfig: vi.fn(async () => ({
      heartbeatIntervalMs: 60_000,
      attachmentMaxChars: 200_000,
      attachmentMaxItems: 10,
    })),
  },
}));

const { chatSessionFor, evictAllChatSessions, sendInSession } = await import(
  '@web/stores/chat-sessions'
);

const image: ChatAttachedChip = {
  id: 'a1',
  type: 'image',
  name: 'cover.png',
  data_snapshot: { url: 'https://cdn.example/cover.png' },
};

/** A stream that opens a turn and ends it. */
const OPENS_AND_ENDS =
  'data: {"type":"start"}\n\ndata: {"type":"finish"}\n\ndata: [DONE]\n\n';

let sent: Array<RequestInit | undefined> = [];
const original = globalThis.fetch;

beforeEach(() => {
  evictAllChatSessions();
  sent = [];
  globalThis.fetch = ((_url: string, init?: RequestInit) => {
    sent.push(init);
    return Promise.resolve(
      new Response(OPENS_AND_ENDS, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      }),
    );
  }) as typeof globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = original;
});

/**
 * Open a session and send one message on it.
 * @param onFirstFrame - What the session is told when the turn opens.
 * @returns The session.
 */
async function sendWithAttachment(
  onFirstFrame: (sent: readonly ChatAttachedChip[]) => void = () => undefined,
) {
  const chat = chatSessionFor({
    projectId: 'p-1',
    conversationId: 'c-1',
    history: [],
    onTitled: () => undefined,
    onFirstFrame,
  });
  await sendInSession('c-1', 'what is in this?', [image]);
  return chat;
}

describe('a message carrying attachments', () => {
  it('sends them in the request beside the words', async () => {
    await sendWithAttachment();

    const body = JSON.parse(String(sent.at(-1)?.body)) as Record<string, unknown>;
    expect(body.message).toBe('what is in this?');
    expect(body.attached_chips).toEqual([image]);
  });

  it('puts them on the message the bubble is drawn from, ahead of the words', async () => {
    const chat = await sendWithAttachment();

    const mine = chat.messages.find((m) => m.role === 'user');
    expect(mine?.parts).toEqual([
      { type: ATTACHMENT_DATA_PART, data: image },
      { type: 'text', text: 'what is in this?' },
    ]);
  });

  it('hands back what it carried when the turn opens', async () => {
    const opened = vi.fn();

    await sendWithAttachment(opened);

    expect(opened).toHaveBeenCalledTimes(1);
    expect(opened).toHaveBeenCalledWith([image]);
  });

  it('sends an empty list when nothing is attached', async () => {
    chatSessionFor({
      projectId: 'p-1',
      conversationId: 'c-1',
      history: [],
      onTitled: () => undefined,
      onFirstFrame: () => undefined,
    });
    await sendInSession('c-1', 'hello');

    const body = JSON.parse(String(sent.at(-1)?.body)) as Record<string, unknown>;
    expect(body.attached_chips).toEqual([]);
  });
});
