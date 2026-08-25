// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

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

  it('colours a fenced block by the language it names (R10)', () => {
    // `language-typescript` above says only that the fence carried a name.
    // These say a grammar read the code: `const` came back a keyword and `1`
    // a number, which is the whole of what colouring the block means here.
    draw('```typescript\nconst x = 1;\n```');

    const code = body().querySelector('pre > code');
    expect(code?.querySelector('.hljs-keyword')).toHaveTextContent('const');
    expect(code?.querySelector('.hljs-number')).toHaveTextContent('1');
  });

  it('leaves a block that names no language uncoloured (R10)', () => {
    // Detection stays off, so a nameless block is text and nothing guesses at
    // it — a wrong guess would paint the code in colours that mean something.
    draw('```\nconst x = 1;\n```');

    const code = body().querySelector('pre > code');
    expect(code).toHaveTextContent('const x = 1;');
    expect(code?.querySelector('[class^="hljs-"]')).toBeNull();
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

  it('keeps a half-typed link off this page', () => {
    // Mid-stream the address is a placeholder scheme, which the url transform
    // drops. What matters is that clicking it leaves the running turn alone,
    // and `target` is what says so.
    draw('see the [official docs](https://ai-sdk.dev/docs/trouble', true);

    const a = body().querySelector('a');
    expect(a?.getAttribute('target')).toBe('_blank');
    expect(body()).toHaveTextContent('see the official docs');
  });

  it('stops completing downstream of a lone backtick', () => {
    // remend reads everything after a lone backtick as sitting inside an
    // unterminated code span, so the `**` further down is left as it came.
    // The library behaves this way whatever the switches say; it lasts until
    // the model sends the closing marker.
    draw('press ` to continue\n\nand then **the bold being written', true);

    expect(body().querySelector('strong')).toBeNull();
    expect(body()).toHaveTextContent('**the bold being written');
  });

  it('completes normally when no lone backtick precedes the marker', () => {
    draw('a clean opening line\n\nand then **the bold being written', true);

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

describe('MarkdownMessage — a link leaves this page alone (R1)', () => {
  it('opens what the agent links to in a new tab', () => {
    // The reader is part-way through making something. Following a link in the
    // same tab takes the canvas, the project and the running turn with it.
    draw('详见 [官方文档](https://ai-sdk.dev/docs)');

    const a = body().querySelector('a');
    expect(a?.getAttribute('target')).toBe('_blank');
    expect(a?.getAttribute('rel')).toBe('noopener noreferrer');
  });

  it('does the same for a bare URL the model typed', () => {
    // `remark-gfm` turns these into anchors of its own.
    draw('见 https://ai-sdk.dev/docs 那一页');

    const a = body().querySelector('a');
    expect(a?.getAttribute('href')).toBe('https://ai-sdk.dev/docs');
    expect(a?.getAttribute('target')).toBe('_blank');
    expect(a?.getAttribute('rel')).toBe('noopener noreferrer');
  });

  it('leaves a footnote marker pointing within the reply', () => {
    // These are anchors too, and they lead to a place on this page.
    draw('A claim[^1].\n\n[^1]: The note.');

    const marker = body().querySelector('sup > a');
    expect(marker?.getAttribute('href')).toMatch(/^#/);
    expect(marker?.getAttribute('target')).toBeNull();
  });
});

describe('MarkdownMessage — a finished reply is exactly what the model sent (R3)', () => {
  // Completion runs only while a turn is running, so these say what the reader
  // is left with. What the same replies look like part-way through is the
  // library's business and is not promised (user 2026-08-25).
  const CHARACTERS_THAT_ALSO_MEAN_SOMETHING = [
    ['angle bracket', 'when count<max we stop'],
    ['dollar signs', 'the pid is $$ and awk print $1'],
    ['C pointer', 'look at int *p = &x; there'],
    ['a lone backtick', 'press ` to continue'],
  ] as const;

  for (const [what, content] of CHARACTERS_THAT_ALSO_MEAN_SOMETHING) {
    it(`keeps ${what} once the turn is over`, () => {
      draw(content, false);
      expect(body().textContent).toBe(content);
    });
  }

  it('keeps a tilde-fenced code block as the model wrote it', () => {
    draw('~~~bash\necho hi\n~~~', false);

    expect(body().querySelector('pre > code')?.textContent).toBe('echo hi\n');
  });

  it('still closes the markers R2 promises', () => {
    const { container } = render(<MarkdownMessage content='half a **word' streaming />);
    expect(container.querySelector('strong')).toHaveTextContent('word');
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
    // One back link per citation, each returning to its own. What tells a
    // screen reader which is which is this name, since the accessible name
    // comes from the label rather than from the arrow the eye reads.
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

