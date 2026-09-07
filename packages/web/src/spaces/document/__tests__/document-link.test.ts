// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The link control's three answers, none of which the popover can get wrong
 * without the user losing work.
 *
 * 1. Does this selection hold a link, and which one. Three design rounds were
 *    spent here: a probe that reads the two endpoints answers five of the nine
 *    relative positions wrongly, in both directions. It misses a link the
 *    selection swallows whole (triple-click, select-all), and it claims one
 *    the selection merely touches — which would strip a link the user never
 *    selected. The table below is every relative position a selection can hold
 *    against a link, and it is the reason the probe reads the range.
 * 2. What a write does to the document. BlockNote's own `createLink` adds the
 *    mark with no URI check and no `preventAutolink` meta
 *    (`StyleManager.ts:197-210`), so both writes here carry their own: without
 *    the meta a removal puts the link straight back with its protocol
 *    downgraded, and without the check a `javascript:` href reaches every peer.
 * 3. What an unqualified string becomes. It reaches every peer and the
 *    markdown export, so it is stored with its protocol.
 *
 * Positions are looked up by the text they cover rather than written as
 * numbers. The flat model wraps every block in two more nodes than the tiptap
 * document did, so a literal here would say nothing about what it points at
 * and would have to be re-derived by hand on the next structural change.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { AllSelection, TextSelection } from '@tiptap/pm/state';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import * as Y from 'yjs';
import { documentBodyFragment } from '@breatic/shared';

import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';
import {
  resolveLinkSelection,
  applyLink,
  removeLink,
  normalizeLinkUrl,
  isLinkUrlShaped,
  canLinkSpan,
  DEFAULT_LINK_PROTOCOL,
} from '@web/spaces/document/document-link';

type DocumentEditor = ReturnType<typeof buildDocumentEditor>;

const editors: DocumentEditor[] = [];

afterEach(() => {
  editors.splice(0).forEach((e) => {
    e.unmount();
  });
});

/**
 * A mounted document holding the given blocks.
 * @param blocks - The body, in BlockNote's own shape.
 * @returns The editor.
 */
function open(blocks: readonly Record<string, unknown>[]): DocumentEditor {
  const doc = new Y.Doc();
  const editor = buildDocumentEditor({ fragment: documentBodyFragment(doc) });
  const root = document.createElement('div');
  document.body.appendChild(root);
  editor.mount(root);
  editors.push(editor);
  editor.replaceBlocks(editor.document, blocks as never);
  return editor;
}

const HREF = 'https://a.example/docs';
const OTHER = 'https://b.example/other';

/**
 * One link with text either side of it, no spaces at the seams.
 *
 * No spaces, because a selection whose endpoint lands exactly on a link
 * boundary is the default shape wherever the writing system has no word gaps,
 * and it is the shape the endpoint probe answers wrongly.
 * @returns The editor.
 */
function openOneLink(): DocumentEditor {
  return open([
    {
      type: 'paragraph',
      content: [
        { type: 'text', text: 'see', styles: {} },
        { type: 'link', href: HREF, content: 'our docs' },
        { type: 'text', text: 'for more', styles: {} },
      ],
    },
  ]);
}

/**
 * Where the given text sits in the body.
 * @param editor - The editor to search.
 * @param needle - The text to find.
 * @returns The span it occupies.
 * @throws {Error} When the body does not hold it.
 */
function spanOf(
  editor: DocumentEditor,
  needle: string,
): { from: number; to: number } {
  let found: { from: number; to: number } | null = null;
  editor.prosemirrorState.doc.descendants(
    (node: ProseMirrorNode, pos: number) => {
      if (found !== null || !node.isText) return true;
      const at = (node.text ?? '').indexOf(needle);
      if (at >= 0) found = { from: pos + at, to: pos + at + needle.length };
      return true;
    },
  );
  if (found === null) throw new Error(`no ${JSON.stringify(needle)} in the body`);
  return found;
}

/** Puts the selection over the given span. */
function select(
  editor: DocumentEditor,
  span: { from: number; to: number },
): void {
  const view = editor.prosemirrorView!;
  view.dispatch(
    view.state.tr.setSelection(
      TextSelection.create(view.state.doc, span.from, span.to),
    ),
  );
}

/**
 * Whether the given range carries a link mark.
 * @param editor - The editor.
 * @param span - The range to ask about.
 * @returns True when some part of it carries one.
 */
function hasLinkMark(
  editor: DocumentEditor,
  span: { from: number; to: number },
): boolean {
  return editor.prosemirrorState.doc.rangeHasMark(
    span.from,
    span.to,
    editor.pmSchema.marks.link!,
  );
}

/**
 * The href stored in the document at the given position.
 *
 * Read from the document rather than from rendered HTML: a renderer may
 * neutralise an href it disapproves of, so the output can look clean while the
 * mark itself is in the document and on its way to every peer.
 * @param editor - The editor.
 * @param pos - A position inside the link's text.
 * @returns The href, or null when nothing there carries a link.
 */
function storedHrefAt(editor: DocumentEditor, pos: number): string | null {
  const node = editor.prosemirrorState.doc.nodeAt(pos);
  const mark = node?.marks.find((m) => m.type === editor.pmSchema.marks.link);
  return typeof mark?.attrs.href === 'string' ? mark.attrs.href : null;
}

/** Every href the body holds, in document order. */
function storedHrefs(editor: DocumentEditor): string[] {
  const hrefs: string[] = [];
  editor.prosemirrorState.doc.descendants((node: ProseMirrorNode) => {
    node.marks.forEach((mark) => {
      if (mark.type === editor.pmSchema.marks.link) {
        const { href } = mark.attrs;
        if (typeof href === 'string') hrefs.push(href);
      }
    });
    return true;
  });
  return hrefs;
}

describe('which link a selection holds', () => {
  /**
   * Eight relative positions a selection can hold against one link, each
   * expressed as an offset from the link's own span. The ninth shape, a
   * select-all, has its own case below — it is a different kind of selection
   * rather than another position.
   */
  const POSITIONS: readonly {
    name: string;
    from: (link: { from: number; to: number }) => number;
    to: (link: { from: number; to: number }) => number;
    holdsLink: boolean;
  }[] = [
    { name: 'exactly the link', from: (l) => l.from, to: (l) => l.to, holdsLink: true },
    { name: 'from inside the link out', from: (l) => l.from + 2, to: (l) => l.to + 2, holdsLink: true },
    { name: 'from outside the link in', from: (l) => l.from - 2, to: (l) => l.from + 2, holdsLink: true },
    { name: 'swallowing the link whole', from: (l) => l.from - 2, to: (l) => l.to + 2, holdsLink: true },
    { name: 'the whole paragraph', from: (l) => l.from - 3, to: (l) => l.to + 8, holdsLink: true },
    { name: 'touching the link end, no overlap', from: (l) => l.to, to: (l) => l.to + 8, holdsLink: false },
    { name: 'touching the link start, no overlap', from: (l) => l.from - 3, to: (l) => l.from, holdsLink: false },
    { name: 'clear of the link', from: (l) => l.to + 2, to: (l) => l.to + 6, holdsLink: false },
  ];

  POSITIONS.forEach((position) => {
    it(`answers ${position.holdsLink ? 'the link' : 'no link'} for a selection ${position.name}`, () => {
      const editor = openOneLink();
      const link = spanOf(editor, 'our docs');
      select(editor, { from: position.from(link), to: position.to(link) });

      const resolved = resolveLinkSelection(editor.prosemirrorState);

      if (position.holdsLink) {
        expect(resolved.range).toEqual(link);
        expect(resolved.href).toBe(HREF);
      } else {
        expect(resolved.range).toBeNull();
        expect(resolved.href).toBeNull();
      }
    });
  });

  it('answers the link for a select-all', () => {
    const editor = openOneLink();
    const view = editor.prosemirrorView!;
    view.dispatch(view.state.tr.setSelection(new AllSelection(view.state.doc)));

    const resolved = resolveLinkSelection(editor.prosemirrorState);

    expect(resolved.range).toEqual(spanOf(editor, 'our docs'));
    expect(resolved.href).toBe(HREF);
  });

  it('answers no link for a document holding none', () => {
    const editor = open([{ type: 'paragraph', content: 'plain' }]);
    select(editor, spanOf(editor, 'plain'));

    expect(resolveLinkSelection(editor.prosemirrorState).range).toBeNull();
  });
});

describe('which of two adjacent links a selection takes', () => {
  /**
   * Two links touching, `first` then `second`.
   * @returns The editor.
   */
  function openTwoLinks(): DocumentEditor {
    return open([
      {
        type: 'paragraph',
        content: [
          { type: 'link', href: HREF, content: 'first' },
          { type: 'link', href: OTHER, content: 'second' },
        ],
      },
    ]);
  }

  it('takes the earlier one when dragged forwards', () => {
    const editor = openTwoLinks();
    const first = spanOf(editor, 'first');
    const second = spanOf(editor, 'second');
    select(editor, { from: first.from, to: second.to });

    const resolved = resolveLinkSelection(editor.prosemirrorState);

    expect(resolved.range).toEqual(first);
    expect(resolved.href).toBe(HREF);
  });

  it('takes the earlier one when dragged backwards', () => {
    // `$from` is the document-order end whichever way the drag went, so this
    // pair and the one above must resolve to the same link.
    const editor = openTwoLinks();
    const first = spanOf(editor, 'first');
    const second = spanOf(editor, 'second');
    const view = editor.prosemirrorView!;
    view.dispatch(
      view.state.tr.setSelection(
        TextSelection.create(view.state.doc, second.to, first.from),
      ),
    );

    const resolved = resolveLinkSelection(editor.prosemirrorState);

    expect(resolved.range).toEqual(first);
    expect(resolved.href).toBe(HREF);
  });

  it('leaves the other one alone when the first is unlinked', () => {
    const editor = openTwoLinks();
    const first = spanOf(editor, 'first');
    const second = spanOf(editor, 'second');
    select(editor, { from: first.from, to: second.to });

    removeLink(editor, first);

    expect(hasLinkMark(editor, first)).toBe(false);
    expect(storedHrefs(editor)).toContain(OTHER);
  });
});

describe('what a write leaves in the document', () => {
  it('links only the resolved range, not the rest of the selection', () => {
    const editor = openOneLink();
    const link = spanOf(editor, 'our docs');
    select(editor, { from: link.from - 2, to: link.to + 2 });

    applyLink(editor, link, OTHER);

    expect(hasLinkMark(editor, spanOf(editor, 'see'))).toBe(false);
    expect(hasLinkMark(editor, spanOf(editor, 'for more'))).toBe(false);
    expect(storedHrefs(editor)).toEqual([OTHER]);
  });

  it('leaves no link behind when one is removed', () => {
    const editor = openOneLink();
    const link = spanOf(editor, 'our docs');

    removeLink(editor, link);

    expect(hasLinkMark(editor, link)).toBe(false);
    expect(storedHrefs(editor)).toEqual([]);
  });

  it('leaves no link behind when the link text is itself an address', () => {
    // What pasting a URL leaves behind: the visible text reads as an address,
    // and the mark runs to the space after it. Autolink re-links a change
    // whose range ends in whitespace when the text scans as one, and a bare
    // transaction carries nothing to tell it not to — measured, the mark comes
    // straight back. The trailing space is part of the span for that reason: a
    // range one short of it leaves the space marked, and a transaction without
    // the meta then produces output identical to one with it.
    const editor = open([
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: 'see', styles: {} },
          { type: 'link', href: 'https://example.com', content: 'example.com ' },
          { type: 'text', text: 'ok', styles: {} },
        ],
      },
    ]);
    const link = spanOf(editor, 'example.com ');

    removeLink(editor, link);

    expect(hasLinkMark(editor, link)).toBe(false);
    expect(storedHrefs(editor)).toEqual([]);
  });

  it('keeps a script href out of the document', () => {
    const editor = openOneLink();
    const link = spanOf(editor, 'our docs');

    applyLink(editor, link, 'javascript:alert(1)');

    expect(storedHrefAt(editor, link.from + 2)).toBe(HREF);
  });

  it('keeps a data href out of the document', () => {
    const editor = openOneLink();
    const link = spanOf(editor, 'our docs');

    applyLink(editor, link, 'data:text/html,x');

    expect(storedHrefAt(editor, link.from + 2)).toBe(HREF);
  });
});

describe('what an unqualified string becomes', () => {
  it('carries the default protocol', () => {
    expect(normalizeLinkUrl('example.com')).toBe(`${DEFAULT_LINK_PROTOCOL}://example.com`);
  });

  it('defaults to https', () => {
    expect(DEFAULT_LINK_PROTOCOL).toBe('https');
  });

  it('leaves a qualified string alone', () => {
    expect(normalizeLinkUrl(HREF)).toBe(HREF);
  });

  it('is what reaches the document', () => {
    const editor = open([{ type: 'paragraph', content: 'plain' }]);

    applyLink(editor, spanOf(editor, 'plain'), normalizeLinkUrl('example.com'));

    expect(storedHrefs(editor)).toEqual(['https://example.com']);
  });

  it('is also what autolink gives a URL typed into the body', () => {
    // The vendored extension recognises a URL followed by a space on its own,
    // and holds its protocol as a private constant it offers no way to set
    // (`Link/link.ts:12`). This is where the two are held to the same answer:
    // nothing passes ours along, so only a case can tell us they have parted.
    const editor = open([{ type: 'paragraph', content: '' }]);
    editor.insertInlineContent('example.com ');

    expect(storedHrefs(editor)).toEqual(['https://example.com']);
  });

  it('leaves a typed email address as text, so a mailto: link is hand-made', () => {
    // Which is why `mailto:` earns its place on the hosted-scheme exception
    // list by being a thing people type, not by being a thing this editor
    // writes: autolink recognises URLs and not addresses.
    const editor = open([{ type: 'paragraph', content: '' }]);
    editor.insertInlineContent('someone@a.example ');

    expect(storedHrefs(editor)).toEqual([]);
    expect(isLinkUrlShaped('mailto:someone@a.example')).toBe(true);
  });

  it('drops the whitespace a paste carries in', () => {
    // Dragging across an address in another app puts a space on one end of the
    // clipboard often enough to be the normal case rather than the odd one.
    expect(normalizeLinkUrl(' example.com')).toBe('https://example.com');
    expect(normalizeLinkUrl('example.com ')).toBe('https://example.com');
    expect(normalizeLinkUrl(` ${HREF} `)).toBe(HREF);
  });

  it('keeps whitespace out of what reaches the document', () => {
    const editor = open([{ type: 'paragraph', content: 'plain' }]);

    applyLink(editor, spanOf(editor, 'plain'), normalizeLinkUrl('example.com '));

    expect(storedHrefs(editor)).toEqual(['https://example.com']);
  });
});

describe('which span the panel anchors to', () => {
  it('takes the link when the selection holds one', () => {
    const editor = openOneLink();
    const link = spanOf(editor, 'our docs');
    select(editor, link);

    expect(resolveLinkSelection(editor.prosemirrorState).range).toEqual(link);
  });

  // A selection holding no link is anchored to the selection itself: the panel
  // builds a DOM Range over it (`DocumentLinkPopover`'s `panelReference`). Over
  // a select-all there is no panel at all — the bar carries no link button
  // there (§4.6).
});

describe('which spans can carry a link at all', () => {
  // The question the button asks before it lets itself be pressed. Two ways a
  // span refuses a link: a mark that excludes it (inline `code`), and a node
  // whose content spec allows no marks (`codeBlock`, spec `marks: ""`). Asking
  // only about the first leaves the second live — measured, a link written over
  // a code block leaves the document byte-identical.
  /**
   * Whether the given text can carry a link.
   * @param editor - The editor.
   * @param needle - The text to ask about.
   * @returns The answer.
   */
  function canLink(editor: DocumentEditor, needle: string): boolean {
    const span = spanOf(editor, needle);
    return canLinkSpan(editor.prosemirrorState, span.from, span.to);
  }

  it('accepts ordinary prose', () => {
    const editor = open([{ type: 'paragraph', content: 'plain words here' }]);
    expect(canLink(editor, 'plain words')).toBe(true);
  });

  it('accepts prose that already holds a link', () => {
    const editor = openOneLink();
    expect(canLink(editor, 'our docs')).toBe(true);
  });

  it('refuses inline code', () => {
    const editor = open([
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: 'run ', styles: {} },
          { type: 'text', text: 'npm ci', styles: { code: true } },
          { type: 'text', text: ' first', styles: {} },
        ],
      },
    ]);
    expect(canLink(editor, 'npm ci')).toBe(false);
  });

  it('refuses a span that only partly holds inline code', () => {
    const editor = open([
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: 'run ', styles: {} },
          { type: 'text', text: 'npm ci', styles: { code: true } },
          { type: 'text', text: ' first', styles: {} },
        ],
      },
    ]);
    const run = spanOf(editor, 'run ');
    const code = spanOf(editor, 'npm ci');
    expect(canLinkSpan(editor.prosemirrorState, run.from, code.to)).toBe(false);
  });

  it('refuses a code block', () => {
    const editor = open([{ type: 'codeBlock', content: 'npm install' }]);
    expect(canLink(editor, 'npm install')).toBe(false);
  });

  it('refuses a span running from prose into a code block', () => {
    const editor = open([
      { type: 'paragraph', content: 'see this' },
      { type: 'codeBlock', content: 'npm i x' },
    ]);
    const prose = spanOf(editor, 'see this');
    const code = spanOf(editor, 'npm i x');
    expect(canLinkSpan(editor.prosemirrorState, prose.from, code.to)).toBe(false);
  });
});

describe('which strings are shaped like a URL', () => {
  // `mailto:` and `tel:` carry no host at all, which is what their schemes are
  // for, so a host question would refuse both. They are written by hand — the
  // case above measures autolink leaving a typed email address alone.
  //
  // `a.example/a b` qualifies before the check runs, so its space lands in a
  // path, where it is legal. Its twin sits in UNSHAPED with the space in the
  // host.
  const SHAPED = [
    'example.com',
    HREF,
    'breatic',
    '192.168.1.1',
    // A colon is not a scheme. RFC 3986 §3.1 says a scheme starts with a
    // letter, so this string carries none and gets qualified like any bare
    // address, leaving `8080` as a single-label host and `80` as its port.
    // Read as already-qualified it parses as nothing and is refused.
    '8080:80',
    'a.example/a b',
    'mailto:someone@a.example',
    'tel:+15551234567',
    // Whitespace on either end is what a paste carries, not a defect in the
    // address. Refusing these shows `link.invalid` — a message about the
    // address's shape — for a shape that is fine.
    ' example.com',
    'example.com ',
    ` ${HREF}`,
  ];
  // `example.com:8080` carries a scheme by RFC 3986's grammar — a scheme may
  // hold dots — so it is read as one, and the URI check refuses the scheme
  // `example.com:`. Pinned as the behaviour it is; #908 is where the question
  // of what a person means by it gets decided.
  const UNSHAPED = [
    'hello world',
    'a b.com',
    'hello<world',
    'htp:/breatic',
    '',
    'example.com:8080',
  ];

  SHAPED.forEach((raw) => {
    it(`accepts ${JSON.stringify(raw)}`, () => {
      expect(isLinkUrlShaped(raw)).toBe(true);
    });
  });

  UNSHAPED.forEach((raw) => {
    it(`refuses ${JSON.stringify(raw)}`, () => {
      expect(isLinkUrlShaped(raw)).toBe(false);
    });
  });

  it('refuses a host a parser handed back with the space encoded into it', () => {
    // The case above runs here against Node's parser, which refuses
    // `https://hello world` outright — so in this runtime the answer never
    // comes from the host at all. In front of the user it does: the browsers
    // accept the same string and percent-encode the space into the host,
    // measured as `hello%20world` in Chromium. Standing a parser that behaves
    // that way in front of the check is what pins the answer users get.
    // Both fields the check reads. A stand-in carrying only the one the case
    // is about would leave the other `undefined`, and the scheme test would
    // then wave every address through without ever looking at a host.
    class EncodingURL {
      protocol: string;

      hostname: string;

      /**
       * @param input - The address to parse.
       */
      constructor(input: string) {
        this.protocol = `${input.slice(0, input.indexOf(':'))}:`;
        const afterScheme = input.slice(input.indexOf('://') + 3);
        this.hostname = encodeURIComponent(afterScheme.split('/')[0] ?? '');
      }
    }
    vi.stubGlobal('URL', EncodingURL);

    try {
      expect(new URL('https://hello world').hostname).toBe('hello%20world');
      expect(isLinkUrlShaped('hello world')).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
