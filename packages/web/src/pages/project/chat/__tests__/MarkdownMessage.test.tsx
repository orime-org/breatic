// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

import { MarkdownMessage } from '@web/pages/project/chat/MarkdownMessage';
import { expectNoA11yViolations } from '@web/test-utils/a11y';

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

  it('leaves a lone backtick alone, and stops completing after it', () => {
    // Two halves, and the second is a limitation worth pinning.
    //
    // With inlineCode on, that lone backtick takes a closing tick and a long
    // run of prose turns into inline code on screen. Off, it stays a
    // character — but remend still reads everything after it as sitting
    // inside an unterminated code span, so the ** further down is left alone
    // too. Completion downstream of a lone backtick does not happen.
    //
    // It lasts until the model sends the closing marker, and a settled
    // message never runs completion at all, so both states end up showing
    // exactly what was sent.
    draw('press ` to continue\n\nand then **the bold being written', true);

    expect(body().querySelector('code')).toBeNull();
    expect(body().querySelector('strong')).toBeNull();
    expect(body()).toHaveTextContent('**the bold being written');
  });

  it('completes normally when no lone backtick precedes the marker', () => {
    draw('a clean opening line\n\nand then **the bold being written', true);

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
    // Separate blocks on purpose: a code span does not cross a blank line, so
    // the lone backtick cannot pair with the one opening `real code`. Put them
    // in one paragraph and CommonMark pairs the first two ticks it meets —
    // which is the language's rule, not something this component decides.
    draw('press ` to continue, see int *p = &x; there\n\nand `real code` here', false);

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

describe('MarkdownMessage — the waiting dot (R7)', () => {
  /** The dot, or null when this render carries none. */
  function dot(): HTMLElement | null {
    return document.querySelector('[data-testid="chat-waiting-dot"]');
  }

  it('rides the last character of a paragraph', () => {
    draw('still gathering the last two', true);
    expect(dot()?.parentElement?.tagName).toBe('P');
  });

  it('rides the last character of a list item', () => {
    // Taking the last text node in the tree lands on the newline between
    // blocks here, whose parent is the ul itself.
    draw('three ways:\n\n- copy the settled spec\n- write our own', true);

    const items = [...body().querySelectorAll('li')];
    expect(dot()?.parentElement).toBe(items[items.length - 1]);
  });

  it('rides the cell being typed in a half-written table row', () => {
    // GFM pads the row out to the header's column count, so the last cell is
    // an empty one the model has not reached.
    draw('| Item | A | B |\n|---|---|---|\n| Size | 33 KB', true);

    const cells = [...body().querySelectorAll('td')];
    expect(cells.length).toBeGreaterThan(1);
    expect(dot()?.parentElement).toBe(cells[1]);
  });

  it('rides inside a code block while the colouring survives', () => {
    // Insert before the highlighter and rehype-highlight rebuilds the code
    // element's children, taking the dot with them.
    draw('```typescript\nconst x = 1;', true);

    expect(dot()?.closest('code')).toBeInTheDocument();
    expect(body().querySelector('.hljs-keyword')).toBeInTheDocument();
  });

  it('lands after a block that holds no text at all', () => {
    // Three shapes with no text node of their own. Prose precedes each one,
    // so a fallback keyed on the whole tree never fires and the dot would sit
    // in that earlier paragraph instead.
    for (const tail of ['---', '![a](https://example.com/a.png)', '```typescript']) {
      const { unmount } = draw(`a line of prose\n\n${tail}`, true);

      const mark = dot();
      expect(mark).not.toBeNull();
      // Sits at the top level, after that block. Were the search keyed on the
      // whole tree it would be inside the paragraph above instead.
      expect(mark?.parentElement).toBe(body());
      expect(mark?.previousElementSibling).toBe(body().lastElementChild?.previousElementSibling);
      unmount();
    }
  });

  it('stays out of the footnote section', () => {
    // remark-gfm moves every footnote definition to the end of the document,
    // so document order stops matching arrival order.
    draw('A claim[^1].\n\n[^1]: the note.\n\nprose still being written', true);

    expect(dot()?.closest('section[data-footnotes]')).toBeNull();
    expect(dot()?.parentElement).toHaveTextContent('prose still being written');
  });

  it('is absent once the turn has settled', () => {
    draw('the finished reply', false);
    expect(dot()).toBeNull();
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

describe('MarkdownMessage — completion adds nothing the model did not send (R2, R3)', () => {
  it('keeps everything after an unclosed angle bracket while streaming', () => {
    // `Record<string, Handler`, `count<max`, "wrap it in a <div" — a reply that
    // says any of these is still a reply that has to keep being drawn.
    render(
      <MarkdownMessage
        content={'when count<max we stop\n\n```ts\nconst a = 1;\n```\n\nand a closing line'}
        streaming
      />,
    );

    expect(body()).toHaveTextContent('when count<max we stop');
    expect(body().querySelector('pre > code')).toHaveTextContent('const a = 1;');
    expect(body()).toHaveTextContent('and a closing line');
  });

  it('leaves a lone pair of dollar signs alone while streaming', () => {
    // The shell's PID variable, a Makefile escape, `awk '{print $$1}'`. Nothing
    // in this pipeline renders maths, so a closing `$$` is two characters the
    // reader is shown and can copy that the model never sent.
    render(<MarkdownMessage content={'the pid is $$ and that is all'} streaming />);

    expect(body().textContent).toBe('the pid is $$ and that is all');
  });

  it('still closes the markers R2 promises', () => {
    // The switches that stay on have to keep working after the two that go off.
    const { container } = render(<MarkdownMessage content='half a **word' streaming />);
    expect(container.querySelector('strong')).toHaveTextContent('word');
  });
});

describe('MarkdownMessage — the dot follows literal HTML too (R7)', () => {
  it('trails a tag the model wrote inside a paragraph', () => {
    // Nothing renders this as markup, so the tag is four characters of the
    // reply like any other. The mark belongs after them.
    draw('a line<br>', true);

    const mark = screen.getByTestId('chat-waiting-dot');
    expect(mark.parentElement?.lastChild).toBe(mark);
  });

  it('trails a tag that arrived as its own block', () => {
    // A tag on a line of its own prints at the top level, beside the
    // paragraphs rather than inside one.
    draw('some prose\n\n<details><summary>more</summary>', true);

    const mark = screen.getByTestId('chat-waiting-dot');
    expect(body().textContent).toContain('<summary>more</summary>');
    expect(mark.previousSibling?.textContent).toContain('<summary>more</summary>');
    expect(body().lastChild).toBe(mark);
  });
});

describe('MarkdownMessage — a checklist reads as a checklist (R11)', () => {
  it('tells a done item from an open one', () => {
    // Reading an assistant reply is viewing existing content, which
    // docs/ACCESSIBILITY.md keeps inside the promised set. With the state left
    // to the drawn tick alone, both items announce as the same plain bullet.
    draw('- [x] shipped\n- [ ] pending');

    const items = [...body().querySelectorAll('li')];
    expect(items).toHaveLength(2);
    expect(items[0]?.textContent).not.toBe(items[1]?.textContent);
    expect(items[0]?.querySelector('.sr-only')?.textContent).toBe('Done');
    expect(items[1]?.querySelector('.sr-only')?.textContent).toBe('Not done');
    // R11 holds: the state is stated, the browser still draws nothing.
    expect(body().querySelector('input[type="checkbox"]')).toBeNull();
  });

  it('keeps the drawn tick out of the reading', () => {
    // The tick and the word say the same thing; hearing it twice is noise.
    draw('- [x] shipped');

    expect(body().querySelector('.chat-markdown-task-mark')).toHaveAttribute('aria-hidden');
  });

  it('has no a11y violations', async () => {
    draw('- [x] shipped\n- [ ] pending');
    await expectNoA11yViolations(document.body);
  });
});
