// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect, afterEach } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

import { changeLocale } from '@web/i18n/locale-bootstrap';
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

describe('MarkdownMessage — the dot stays out of inline elements (R7)', () => {
  it('follows struck-through text without being struck through itself', () => {
    // Inside the del the mark takes the line-through the browser draws over
    // that element's whole box.
    draw('this is ~~gone~~', true);

    const mark = screen.getByTestId('chat-waiting-dot');
    expect(mark.closest('del')).toBeNull();
    expect(body().querySelector('del')).toHaveTextContent('gone');
  });

  it('follows inline code without joining the code chip', () => {
    draw('run `npm test`', true);

    const mark = screen.getByTestId('chat-waiting-dot');
    expect(mark.closest('code')).toBeNull();
    expect(body().querySelector('code')).toHaveTextContent('npm test');
  });

  it('follows a link without joining its hit area', () => {
    draw('see [the docs](https://example.com)', true);

    const mark = screen.getByTestId('chat-waiting-dot');
    expect(mark.closest('a')).toBeNull();
    expect(body().querySelector('a')).toHaveTextContent('the docs');
  });

  it('still rides the text inside a code block', () => {
    // The block-level pre > code is where the mark belongs, and the mark has
    // to keep landing there.
    draw('```ts\nconst a = 1;', true);

    const mark = screen.getByTestId('chat-waiting-dot');
    expect(mark.closest('pre')).not.toBeNull();
  });
});

describe('MarkdownMessage — the status word stays out of copied text (R11)', () => {
  it('copies a checklist as the model wrote it', () => {
    // Selecting a reply and copying it takes textContent. A word placed there
    // for a screen reader travels with it: "Done✓ shipped" is not what the
    // model sent.
    draw('- [x] shipped\n- [ ] pending');

    expect(body().textContent).not.toContain('Done');
    expect(body().textContent).not.toContain('Not done');
    expect(body().textContent).toContain('shipped');
    expect(body().textContent).toContain('pending');
  });

  it('still tells a done item from an open one', () => {
    draw('- [x] shipped\n- [ ] pending');

    const marks = [...body().querySelectorAll('.chat-markdown-task-mark')];
    expect(marks).toHaveLength(2);
    expect(marks[0]?.getAttribute('aria-label')).toBe('Done');
    expect(marks[1]?.getAttribute('aria-label')).toBe('Not done');
    expect(body().querySelector('input[type="checkbox"]')).toBeNull();
  });

  it('has no a11y violations', async () => {
    draw('- [x] shipped\n- [ ] pending');
    await expectNoA11yViolations(document.body);
  });
});

describe('MarkdownMessage — the footnote section speaks the reader\'s language (R1)', () => {
  afterEach(() => {
    // Unmount first: changing the locale notifies every mounted subscriber,
    // and a live component would take that update outside act().
    cleanup();
    changeLocale('en');
  });

  it('labels the section and the back link from the catalogue', () => {
    // remark-rehype writes both of these itself, in English, and they are the
    // only words a screen reader gets for the footnote machinery. Asserted in
    // a non-English locale: the English strings the library ships are the same
    // words our own catalogue holds, so an English assertion passes either way.
    changeLocale('zh-CN');
    draw('A claim[^1].\n\n[^1]: the note');

    expect(body().querySelector('section[data-footnotes] h2')?.textContent).toBe('脚注');
    expect(
      body().querySelector('a[data-footnote-backref]')?.getAttribute('aria-label'),
    ).toBe('回到引用 1');
  });
});

describe('MarkdownMessage — footnotes stay inside their own reply (R1)', () => {
  it('gives each back-link its own name when one note is cited twice', () => {
    // The library passes which citation this is; both links land on the same
    // note, so the number is the only thing telling a reader them apart.
    draw('First[^a] and again[^a].\n\n[^a]: the note');

    const labels = [...body().querySelectorAll('a[data-footnote-backref]')].map((a) =>
      a.getAttribute('aria-label'),
    );
    expect(labels).toHaveLength(2);
    expect(labels[0]).not.toBe(labels[1]);
  });

  it('does not reuse another reply\'s footnote ids', () => {
    // Every reply in the conversation renders into one document. With a fixed
    // prefix the second reply's marker points at the first reply's note.
    const { container } = render(
      <>
        <MarkdownMessage content={'First reply[^1].\n\n[^1]: source A'} />
        <MarkdownMessage content={'Second reply[^1].\n\n[^1]: source B'} />
      </>,
    );

    const ids = [...container.querySelectorAll('[id]')].map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);

    const markers = [...container.querySelectorAll('sup > a')];
    expect(markers).toHaveLength(2);
    const targets = markers.map((a) =>
      container.querySelector(`[id="${(a.getAttribute('href') ?? '').slice(1)}"]`),
    );
    expect(targets[0]).not.toBe(targets[1]);
    expect(targets[0]?.textContent).toContain('source A');
    expect(targets[1]?.textContent).toContain('source B');

    // The heading each marker describes has to be the one in its own reply.
    const described = [...container.querySelectorAll('[aria-describedby]')].map((e) =>
      e.getAttribute('aria-describedby'),
    );
    expect(new Set(described).size).toBe(2);
    for (const value of described) {
      expect(container.querySelector(`[id="${value}"]`)).not.toBeNull();
    }
  });
});

describe('MarkdownMessage — scoping the footnote heading leaves the reply alone (R3)', () => {
  it('keeps the model\'s own words when they spell the library\'s id', () => {
    // An assistant explaining footnote markup can put those characters in an
    // alt, a link target or a picture's source. They are the reply's content.
    const { container } = render(
      <MarkdownMessage content={'![footnote-label](d.png) and [x](footnote-label)'} />,
    );

    expect(container.querySelector('img')?.getAttribute('alt')).toBe('footnote-label');
    expect(container.querySelector('a')?.getAttribute('href')).toBe('footnote-label');
  });

  it('still points each marker at the heading in its own reply', () => {
    const { container } = render(<MarkdownMessage content={'A[^1].\n\n[^1]: a note.'} />);

    const described = container.querySelector('[aria-describedby]')?.getAttribute('aria-describedby');
    expect(described).toBeDefined();
    expect(described).not.toBe('footnote-label');
    expect(container.querySelector(`[id="${described}"]`)?.tagName).toBe('H2');
  });
});

describe('WaitingDot — a streaming code block (R7)', () => {
  it('rides the last characters instead of the newline that ends their line', () => {
    // A fence renders its whitespace, so a mark placed after the terminating
    // newline draws on the line below the code that has arrived.
    const { container } = render(
      <MarkdownMessage content={'```js\nconst a = 1;'} streaming />,
    );

    const mark = container.querySelector('[data-testid="chat-waiting-dot"]');
    expect(mark).not.toBeNull();
    expect(mark?.previousSibling?.textContent?.endsWith(';')).toBe(true);
    // The line terminator is still in the block, just behind the mark.
    expect(container.querySelector('code')?.textContent).toBe('const a = 1;\n');
  });

  it('rides them when the line ends inside a coloured token', () => {
    // A string or a comment running over several lines is one token, so the
    // newline that ends the line just received sits inside that span rather
    // than beside it.
    for (const source of ['```python\nx = """line one\nline two', '```js\n/* first\n second']) {
      const { container, unmount } = render(<MarkdownMessage content={source} streaming />);

      const mark = container.querySelector('[data-testid="chat-waiting-dot"]');
      expect(mark).not.toBeNull();
      expect(mark?.previousSibling?.textContent?.endsWith('\n')).toBe(false);
      // Every character the model sent is still there, in order.
      expect(container.querySelector('code')?.textContent).toBe(
        `${source.split('\n').slice(1).join('\n')}\n`,
      );
      unmount();
    }
  });
});
