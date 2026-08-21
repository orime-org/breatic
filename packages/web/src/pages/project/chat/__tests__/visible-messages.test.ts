// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * What the conversation shows while the server has not answered yet.
 *
 * The library pushes the message the reader sent before it sets the status
 * to `submitted`, so between the press and the first frame the list already
 * holds it. Showing it there would put the sentence on screen twice over --
 * once as a bubble, once still sitting in the box it has not left -- and it
 * would arrive without the reply it belongs beside.
 *
 * So the renderer leaves the last message out while the status says the
 * request is still unanswered. One line of translation between what the
 * library holds and what a reader sees, and every case it has to get right
 * is here: a history that already ends in a user message, someone who sent
 * two in a row, a status where this does not apply at all.
 */
import { describe, it, expect } from 'vitest';
import type { UIMessage } from 'ai';
import { visibleMessages } from '@web/pages/project/chat/visible-messages';

/**
 * One message, as the library holds it.
 * @param id - Its id.
 * @param role - Who said it.
 * @param text - What was said.
 * @returns The message.
 */
function said(id: string, role: 'user' | 'assistant', text: string): UIMessage {
  return { id, role, parts: [{ type: 'text', text }] };
}

const HISTORY: UIMessage[] = [
  said('m1', 'user', '第一句'),
  said('m2', 'assistant', '答第一句'),
  said('m3', 'user', '第二句'),
  said('m4', 'assistant', '答第二句'),
];

describe('while the request is unanswered', () => {
  it('holds back the sentence that was just sent', () => {
    const withNew = [...HISTORY, said('m5', 'user', '刚发的')];
    expect(visibleMessages(withNew, 'submitted')).toEqual(HISTORY);
  });

  it('holds back only that one, not the earlier questions', () => {
    // The history already ends in a user message on its own account -- a
    // turn that failed, a turn still being answered. Dropping every trailing
    // user message would erase those too.
    const withNew = [...HISTORY, said('m5', 'user', '刚发的')];
    const shown = visibleMessages(withNew, 'submitted');
    expect(shown.filter((m) => m.role === 'user')).toHaveLength(2);
    expect(shown.at(-1)?.id).toBe('m4');
  });

  it('holds back the second of two sent in a row, and shows the first', () => {
    // Sending again before the first was answered. The first one has been on
    // screen for a while; only the newest is the one still in the box.
    const twice = [...HISTORY, said('m5', 'user', '先一句'), said('m6', 'user', '又一句')];
    const shown = visibleMessages(twice, 'submitted');
    expect(shown.at(-1)?.id).toBe('m5');
    expect(shown.some((m) => m.id === 'm6')).toBe(false);
  });

  it('shows everything when the list does not end in a user message', () => {
    // Not a state the library produces, and the answer still has to be
    // defined: hide nothing rather than hide something arbitrary.
    expect(visibleMessages(HISTORY, 'submitted')).toEqual(HISTORY);
  });

  it('has nothing to hide in an empty conversation', () => {
    expect(visibleMessages([], 'submitted')).toEqual([]);
  });
});

describe('once the answer has started', () => {
  it('shows the sentence, because its reply is arriving beside it', () => {
    // The first frame is what puts both bubbles on screen at once, and it is
    // also what empties the box. From here the message belongs to the
    // conversation.
    const withNew = [...HISTORY, said('m5', 'user', '刚发的')];
    expect(visibleMessages(withNew, 'streaming')).toEqual(withNew);
  });
});

describe('when nothing is in flight', () => {
  it('shows the conversation as it is', () => {
    const withNew = [...HISTORY, said('m5', 'user', '刚发的')];
    for (const status of ['ready', 'error'] as const) {
      expect(visibleMessages(withNew, status)).toEqual(withNew);
    }
  });
});
