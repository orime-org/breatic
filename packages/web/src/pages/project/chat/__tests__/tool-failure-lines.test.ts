// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * A tool step that did not finish is said where it happened in the reply,
 * naming the step and the cause (inner#1620).
 */
import { describe, it, expect } from 'vitest';
import type { UIMessage } from 'ai';
import { FAILURE_LINES, LEGACY_FAILURE_LINES, NEVER_RAN, TURNED_AWAY } from '@breatic/shared';
import { toChatMessage } from '@web/pages/project/chat/to-chat-message';
import { failurePlaceholder } from '@web/pages/project/chat/tool-failure-plugin';

/**
 * A reply whose parts are these.
 * @param parts - The parts.
 * @returns The message.
 */
function reply(parts: unknown[]): UIMessage {
  return { id: 'm1', role: 'assistant', parts } as unknown as UIMessage;
}

/**
 * Some prose.
 * @param words - The words.
 * @returns The part.
 */
function text(words: string): Record<string, unknown> {
  return { type: 'text', text: words };
}

/**
 * A search that ended in an error.
 * @param id - The call.
 * @param query - What was searched for.
 * @param errorText - What the wire carried.
 * @returns The part.
 */
function failedSearch(id: string, query: string, errorText: string = FAILURE_LINES.busy): Record<string, unknown> {
  return { type: 'tool-web_search', toolCallId: id, state: 'output-error', input: { query }, errorText };
}

/**
 * A search that answered.
 * @param id - The call.
 * @returns The part.
 */
function foundSearch(id: string): Record<string, unknown> {
  return { type: 'tool-web_search', toolCallId: id, state: 'output-available', input: { query: 'q' }, output: { query: 'q', sources: [] } };
}

describe('a failed step in a reply', () => {
  it('sits between the prose before and after it, naming the step and the cause', () => {
    const view = toChatMessage(reply([text('Let me look.'), failedSearch('s1', 'poster'), text('Carrying on.')]));

    expect(view.failureLines).toEqual([
      { step: { key: 'chat.tool.step.webSearch', params: { query: 'poster' } }, reason: FAILURE_LINES.busy, count: 1 },
    ]);
    expect(view.body).toBe(`Let me look.\n\n${failurePlaceholder(0)}\n\nCarrying on.`);
  });

  it('leaves the prose the reader copies as it was', () => {
    const view = toChatMessage(reply([text('Let me look.'), failedSearch('s1', 'poster'), text('Carrying on.')]));

    expect(view.content).toBe('Let me look.Carrying on.');
  });

  it('is drawn even when the reply has no prose', () => {
    const view = toChatMessage(reply([failedSearch('s1', 'poster')]));

    expect(view.failureLines).toHaveLength(1);
    expect(view.content).toBe('');
  });

  it('is not drawn when the same tool worked right after it', () => {
    const view = toChatMessage(reply([text('Let me look.'), failedSearch('s1', 'poster'), foundSearch('s2'), text('Found it.')]));

    expect(view.failureLines).toBeUndefined();
    expect(view.body).toBeUndefined();
  });

  it('shows the same line twice in a row once, with how many times', () => {
    const view = toChatMessage(reply([failedSearch('s1', 'cats'), failedSearch('s2', 'cats')]));

    expect(view.failureLines).toEqual([
      { step: { key: 'chat.tool.step.webSearch', params: { query: 'cats' } }, reason: FAILURE_LINES.busy, count: 2 },
    ]);
  });

  it('keeps two steps with different queries as two lines', () => {
    const view = toChatMessage(reply([failedSearch('s1', 'cats'), failedSearch('s2', 'dogs')]));

    expect(view.failureLines?.map((line) => line.step.params?.query)).toEqual(['cats', 'dogs']);
  });

  it('names a step stored before its cause was recorded, with no cause', () => {
    const view = toChatMessage(reply([failedSearch('s1', 'poster', LEGACY_FAILURE_LINES.generic)]));

    expect(view.failureLines?.[0]?.reason).toBeNull();
  });

  it('waits for an open code block to close before it is placed', () => {
    const view = toChatMessage(reply([text('```\ncode'), failedSearch('s1', 'poster'), text('\n```\nAfter.')]));

    expect(view.body).toBe(`\`\`\`\ncode\n\`\`\`\nAfter.\n\n${failurePlaceholder(0)}`);
  });
});

describe('a step that draws no line', () => {
  it('is one that never ran', () => {
    expect(toChatMessage(reply([failedSearch('s1', 'q', NEVER_RAN)])).failureLines).toBeUndefined();
  });

  it('is one the turn ended around before it finished', () => {
    const left = { type: 'tool-web_search', toolCallId: 's1', state: 'input-available', input: { query: 'q' } };
    expect(toChatMessage(reply([left])).failureLines).toBeUndefined();
  });

  it('is one the reader stopped', () => {
    const left = { type: 'tool-web_search', toolCallId: 's1', state: 'input-available', input: { query: 'q' } };
    expect(toChatMessage(reply([left, { type: 'data-interrupted', data: {} }])).failureLines).toBeUndefined();
  });

  it('is one turned away to steer the model', () => {
    expect(toChatMessage(reply([failedSearch('s1', 'q', TURNED_AWAY)])).failureLines).toBeUndefined();
  });
});
