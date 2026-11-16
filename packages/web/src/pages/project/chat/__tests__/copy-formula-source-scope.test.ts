// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * inner#1423 design 6.6: the chat's formula copy handler.
 *
 * It replaces each KaTeX formula in a copy with its source. Inside a reply it
 * wraps that source in an element carrying `data-math` / `data-math-block`, so
 * the document body pastes a formula back; outside the chat's messages (the
 * document body draws KaTeX too) it leaves the copy alone.
 */

import { afterEach, describe, expect, it } from 'vitest';
import katex from 'katex';

import '@web/pages/project/chat/copy-formula-source';

afterEach(() => {
  window.getSelection()?.removeAllRanges();
  document.body.innerHTML = '';
});

/** What a copy event handed the clipboard, and whether it was taken over. */
interface Copied {
  readonly data: Record<string, string>;
  readonly prevented: boolean;
}

/**
 * Selects everything in an element and fires a copy from it.
 * @param element - What the user dragged across.
 * @returns The clipboard and whether the default copy was stopped.
 */
function copyAll(element: Element): Copied {
  const range = document.createRange();
  range.selectNodeContents(element);
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
  const data: Record<string, string> = {};
  const event = new Event('copy', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'clipboardData', {
    value: {
      setData: (format: string, value: string) => {
        data[format] = value;
      },
      getData: (format: string) => data[format] ?? '',
    },
  });
  element.dispatchEvent(event);
  return { data, prevented: event.defaultPrevented };
}

/**
 * A container holding a sentence with an inline formula and a formula on a
 * line of its own, as KaTeX draws them.
 * @param attributes - Attributes the container carries.
 * @returns The container, in the page.
 */
function withFormulas(attributes: Record<string, string>): HTMLElement {
  const host = document.createElement('div');
  for (const [name, value] of Object.entries(attributes)) host.setAttribute(name, value);
  host.innerHTML =
    `<p>Mass is ${katex.renderToString('E=mc^2', { output: 'htmlAndMathml' })}.</p>` +
    katex.renderToString('\\int x', { output: 'htmlAndMathml', displayMode: true });
  document.body.appendChild(host);
  return host;
}

describe('the chat formula copy handler', () => {
  it('marks each formula copied from a reply with its source, for the document body to read back', () => {
    // A reply's root, as `MarkdownMessage` draws it.
    const reply = withFormulas({ class: 'chat-markdown text-sm', 'data-testid': 'markdown-body' });
    const { data } = copyAll(reply);
    const held = document.createElement('div');
    held.innerHTML = data['text/html'] ?? '';
    expect(held.querySelector('[data-math]')?.getAttribute('data-math')).toBe('E=mc^2');
    expect(held.querySelector('[data-math]')?.textContent).toBe('$$E=mc^2$$');
    expect(held.querySelector('[data-math-block]')?.getAttribute('data-math-block')).toBe('\\int x');
    expect(held.querySelector('[data-math-block]')?.textContent).toBe('$$\n\\int x\n$$');
  });

  it('leaves a copy from outside the chat\'s messages to whoever owns it', () => {
    const body = withFormulas({ class: 'doc-body' });
    const { data, prevented } = copyAll(body);
    expect(prevented).toBe(false);
    expect(data).toEqual({});
  });
});
