/**
 * `backendToLocal` unit tests — guards the persistence → render
 * adapter that lets F13 interaction-tool widgets survive a page
 * reload via the `tool_calls[0].result` field.
 */
import { describe, expect, it } from 'vitest';

import type { MessageData } from '@breatic/shared';

import { backendToLocal } from './chat-history';

function msg(partial: Partial<MessageData> & Pick<MessageData, 'role'>): MessageData {
  return {
    content: '',
    ts: '2026-05-11T00:00:00Z',
    turnIndex: 0,
    ...partial,
  };
}

describe('backendToLocal', () => {
  it('passes through plain user message', () => {
    const out = backendToLocal(msg({ role: 'user', content: 'hi' }));
    expect(out).toMatchObject({ role: 'user', content: 'hi' });
    expect(out?.toolCall).toBeUndefined();
  });

  it('passes through plain assistant text message', () => {
    const out = backendToLocal(msg({ role: 'assistant', content: 'ok' }));
    expect(out).toMatchObject({ role: 'assistant', content: 'ok' });
    expect(out?.toolCall).toBeUndefined();
  });

  it('drops role=tool record', () => {
    const out = backendToLocal(
      msg({ role: 'tool', tool_call_id: 'tc1', name: 'read_file', content: '<output>' }),
    );
    expect(out).toBeNull();
  });

  it('drops non-interaction tool-call placeholder (e.g. read_file)', () => {
    const out = backendToLocal(
      msg({
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'tc1', name: 'read_file', arguments: { path: 'a' } }],
      }),
    );
    expect(out).toBeNull();
  });

  it('rebuilds ask_user_choice toolCall from tool_calls[0].result', () => {
    const args = { question: 'Pick one', choices: [{ id: 'a', label: 'A' }] };
    const out = backendToLocal(
      msg({
        role: 'assistant',
        content: '',
        tool_calls: [
          { id: 'tc1', name: 'ask_user_choice', arguments: {}, result: args },
        ],
      }),
    );
    expect(out?.toolCall).toEqual({ name: 'ask_user_choice', args });
  });

  it('rebuilds propose_canvas_action toolCall', () => {
    const args = { action: 'create_nodes', rationale: 'r', nodes: [{ type: 'image', label: 'L' }] };
    const out = backendToLocal(
      msg({
        role: 'assistant',
        content: '',
        tool_calls: [
          { id: 'tc1', name: 'propose_canvas_action', arguments: {}, result: args },
        ],
      }),
    );
    expect(out?.toolCall).toEqual({ name: 'propose_canvas_action', args });
  });

  it('rebuilds show_search_results toolCall', () => {
    const args = { images: [{ url: 'u', title: 't', source: 's' }] };
    const out = backendToLocal(
      msg({
        role: 'assistant',
        content: '',
        tool_calls: [
          { id: 'tc1', name: 'show_search_results', arguments: {}, result: args },
        ],
      }),
    );
    expect(out?.toolCall).toEqual({ name: 'show_search_results', args });
  });

  it('drops interaction tool-call without persisted result (back-compat with older rows)', () => {
    const out = backendToLocal(
      msg({
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'tc1', name: 'ask_user_choice', arguments: {} }],
      }),
    );
    expect(out).toBeNull();
  });
});
