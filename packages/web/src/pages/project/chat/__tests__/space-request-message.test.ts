// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * A request to look at Spaces, as the panel reads it off a message
 * (inner#1552, design 4.4).
 *
 * The card is drawn from the `request_space_content` call and the server's
 * mark naming it as the card the reader is shown, the way a questionnaire is:
 * the two tools share the one mark, and a step keeps only its first card.
 */
import { describe, it, expect } from 'vitest';
import type { UIMessage } from 'ai';
import { FAILURE_LINES } from '@breatic/shared';
import { toChatMessage } from '@web/pages/project/chat/to-chat-message';
import { LOCALE_CATALOGS, readPath } from '@web/test-utils/locale-catalogs';

const INPUT = {
  reason: 'You asked about the second half of the script and three characters.',
  spaces: [{ id: 'd1', blocks: { from: 41 } }, { id: 'c1', node_ids: ['n1', 'n2', 'n3'] }, { id: 't1' }],
};
const QUESTIONS = [
  { header: 'Ratio', question: 'Which ratio?', multiSelect: false, options: [{ label: '16:9' }, { label: '9:16' }] },
];

/**
 * A reply whose parts are these.
 * @param parts - The parts.
 * @returns The message.
 */
function reply(parts: unknown[]): UIMessage {
  return { id: 'm1', role: 'assistant', parts } as unknown as UIMessage;
}

/**
 * A `request_space_content` part.
 * @param toolCallId - The call.
 * @param state - Where it stands.
 * @param extra - Its output, or a different input.
 * @returns The part.
 */
function request(toolCallId: string, state: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { type: 'tool-request_space_content', toolCallId, state, input: INPUT, ...extra };
}

/**
 * An `ask_user` part.
 * @param toolCallId - The call.
 * @returns The part, waiting.
 */
function ask(toolCallId: string): Record<string, unknown> {
  return { type: 'tool-ask_user', toolCallId, state: 'input-available', input: { questions: QUESTIONS } };
}

/**
 * The mark naming the card the reader is shown.
 * @param toolCallId - The call.
 * @returns The part.
 */
function awaiting(toolCallId: string): Record<string, unknown> {
  return { type: 'data-ask-awaiting', data: { toolCallId } };
}

describe('the request card a message draws', () => {
  it('waits for the reader when the server named it, with the reason and the Spaces asked for', () => {
    const view = toChatMessage(reply([{ type: 'text', text: 'Let me look first.' }, request('req-1', 'input-available'), awaiting('req-1')]));

    expect(view.spaceRequests).toEqual([
      { toolCallId: 'req-1', reason: INPUT.reason, spaces: INPUT.spaces, state: 'awaiting' },
    ]);
    expect(view.toolCalls?.[0]).toMatchObject({ status: 'pending' });
    expect(view.toolCalls?.[0]).not.toHaveProperty('failureKind');
  });

  it('shows what was shared once the reader allowed it, from the stored summary', () => {
    const summary = [
      { id: 'd1', name: 'Script v3', kind: 'document', part: { blocks: { from: 41 } }, state: 'read' },
      { id: 'c1', name: 'Cast', kind: 'canvas', part: { node_ids: ['n1', 'n2', 'n3'] }, state: 'read' },
      { id: 't1', name: 'Intro', kind: 'timeline', state: 'unreadable' },
    ];
    const view = toChatMessage(reply([request('req-1', 'output-available', { output: { spaces: summary } })]));

    expect(view.spaceRequests).toEqual([
      { toolCallId: 'req-1', reason: INPUT.reason, spaces: INPUT.spaces, state: 'shared', results: summary },
    ]);
  });

  it('keeps a Space that was gone without a name or a kind in the summary', () => {
    const summary = [{ id: 'd1', part: { blocks: { from: 41 } }, state: 'gone' }];
    const view = toChatMessage(reply([request('req-1', 'output-available', { output: { spaces: summary } })]));

    expect(view.spaceRequests?.[0]).toMatchObject({ state: 'shared', results: summary });
  });

  it('says the reader declined', () => {
    const view = toChatMessage(reply([request('req-1', 'output-available', { output: { declined: true } })]));

    expect(view.spaceRequests).toEqual([
      { toolCallId: 'req-1', reason: INPUT.reason, spaces: INPUT.spaces, state: 'declined' },
    ]);
  });

  it('says the reader replied in the chat when they wrote a message instead', () => {
    const view = toChatMessage(reply([request('req-1', 'output-available', { output: { repliedInChat: true } })]));

    expect(view.spaceRequests).toEqual([
      { toolCallId: 'req-1', reason: INPUT.reason, spaces: INPUT.spaces, state: 'replied' },
    ]);
  });

  it('is not drawn while the call is still arriving', () => {
    const view = toChatMessage(reply([request('req-1', 'input-streaming')]), { streaming: true });

    expect(view.spaceRequests).toBeUndefined();
  });

  it('is not drawn for a request after a questionnaire in the same step, which is turned away', () => {
    const view = toChatMessage(reply([ask('ask-1'), request('req-1', 'input-available'), awaiting('ask-1')]));

    expect(view.spaceRequests).toBeUndefined();
    expect(view.questionnaires?.map((q) => q.toolCallId)).toEqual(['ask-1']);
    expect(view.toolCalls?.find((c) => c.id === 'req-1')).toMatchObject({ status: 'error', failureKind: 'turned_away' });
  });

  it('turns away a questionnaire after a request in the same step', () => {
    const view = toChatMessage(reply([request('req-1', 'input-available'), ask('ask-1'), awaiting('req-1')]));

    expect(view.spaceRequests?.map((r) => r.toolCallId)).toEqual(['req-1']);
    expect(view.questionnaires).toBeUndefined();
    expect(view.toolCalls?.find((c) => c.id === 'ask-1')).toMatchObject({ status: 'error', failureKind: 'turned_away' });
  });

  it('is not drawn for a second request in the step', () => {
    const view = toChatMessage(reply([request('req-1', 'input-available'), request('req-2', 'input-available'), awaiting('req-1')]));

    expect(view.spaceRequests?.map((r) => r.toolCallId)).toEqual(['req-1']);
    expect(view.toolCalls?.find((c) => c.id === 'req-2')).toMatchObject({ status: 'error', failureKind: 'turned_away' });
  });
});

describe('a request the model sent wrong', () => {
  it('draws no card and names its step on the failure line', () => {
    const view = toChatMessage(
      reply([
        {
          type: 'tool-request_space_content',
          toolCallId: 'req-1',
          state: 'output-error',
          input: { reason: 'r', spaces: [{ id: 'not-listed' }] },
          errorText: 'Invalid input for tool request_space_content',
        },
      ]),
    );

    expect(view.spaceRequests).toBeUndefined();
    expect(view.failureLines).toEqual([{ step: { key: 'chat.tool.step.requestSpace' }, reason: FAILURE_LINES.ourFault, count: 1 }]);
  });
});

describe('the words the card and its failure line use', () => {
  const KEYS = [
    'chat.spaceRequest.title',
    'chat.spaceRequest.allow',
    'chat.spaceRequest.decline',
    'chat.spaceRequest.shared',
    'chat.spaceRequest.declined',
    'chat.spaceRequest.partBlocks',
    'chat.spaceRequest.partNodes',
    'chat.spaceRequest.state.unreadable',
    'chat.spaceRequest.state.gone',
    'chat.spaceRequest.state.timedOut',
    'chat.spaceRequest.state.failed',
    'chat.tool.step.requestSpace',
  ];

  it.each(LOCALE_CATALOGS.map(([tag, catalog]) => [tag, catalog] as const))('are all in %s', (_tag, catalog) => {
    const missing = KEYS.filter((key) => typeof readPath(catalog, key) !== 'string' || readPath(catalog, key) === '');

    expect(missing).toEqual([]);
  });

  it.each(LOCALE_CATALOGS.map(([tag, catalog]) => [tag, catalog] as const))(
    'say a reply in the chat with the questionnaire\'s own words in %s',
    (_tag, catalog) => {
      expect(readPath(catalog, 'chat.questionnaire.replied')).toEqual(expect.any(String));
      expect(readPath(catalog, 'chat.spaceRequest.replied')).toBeUndefined();
    },
  );
});
