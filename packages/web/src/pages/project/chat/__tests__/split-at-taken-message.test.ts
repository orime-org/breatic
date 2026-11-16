// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * A reply that took in a message the user sent while it ran is drawn split
 * there (inner#1717, PT-10): what it said before, the user's message, what it
 * said after. The pieces are still one turn: the user's message shows when it
 * was sent, and copying, the thinking time and the ending sit on the last
 * piece alone.
 */
import { describe, it, expect } from 'vitest';
import type { UIMessage } from 'ai';
import { joinContinued, splitAtAnswer, toChatMessage } from '@web/pages/project/chat/to-chat-message';

/** An attached item. */
const CHIP = { id: 'chip-1', type: 'text' as const, name: 'notes.txt', data_snapshot: { text: 'n' } };

/** The user's message as the reply carries it. */
const TAKEN = {
  type: 'data-user-message',
  data: { id: 'm2', words: 'make it blue', chips: [CHIP], sentAt: '2026-11-12T08:01:00.000Z' },
};

/**
 * A reply that took the message in between two stretches of text.
 * @param parts - Its parts.
 * @returns The reply.
 */
function reply(parts: unknown[]): UIMessage {
  return { id: 'r1', role: 'assistant', parts: parts as UIMessage['parts'] };
}

describe('a reply that took a message in', () => {
  it('is drawn as what it said before, the message, and what it said after', () => {
    const views = splitAtAnswer(
      reply([{ type: 'text', text: 'first half' }, TAKEN, { type: 'step-start' }, { type: 'text', text: 'second half' }]),
    );
    expect(views.map((v) => v.role)).toEqual(['assistant', 'user', 'assistant']);
    const drawn = views.map((v) => toChatMessage(v));
    expect(drawn[0]!.content).toBe('first half');
    expect(drawn[1]).toMatchObject({ role: 'user', content: 'make it blue', attachments: [CHIP], sentAt: '2026-11-12T08:01:00.000Z', takenIn: true });
    expect(drawn[2]!.content).toBe('second half');
    expect(new Set(views.map((v) => v.id)).size).toBe(3);
  });

  it('opens with the message when the reply took it in before saying anything', () => {
    const views = splitAtAnswer(reply([TAKEN, { type: 'text', text: 'answer' }]));
    expect(views.map((v) => v.role)).toEqual(['user', 'assistant']);
  });

  it('copies all it said once, on its last piece, the user message left out of the copy', () => {
    const opening = toChatMessage({ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'open' }] });
    const pieces = splitAtAnswer(reply([{ type: 'text', text: 'first half' }, TAKEN, { type: 'text', text: 'second half' }])).map((v) =>
      toChatMessage(v),
    );
    const joined = joinContinued([opening, ...pieces]);
    expect(joined[1]).toMatchObject({ continued: true });
    expect(joined[3]!.continued).toBeUndefined();
    expect(joined[3]!.copyText).toBe('first half\n\nsecond half');
  });

  it('keeps a reply that took nothing in whole', () => {
    const whole = reply([{ type: 'text', text: 'all of it' }]);
    expect(splitAtAnswer(whole)).toEqual([whole]);
  });
});
