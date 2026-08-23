// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

import { MarkdownMessage } from '@web/pages/project/chat/MarkdownMessage';

function draw(content: string, streaming = false) {
  return render(<MarkdownMessage content={content} streaming={streaming} />);
}

/** The prose container every assertion below searches from. */
function body(): HTMLElement {
  return screen.getByTestId('markdown-body');
}

describe('MarkdownMessage — elements (R1)', () => {
  it('gives headings, emphasis and inline code their own elements', () => {
    draw('# Top\n\n## Second\n\nA line with **bold** and *italic* and `code`.');

    expect(body().querySelector('h1')).toHaveTextContent('Top');
    expect(body().querySelector('h2')).toHaveTextContent('Second');
    expect(body().querySelector('strong')).toHaveTextContent('bold');
    expect(body().querySelector('em')).toHaveTextContent('italic');
    expect(body().querySelector('code')).toHaveTextContent('code');
  });

  it('gives both list kinds, quotes and rules their own elements', () => {
    draw('- one\n- two\n\n1. first\n2. second\n\n> quoted line\n\n---');

    expect(body().querySelectorAll('ul > li')).toHaveLength(2);
    expect(body().querySelectorAll('ol > li')).toHaveLength(2);
    expect(body().querySelector('blockquote')).toHaveTextContent('quoted line');
    expect(body().querySelector('hr')).toBeInTheDocument();
  });

  it('puts a fenced block in pre > code and keeps the language', () => {
    draw('```typescript\nconst x = 1;\n```');

    const code = body().querySelector('pre > code');
    expect(code).toHaveTextContent('const x = 1;');
    expect(code?.className).toContain('language-typescript');
  });

  it('builds a table with its header cells', () => {
    draw('| Item | Value |\n|---|---|\n| Size | 33 KB |');

    expect(body().querySelectorAll('th')).toHaveLength(2);
    expect(body().querySelectorAll('td')).toHaveLength(2);
  });

  it('strikes through', () => {
    draw('this part is ~~withdrawn~~ now');
    expect(body().querySelector('del')).toHaveTextContent('withdrawn');
  });

  it('renders an image with its alt text', () => {
    draw('![a diagram](https://example.com/a.png)');

    const img = body().querySelector('img');
    expect(img?.getAttribute('src')).toBe('https://example.com/a.png');
    expect(img?.getAttribute('alt')).toBe('a diagram');
  });

  it('links inline, bare and reference-style spellings alike', () => {
    draw(
      'inline [docs](https://a.example.com).\n\n' +
        'bare https://b.example.com here.\n\n' +
        'reference [the spec][spec].\n\n[spec]: https://c.example.com',
    );

    const hrefs = [...body().querySelectorAll('a')].map((a) => a.getAttribute('href'));
    expect(hrefs).toContain('https://a.example.com');
    expect(hrefs).toContain('https://b.example.com');
    // The address for this one lives in another block: the whole message has
    // to go through one renderer for the two halves to meet.
    expect(hrefs).toContain('https://c.example.com');
  });

  it('puts the footnote prose on screen', () => {
    // A reference and its definition are two blocks. Rendered block by block
    // the definition yields an empty string and this sentence disappears.
    draw('A claim[^1].\n\n[^1]: The footnote prose the model wrote.');

    const section = body().querySelector('section[data-footnotes]');
    expect(section).toHaveTextContent('The footnote prose the model wrote.');
    expect(body().querySelector('sup > a')).toHaveTextContent('1');
  });

  it('draws its own tick for a task list', () => {
    draw('- [x] done\n- [ ] pending');

    expect(body().querySelector('input[type="checkbox"]')).toBeNull();
    expect(body().querySelector('ul.contains-task-list')).toBeInTheDocument();
    expect(body()).toHaveTextContent('done');
  });
});

describe('MarkdownMessage — completion mid-stream (R2)', () => {
  it('shows an unclosed bold marker as bold right away', () => {
    draw('this is **still open', true);

    expect(body().querySelector('strong')).toHaveTextContent('still open');
    expect(body().textContent).not.toContain('**');
  });

  it('shows an unclosed strikethrough as struck right away', () => {
    draw('this one is ~~still open', true);

    expect(body().querySelector('del')).toHaveTextContent('still open');
    expect(body().textContent).not.toContain('~~');
  });

  it('leaves a half-typed link as plain words rather than a dead anchor', () => {
    // The default mode closes it into streamdown:incomplete-link, which
    // renders an <a> whose href goes nowhere; in a single-page app that is a
    // full reload, and the turn being streamed goes with it.
    draw('see the [official docs](https://ai-sdk.dev/docs/trouble', true);

    expect(body().querySelector('a')).toBeNull();
    expect(body()).toHaveTextContent('see the official docs');
  });

  it('leaves a lone backtick alone and closes the live marker instead', () => {
    // With every handler on, the closing tick goes to that lone backtick and
    // the ** actually being streamed stays open.
    draw('press ` to continue\n\nand then **the bold being written', true);

    expect(body().querySelector('code')).toBeNull();
    expect(body().querySelector('strong')).toHaveTextContent('the bold being written');
  });

  it('leaves a C pointer alone and closes the live marker instead', () => {
    draw('look at int *p = &x; there\n\nand then **the bold being written', true);

    expect(body().querySelector('em')).toBeNull();
    expect(body()).toHaveTextContent('int *p = &x;');
    // Without this half a component rendering nothing would pass.
    expect(body().querySelector('strong')).toHaveTextContent('the bold being written');
  });
});

describe('MarkdownMessage — a settled message (R3)', () => {
  it('shows an unclosed marker literally while finished spans still render', () => {
    // An interrupted reply carries unclosed markers: that is what the model
    // actually sent. Asserting both halves rules out rendering nothing.
    draw('## Section\n\n**finished bold** first, then this is **still open', false);

    expect(body().querySelector('h2')).toHaveTextContent('Section');
    expect(body().querySelector('strong')).toHaveTextContent('finished bold');
    expect(body().querySelectorAll('strong')).toHaveLength(1);
    expect(body()).toHaveTextContent('**still open');
  });

  it('keeps a lone backtick and star while real inline code still renders', () => {
    draw('press ` to continue, see int *p = &x; there, and `real code` here', false);

    expect(body().querySelectorAll('code')).toHaveLength(1);
    expect(body().querySelector('code')).toHaveTextContent('real code');
    expect(body().querySelector('em')).toBeNull();
    expect(body()).toHaveTextContent('int *p = &x;');
  });
});

describe('MarkdownMessage — inline HTML (R4)', () => {
  it('turns script and iframe into words while markdown around them renders', () => {
    draw('**bold** and <script>alert(1)</script> and <iframe src="https://e.com"></iframe>');

    expect(body().querySelector('script')).toBeNull();
    expect(body().querySelector('iframe')).toBeNull();
    expect(body()).toHaveTextContent('alert(1)');
    expect(body().querySelector('strong')).toHaveTextContent('bold');
  });

  it('turns an ordinary tag into words too', () => {
    draw('# Heading\n\n<div class="x">the words inside</div>');

    expect(body().querySelector('div.x')).toBeNull();
    expect(body()).toHaveTextContent('the words inside');
    expect(body().querySelector('h1')).toHaveTextContent('Heading');
  });

  it('drops a tag carrying an event handler while markdown images survive', () => {
    draw('<img src="x" onerror="alert(1)">\n\n![real](https://example.com/ok.png)');

    const imgs = [...body().querySelectorAll('img')];
    // The markdown one is here; the inline HTML one is not.
    expect(imgs).toHaveLength(1);
    expect(imgs[0]?.getAttribute('src')).toBe('https://example.com/ok.png');
  });
});

describe('MarkdownMessage — typography hooks', () => {
  it('sits on the text-sm step (R6)', () => {
    draw('a line');
    expect(body().className).toContain('text-sm');
  });

  it('carries the chat-markdown scope (R5)', () => {
    draw('a line');
    expect(body().className).toContain('chat-markdown');
  });
});
