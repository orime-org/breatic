// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What a turn's searches leave on the reply.
 *
 * Two things, and they are numbered differently on purpose. The row at the
 * foot of the reply lists every page the turn found, deduplicated -- a reader
 * scanning it wants each publisher once. The markers inside the prose resolve
 * against the sources as the model was shown them, which is one number per
 * source per search, duplicates included: the model wrote `[4]` against the
 * fourth thing it was handed, and renumbering under it points the marker
 * somewhere else.
 */

import { describe, it, expect } from 'vitest';
import { toChatMessage } from '@web/pages/project/chat/to-chat-message';
import type { UIMessage } from 'ai';

/**
 * One `web_search` result part, as the protocol carries it.
 * @param id - The tool call id.
 * @param urls - One entry per source, as `url|title|publisher`.
 * @param from - The number the tool gave this search's first source.
 * @returns The part.
 */
function searched(id: string, urls: string[], from = 1): UIMessage['parts'][number] {
  return {
    type: 'tool-web_search',
    toolCallId: id,
    state: 'output-available',
    input: { query: 'q', count: 5 },
    output: {
      query: 'q',
      sent: urls.length,
      sources: urls.map((spec, i) => {
        const [url, title, publisher] = spec.split('|');
        return { url, title, publisher, excerpts: ['page text'], index: from + i };
      }),
    },
  } as unknown as UIMessage['parts'][number];
}

/**
 * A stored assistant message carrying those parts.
 * @param parts - What the turn produced.
 * @returns The message.
 */
function reply(parts: UIMessage['parts']): UIMessage {
  return { id: 'm1', role: 'assistant', parts } as UIMessage;
}

describe('the row at the foot of a reply', () => {
  it('lists what the turn found, publisher and all', () => {
    const message = toChatMessage(
      reply([searched('a', ['https://vitest.dev/g|Guide|Vitest'])]),
    );

    expect(message.sources).toEqual([
      { url: 'https://vitest.dev/g', title: 'Guide', publisher: 'Vitest', index: 1, indexes: [1] },
    ]);
  });

  it('pools several searches into one row rather than grouping by search', () => {
    const message = toChatMessage(
      reply([
        searched('a', ['https://a.example|A|A']),
        searched('b', ['https://b.example|B|B']),
      ]),
    );

    expect(message.sources?.map((s) => s.url)).toEqual([
      'https://a.example',
      'https://b.example',
    ]);
  });

  it('shows a page once when two searches both found it', () => {
    const message = toChatMessage(
      reply([
        searched('a', ['https://same.example|Same|Same']),
        searched('b', ['https://same.example|Same|Same', 'https://other.example|Other|Other']),
      ]),
    );

    expect(message.sources?.map((s) => s.url)).toEqual([
      'https://same.example',
      'https://other.example',
    ]);
  });

  it('leaves the row off a turn that searched for nothing', () => {
    const message = toChatMessage(reply([{ type: 'text', text: 'hello' } as never]));

    expect(message.sources).toBeUndefined();
  });
});

describe('the numbers the prose markers resolve against', () => {
  it('carries on across searches, the way the model was shown them', () => {
    const message = toChatMessage(
      reply([
        searched('a', ['https://a.example|A|A', 'https://b.example|B|B']),
        searched('b', ['https://c.example|C|C'], 3),
      ]),
    );

    expect(message.citations?.[1]?.url).toBe('https://a.example');
    expect(message.citations?.[2]?.url).toBe('https://b.example');
    expect(message.citations?.[3]?.url).toBe('https://c.example');
  });

  it('gives a page found twice both of its numbers', () => {
    // The row above shows it once. Here it keeps both, because the model was
    // handed it twice and may have cited either.
    const message = toChatMessage(
      reply([
        searched('a', ['https://same.example|Same|Same']),
        searched('b', ['https://same.example|Same|Same'], 2),
      ]),
    );

    expect(message.citations?.[1]?.url).toBe('https://same.example');
    expect(message.citations?.[2]?.url).toBe('https://same.example');
  });

  it('reads nothing off a result stored before the structured output', () => {
    // Rows written earlier carry the model's text. Reading `sources` off a
    // string yields undefined, and a row of chips built from that would be a
    // row of blanks.
    const older = {
      type: 'tool-web_search',
      toolCallId: 'a',
      state: 'output-available',
      input: { query: 'q' },
      output: 'Results for: q\n<source index="1">\nurl: https://a.example\n</source>',
    } as unknown as UIMessage['parts'][number];

    const message = toChatMessage(reply([older]));

    expect(message.sources).toBeUndefined();
    expect(message.citations).toBeUndefined();
  });

  it('reads nothing off a call that failed', () => {
    const failedCall = {
      type: 'tool-web_search',
      toolCallId: 'a',
      state: 'output-error',
      input: { query: 'q' },
      errorText: 'chat.tool.error.upstream',
    } as unknown as UIMessage['parts'][number];

    const message = toChatMessage(reply([failedCall]));

    expect(message.sources).toBeUndefined();
  });
});

describe('a turn that stopped to wait for an answer', () => {
  it('reads the mark the server wrote rather than the tool names', () => {
    const message = toChatMessage(
      reply([
        {
          type: 'tool-ask_user_question',
          toolCallId: 'a',
          state: 'output-available',
          input: { text: '要哪个方向？' },
          output: 'asked',
        } as never,
        { type: 'data-blocked', data: {} } as never,
      ]),
    );

    expect(message.blocked).toBe(true);
  });

  it('leaves an ordinary turn unmarked', () => {
    const message = toChatMessage(reply([{ type: 'text', text: 'done' } as never]));

    expect(message.blocked).toBeUndefined();
  });
});

describe('the sentence a running tool declares', () => {
  it('travels from the part to the call, so no table of tool names is needed here', () => {
    const message = toChatMessage(
      reply([
        {
          type: 'tool-web_search',
          toolCallId: 'a',
          state: 'input-available',
          input: { query: 'q' },
          toolMetadata: { runningLine: 'chat.tool.searching' },
        } as never,
      ]),
      { streaming: true },
    );

    expect(message.toolCalls?.[0]?.runningLine).toBe('chat.tool.searching');
  });

  it('leaves it off a tool that declares none', () => {
    const message = toChatMessage(
      reply([
        {
          type: 'tool-propose_canvas_action',
          toolCallId: 'a',
          state: 'input-available',
          input: {},
        } as never,
      ]),
      { streaming: true },
    );

    expect(message.toolCalls?.[0]?.runningLine).toBeUndefined();
  });
});
