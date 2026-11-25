// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * inner#1423 A16, design §6.1: one set of KaTeX options for the chat and the
 * document body.
 *
 * With `trust: false` the commands that write links, attributes or images of
 * the source's choosing render as plain error text instead, and `maxExpand`
 * stops a macro that expands itself forever. The chat's renderer is handed the
 * very same object, so the two places cannot drift apart.
 */

import { describe, it, expect, vi } from 'vitest';
import katex from 'katex';

const katexCalls: unknown[] = [];

vi.mock('rehype-katex', async (importOriginal) => {
  const actual = await importOriginal<{ default:(o?: unknown) => unknown }>();
  return {
    default: (options?: unknown) => {
      katexCalls.push(options);
      return actual.default(options as never);
    },
  };
});

const { KATEX_OPTIONS } = await import('@web/lib/katex-options');

/**
 * Renders a source with the shared options, as markup.
 * @param source - The LaTeX source.
 * @returns A detached element holding KaTeX's output.
 */
function rendered(source: string): HTMLElement {
  const host = document.createElement('div');
  host.innerHTML = katex.renderToString(source, { ...KATEX_OPTIONS, throwOnError: false });
  return host;
}

describe('the shared KaTeX options', () => {
  it('writes no link for \\href', () => {
    expect(rendered('\\href{javascript:alert(1)}{x}').querySelector('a')).toBeNull();
  });

  it('writes no data attribute for \\htmlData', () => {
    expect(rendered('\\htmlData{a=b}{x}').querySelector('[data-a]')).toBeNull();
  });

  it('writes no image for \\includegraphics', () => {
    expect(rendered('\\includegraphics{x.png}').querySelector('img')).toBeNull();
  });

  it('stops a macro that expands itself instead of hanging', () => {
    expect(() => katex.renderToString('\\def\\a{\\a}\\a', { ...KATEX_OPTIONS, throwOnError: true })).toThrow();
  });

  it('is the object the chat hands its renderer', async () => {
    const { render } = await import('@testing-library/react');
    const { createElement } = await import('react');
    const { MarkdownMessage } = await import('@web/pages/project/chat/MarkdownMessage');
    katexCalls.length = 0;
    render(createElement(MarkdownMessage, { content: 'a line', streaming: false }));
    expect(katexCalls[0]).toBe(KATEX_OPTIONS);
  });
});
