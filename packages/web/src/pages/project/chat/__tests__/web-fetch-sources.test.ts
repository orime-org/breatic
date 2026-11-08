// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * What a turn's page reads leave on the reply (inner#1664).
 *
 * `web_fetch` hands out citation numbers from the same run as `web_search`,
 * so the pages it read join the same source row and the same citation table.
 * One page reached by both tools carries two numbers, possibly under two
 * spellings of its link; the row shows it once, merged by `pageLinkKey`.
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import type { UIMessage } from 'ai';
import { FAILURE_LINES } from '@breatic/shared';

import { toChatMessage } from '@web/pages/project/chat/to-chat-message';

/** One source as a tool answers with it. */
interface Found {
  url: string;
  title: string;
  publisher: string;
  index: number;
}

/**
 * One finished `web_search` part.
 * @param id - The tool call id.
 * @param sources - The sources it handed out.
 * @returns The part.
 */
function searched(id: string, sources: Found[]): UIMessage['parts'][number] {
  return {
    type: 'tool-web_search',
    toolCallId: id,
    state: 'output-available',
    input: { query: 'q', count: 5 },
    output: {
      query: 'q',
      sent: sources.length,
      sources: sources.map((s) => ({ ...s, excerpts: ['page text'] })),
    },
  } as unknown as UIMessage['parts'][number];
}

/**
 * One finished `web_fetch` part, shaped like `FetchAnswer`.
 * @param id - The tool call id.
 * @param sources - The pages it read, each with its number.
 * @param unread - Links in the same call that could not be read.
 * @returns The part.
 */
function fetched(id: string, sources: Found[], unread: string[] = []): UIMessage['parts'][number] {
  return {
    type: 'tool-web_fetch',
    toolCallId: id,
    state: 'output-available',
    input: { pages: [...sources.map((s) => ({ url: s.url })), ...unread.map((url) => ({ url }))] },
    output: {
      pages: [
        ...sources.map((s) => ({
          url: s.url,
          status: 'ok',
          title: s.title,
          kind: 'html',
          chars_total: 9,
          start: 0,
          end: 9,
          next_start: null,
          text: 'page text',
          links: [],
          index: s.index,
        })),
        ...unread.map((url) => ({ url, status: 'needs_login', links: [] })),
      ],
      sources,
    },
  } as unknown as UIMessage['parts'][number];
}

/**
 * One `web_fetch` part that failed as a whole.
 * @param id - The tool call id.
 * @returns The part.
 */
function failedFetch(id: string): UIMessage['parts'][number] {
  return {
    type: 'tool-web_fetch',
    toolCallId: id,
    state: 'output-error',
    input: { pages: [{ url: 'https://gone.example/x' }] },
    errorText: FAILURE_LINES.pagesUnreadable,
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

describe('pages web_fetch read, in the source row', () => {
  it('lists a page it read exactly as a search result is listed', () => {
    const message = toChatMessage(
      reply([fetched('f', [{ url: 'https://vitest.dev/g', title: 'Guide', publisher: 'Vitest', index: 1 }])]),
    );

    expect(message.sources).toEqual([
      { url: 'https://vitest.dev/g', title: 'Guide', publisher: 'Vitest', indexes: [1] },
    ]);
    expect(message.citations?.[1]).toEqual({
      url: 'https://vitest.dev/g',
      title: 'Guide',
      publisher: 'Vitest',
      indexes: [1],
    });
  });

  it('lists every page one call read, and only the pages in its sources', () => {
    const message = toChatMessage(
      reply([
        fetched(
          'f',
          [
            { url: 'https://a.example/1', title: 'A', publisher: 'A', index: 1 },
            { url: 'https://b.example/2', title: 'B', publisher: 'B', index: 2 },
          ],
          ['https://mp.weixin.qq.com/s/locked'],
        ),
      ]),
    );

    expect(message.sources?.map((s) => [s.url, s.indexes])).toEqual([
      ['https://a.example/1', [1]],
      ['https://b.example/2', [2]],
    ]);
  });

  it('adds nothing for a web_fetch call that failed', () => {
    const message = toChatMessage(reply([failedFetch('f')]));

    expect(message.sources).toBeUndefined();
    expect(message.citations).toBeUndefined();
  });

  it('keeps a search source when a later web_fetch failed', () => {
    const message = toChatMessage(
      reply([
        searched('s', [{ url: 'https://a.example/1', title: 'A', publisher: 'A', index: 1 }]),
        failedFetch('f'),
      ]),
    );

    expect(message.sources).toEqual([
      { url: 'https://a.example/1', title: 'A', publisher: 'A', indexes: [1] },
    ]);
  });

  it('lists search and read pages together in number order, not part order', () => {
    const message = toChatMessage(
      reply([
        fetched('f', [{ url: 'https://read.example/p', title: 'Read', publisher: 'Read', index: 6 }]),
        searched('s', [
          { url: 'https://found.example/1', title: 'One', publisher: 'One', index: 1 },
          { url: 'https://found.example/2', title: 'Two', publisher: 'Two', index: 2 },
        ]),
      ]),
    );

    expect(message.sources?.map((s) => s.indexes)).toEqual([[1], [2], [6]]);
    expect(message.citations?.[6]?.url).toBe('https://read.example/p');
  });
});

describe('one page reached by both tools', () => {
  it.each([
    ['the same spelling', 'https://same.example/page', 'https://same.example/page'],
    ['a decoded and a percent-encoded path', 'https://zh.wikipedia.org/wiki/猫', 'https://zh.wikipedia.org/wiki/%E7%8C%AB'],
    ['a percent-encoded and a decoded path', 'https://zh.wikipedia.org/wiki/%E7%8C%AB', 'https://zh.wikipedia.org/wiki/猫'],
    ['without and with a trailing slash', 'https://example.com/a', 'https://example.com/a/'],
    ['with and without a trailing slash', 'https://example.com/a/', 'https://example.com/a'],
  ])('is one row carrying both numbers under %s', (_label, searchUrl, fetchUrl) => {
    const message = toChatMessage(
      reply([
        searched('s', [{ url: searchUrl, title: 'Page', publisher: 'Site', index: 1 }]),
        fetched('f', [{ url: fetchUrl, title: 'Page', publisher: 'Site', index: 2 }]),
      ]),
    );

    expect(message.sources).toHaveLength(1);
    expect(message.sources?.[0]?.indexes).toEqual([1, 2]);
    expect(message.citations?.[1]).toBe(message.citations?.[2]);
    expect(message.citations?.[2]?.indexes).toEqual([1, 2]);
  });

  it('takes the title of a later source when the first one for the page had none', () => {
    const message = toChatMessage(
      reply([
        searched('s', [{ url: 'https://same.example/page', title: '', publisher: 'Site', index: 1 }]),
        fetched('f', [{ url: 'https://same.example/page', title: 'Real', publisher: 'Site', index: 2 }]),
      ]),
    );

    expect(message.sources).toHaveLength(1);
    expect(message.sources?.[0]?.title).toBe('Real');
    expect(message.citations?.[1]?.title).toBe('Real');
  });

  it('keeps the first title when both sources for the page have one', () => {
    const message = toChatMessage(
      reply([
        searched('s', [{ url: 'https://same.example/page', title: 'First', publisher: 'Site', index: 1 }]),
        fetched('f', [{ url: 'https://same.example/page', title: 'Second', publisher: 'Site', index: 2 }]),
      ]),
    );

    expect(message.sources?.[0]?.title).toBe('First');
  });

  it('keeps two different pages on one site as two rows', () => {
    const message = toChatMessage(
      reply([
        searched('s', [{ url: 'https://example.com/a', title: 'A', publisher: 'Site', index: 1 }]),
        fetched('f', [{ url: 'https://example.com/b', title: 'B', publisher: 'Site', index: 2 }]),
      ]),
    );

    expect(message.sources?.map((s) => [s.url, s.indexes])).toEqual([
      ['https://example.com/a', [1]],
      ['https://example.com/b', [2]],
    ]);
  });
});

describe('the merged source row, for any mix of searches and reads', () => {
  it('has one row per page, every number resolving to the row that carries it, in number order', () => {
    // Each source names one of a few pages, spelled with or without a
    // trailing slash, and arrives from either tool. Numbers are a shuffle of
    // 1..n, as concurrent calls take their numbers in answer order.
    const arbitrary = fc
      .array(fc.record({ page: fc.integer({ min: 0, max: 3 }), slash: fc.boolean(), fetch: fc.boolean() }), {
        minLength: 1,
        maxLength: 8,
      })
      .chain((specs) =>
        fc
          .shuffledSubarray(
            specs.map((_, i) => i + 1),
            { minLength: specs.length, maxLength: specs.length },
          )
          .map((numbers) => specs.map((spec, i) => ({ ...spec, index: numbers[i] as number }))),
      );

    fc.assert(
      fc.property(arbitrary, (specs) => {
        const parts = specs.map((spec, i) => {
          const source = {
            url: `https://site${spec.page}.example/p${spec.slash ? '/' : ''}`,
            title: `Page ${spec.page}`,
            publisher: `Site ${spec.page}`,
            index: spec.index,
          };
          return spec.fetch ? fetched(`f${i}`, [source]) : searched(`s${i}`, [source]);
        });

        const message = toChatMessage(reply(parts));
        const rows = message.sources ?? [];

        expect(rows).toHaveLength(new Set(specs.map((s) => s.page)).size);
        expect(rows.flatMap((r) => r.indexes).sort((a, b) => a - b)).toEqual(
          specs.map((s) => s.index).sort((a, b) => a - b),
        );
        for (const spec of specs) {
          const row = message.citations?.[spec.index];
          expect(row?.indexes).toContain(spec.index);
          expect(row?.title).toBe(`Page ${spec.page}`);
        }
        const firsts = rows.map((r) => r.indexes[0] ?? 0);
        expect(firsts).toEqual([...firsts].sort((a, b) => a - b));
      }),
    );
  });
});

describe('a failed web_fetch step in the reply', () => {
  it('names the step by its own key, with the cause', () => {
    const message = toChatMessage(reply([failedFetch('f')]));

    expect(message.failureLines).toEqual([
      { step: { key: 'chat.tool.step.webFetch' }, reason: FAILURE_LINES.pagesUnreadable, count: 1 },
    ]);
  });
});
