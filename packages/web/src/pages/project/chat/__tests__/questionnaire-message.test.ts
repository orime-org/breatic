// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * A questionnaire, as the panel reads it off a message (inner#1542).
 *
 * The card is drawn from the `ask_user` call and the server's mark naming it
 * as the card the reader is shown. Once the reader answers on the card, the
 * turn resumes in the same message, so the message is split where the asking
 * segment ended: the card above, what the turn went on to say below.
 */
import { describe, it, expect } from 'vitest';
import type { UIMessage } from 'ai';
import { joinContinued, splitAtAnswer, toChatMessage } from '@web/pages/project/chat/to-chat-message';
import type { ChatMessage } from '@web/pages/project/chat/types';

const QUESTIONS = [
  { header: 'Ratio', question: 'Which ratio?', multiSelect: false, options: [{ label: '16:9' }, { label: '9:16' }] },
];
const ANSWERS = [{ index: 0, selected: ['9:16'] }];

/**
 * A reply whose parts are these.
 * @param parts - The parts.
 * @returns The message.
 */
function reply(parts: unknown[]): UIMessage {
  return { id: 'm1', role: 'assistant', parts } as unknown as UIMessage;
}

/**
 * An `ask_user` part.
 * @param toolCallId - The call.
 * @param state - Where it stands.
 * @param extra - Its output, or a different input.
 * @returns The part.
 */
function ask(toolCallId: string, state: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { type: 'tool-ask_user', toolCallId, state, input: { questions: QUESTIONS }, ...extra };
}

/**
 * The mark naming the card the reader is shown.
 * @param toolCallId - The call.
 * @returns The part.
 */
function awaiting(toolCallId: string): Record<string, unknown> {
  return { type: 'data-ask-awaiting', data: { toolCallId } };
}

describe('the card a message draws', () => {
  it('waits for the reader when the server named it', () => {
    const view = toChatMessage(reply([{ type: 'text', text: 'Two things first.' }, ask('ask-1', 'input-available'), awaiting('ask-1')]));

    expect(view.questionnaires).toEqual([{ toolCallId: 'ask-1', questions: QUESTIONS, state: 'awaiting' }]);
    expect(view.toolCalls?.[0]).toMatchObject({ status: 'pending' });
  });

  it('shows the answers once the reader submitted them', () => {
    const view = toChatMessage(reply([ask('ask-1', 'output-available', { output: { answers: ANSWERS } })]));

    expect(view.questionnaires).toEqual([{ toolCallId: 'ask-1', questions: QUESTIONS, state: 'answered', answers: ANSWERS }]);
  });

  it('says the reader replied in the chat when they wrote a message instead', () => {
    const view = toChatMessage(reply([ask('ask-1', 'output-available', { output: { repliedInChat: true } })]));

    expect(view.questionnaires).toEqual([{ toolCallId: 'ask-1', questions: QUESTIONS, state: 'replied' }]);
  });

  it('is not drawn while the call is still arriving', () => {
    const view = toChatMessage(reply([ask('ask-1', 'input-streaming')]), { streaming: true });

    expect(view.questionnaires).toBeUndefined();
  });

  it('is not drawn for a question stored before the card existed', () => {
    const view = toChatMessage(
      reply([ask('ask-1', 'output-available', { input: { question: 'Which?', options: ['A'] }, output: { question: 'Which?' } })]),
    );

    expect(view.questionnaires).toBeUndefined();
  });

  it('is not drawn for a second card in the step, which is turned away rather than failed', () => {
    const view = toChatMessage(reply([ask('ask-1', 'input-available'), ask('ask-2', 'input-available'), awaiting('ask-1')]));

    expect(view.questionnaires?.map((q) => q.toolCallId)).toEqual(['ask-1']);
    expect(view.toolCalls?.find((c) => c.id === 'ask-2')).toMatchObject({ status: 'error', failureKind: 'turned_away' });
  });
});

describe('a reply resumed after the reader answered on the card', () => {
  it('is split where the asking segment ended, the card above and the rest below', () => {
    const live = reply([
      { type: 'text', text: 'Two things first.' },
      ask('ask-1', 'output-available', { output: { answers: ANSWERS } }),
      awaiting('ask-1'),
      { type: 'step-start' },
      { type: 'text', text: 'Here is the plan.' },
    ]);

    const [asked, resumed, ...rest] = splitAtAnswer(live);

    expect(rest).toEqual([]);
    expect(asked?.id).toBe('m1');
    expect(asked?.parts.map((p) => p.type)).toEqual(['text', 'tool-ask_user', 'data-ask-awaiting']);
    expect(resumed?.id).toBe('m1~ask-1');
    expect(resumed?.parts).toEqual([{ type: 'step-start' }, { type: 'text', text: 'Here is the plan.' }]);
  });

  it('is split after every card answered in it, each part named after the call it follows', () => {
    const live = reply([
      { type: 'text', text: 'First.' },
      ask('ask-1', 'output-available', { output: { answers: ANSWERS } }),
      awaiting('ask-1'),
      { type: 'text', text: 'Second.' },
      ask('ask-2', 'output-available', { output: { answers: ANSWERS } }),
      awaiting('ask-2'),
      { type: 'text', text: 'Third.' },
    ]);

    const views = splitAtAnswer(live);

    expect(views.map((v) => v.id)).toEqual(['m1', 'm1~ask-1', 'm1~ask-2']);
    expect(views.map((v) => v.parts.map((p) => p.type))).toEqual([
      ['text', 'tool-ask_user', 'data-ask-awaiting'],
      ['text', 'tool-ask_user', 'data-ask-awaiting'],
      ['text'],
    ]);
  });

  it('stays whole while the card is still waiting', () => {
    const waiting = reply([ask('ask-1', 'input-available'), awaiting('ask-1')]);

    expect(splitAtAnswer(waiting)).toEqual([waiting]);
  });

  it('stays whole when nothing came after the answered card', () => {
    const answered = reply([ask('ask-1', 'output-available', { output: { answers: ANSWERS } }), awaiting('ask-1')]);

    expect(splitAtAnswer(answered)).toEqual([answered]);
  });

  it('opens an empty part below the answered card while the turn is still being written', () => {
    const answered = reply([ask('ask-1', 'output-available', { output: { answers: ANSWERS } }), awaiting('ask-1')]);

    const [asked, resumed, ...rest] = splitAtAnswer(answered, { open: true });

    expect(rest).toEqual([]);
    expect(asked?.parts.map((p) => p.type)).toEqual(['tool-ask_user', 'data-ask-awaiting']);
    expect(resumed).toMatchObject({ id: 'm1~ask-1', parts: [] });
  });

  it('stays whole while the turn is written when the card is still waiting', () => {
    const waiting = reply([ask('ask-1', 'input-available'), awaiting('ask-1')]);

    expect(splitAtAnswer(waiting, { open: true })).toEqual([waiting]);
  });
});

describe('a turn drawn as more than one reply', () => {
  const said = (id: string, role: ChatMessage['role'], content: string): ChatMessage => ({ id, role, content });

  it('offers one copy, at its end, of everything it said', () => {
    const views = [said('u', 'user', 'make me a poster'), said('a', 'assistant', 'Two things first.'), said('a~ask', 'assistant', 'Here is the plan.')];

    const [, asked, resumed] = joinContinued(views);

    expect(asked).toMatchObject({ continued: true });
    expect(resumed?.copyText).toBe('Two things first.\n\nHere is the plan.');
  });

  it('leaves replies the reader\'s messages separate untouched', () => {
    const views = [said('u1', 'user', 'a'), said('a1', 'assistant', 'one'), said('u2', 'user', 'b'), said('a2', 'assistant', 'two')];

    expect(joinContinued(views)).toEqual(views);
  });

  it('hands back the same objects for views that need nothing', () => {
    const views = [said('u1', 'user', 'a'), said('a1', 'assistant', 'one')];

    const out = joinContinued(views);

    expect(out[0]).toBe(views[0]);
    expect(out[1]).toBe(views[1]);
  });
});
