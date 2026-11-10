// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The values the running line hands its sentence (inner#1664).
 *
 * `web_fetch` declares `chat.tool.readingPages`, an ICU plural that names the
 * site when one page is being read and the count when several are. The line
 * reads both off the call's `pages` argument, which arrives as a half-built
 * object while the model is still writing it, so the site shows up as its
 * address does (plan §9 Z); until a first address parses, the count is 0 and
 * the sentence names no site.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';

import { ToolRunLine } from '@web/pages/project/chat/ToolRunLine';
import type { ToolCall } from '@web/pages/project/chat/types';

const translate = vi.hoisted(() =>
  vi.fn((key: string, values?: Record<string, string | number>): string => `${key} ${JSON.stringify(values ?? {})}`),
);

vi.mock('@web/i18n/use-translation', () => ({ useTranslation: () => translate }));

/** The running line `web_fetch` declares. */
const READING = 'chat.tool.readingPages';

/**
 * A call in flight.
 * @param name - Which tool.
 * @param args - What it was called with so far.
 * @param runningLine - The sentence key it declared.
 * @returns The call.
 */
function running(name: string, args: ToolCall['args'], runningLine: string): ToolCall {
  return { id: `c-${name}`, name, args, status: 'pending', runningLine };
}

/**
 * The values the line's sentence was formatted with.
 * @param key - The sentence key.
 * @returns The values of the last call with that key.
 */
function valuesFor(key: string): Record<string, string | number> | undefined {
  const call = translate.mock.calls.filter(([k]) => k === key).at(-1);
  return call?.[1];
}

beforeEach(() => {
  translate.mockClear();
});

describe('the line while web_fetch reads pages', () => {
  it('names the site and a count of one for one page', () => {
    render(<ToolRunLine call={running('web_fetch', { pages: [{ url: 'https://www.example.com/x' }] }, READING)} />);

    const values = valuesFor(READING);
    expect({ host: values?.host, count: values?.count }).toEqual({ host: 'www.example.com', count: 1 });
  });

  it('counts every page when several are read', () => {
    render(
      <ToolRunLine
        call={running(
          'web_fetch',
          {
            pages: [
              { url: 'https://a.example.com/1' },
              { url: 'https://b.example.com/2', start: 4000 },
              { url: 'https://c.example.com/3' },
            ],
          },
          READING,
        )}
      />,
    );

    const values = valuesFor(READING);
    expect({ host: values?.host, count: values?.count }).toEqual({ host: 'a.example.com', count: 3 });
  });

  it.each<[string, ToolCall['args']]>([
    ['no pages yet', {}],
    ['pages that is not a list', { pages: 'https://www.example.com/x' }],
    ['a first link that is not a URL', { pages: [{ url: 'not a url' }] }],
    ['a first entry with no link yet', { pages: [{}] }],
    ['a first link cut before its host', { pages: [{ url: 'https:' }] }],
  ])('says neither site nor count for %s', (_label, args) => {
    render(<ToolRunLine call={running('web_fetch', args, READING)} />);

    const values = valuesFor(READING);
    expect({ host: values?.host, count: values?.count }).toEqual({ host: '', count: 0 });
  });
});

describe('the line while the arguments of web_fetch are still arriving', () => {
  it('names the site as far as its address has arrived, then the whole site', () => {
    const { rerender } = render(
      <ToolRunLine call={running('web_fetch', { pages: [{ url: 'https://www.exa' }] }, READING)} />,
    );
    expect({ host: valuesFor(READING)?.host, count: valuesFor(READING)?.count }).toEqual({
      host: 'www.exa',
      count: 1,
    });

    rerender(<ToolRunLine call={running('web_fetch', { pages: [{ url: 'https://www.example.com/x' }] }, READING)} />);
    expect({ host: valuesFor(READING)?.host, count: valuesFor(READING)?.count }).toEqual({
      host: 'www.example.com',
      count: 1,
    });
  });

  it('counts a second page as soon as its entry opens', () => {
    render(
      <ToolRunLine
        call={running('web_fetch', { pages: [{ url: 'https://a.example.com/1' }, {}] }, READING)}
      />,
    );

    expect({ host: valuesFor(READING)?.host, count: valuesFor(READING)?.count }).toEqual({
      host: 'a.example.com',
      count: 2,
    });
  });
});

describe('the line while web_search runs', () => {
  it('still hands the sentence the query', () => {
    render(<ToolRunLine call={running('web_search', { query: 'cyberpunk city' }, 'chat.tool.searching')} />);

    expect(valuesFor('chat.tool.searching')?.query).toBe('cyberpunk city');
  });
});
