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
 * 2. What a write does to the document. A bare transaction loses the
 *    `preventAutolink` meta and the URI check that ride along with the
 *    extension's own commands, so removing a link puts it straight back with
 *    the protocol downgraded, and a `javascript:` href reaches every peer.
 * 3. What an unqualified string becomes. It reaches every peer and the
 *    markdown export, so it is stored with its protocol.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { Editor } from '@tiptap/core';
import { AllSelection, TextSelection } from '@tiptap/pm/state';
import * as Y from 'yjs';
import { documentBodyFragment, encodeInitialSpaceContent } from '@breatic/shared';

import {
  buildDocumentExtensions,
  DEFAULT_LINK_PROTOCOL,
} from '@web/spaces/document/document-extensions';
import {
  resolveLinkSelection,
  applyLink,
  removeLink,
  normalizeLinkUrl,
  isLinkUrlShaped,
  canLinkSpan,
} from '@web/spaces/document/document-link';

const editors: Editor[] = [];

afterEach(() => {
  editors.splice(0).forEach((e) => {
    e.destroy();
  });
});

/**
 * A document holding the given body.
 * @param bodyHtml - The body's HTML.
 * @returns The editor.
 */
function open(bodyHtml: string): Editor {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, encodeInitialSpaceContent('document'));
  const editor = new Editor({
    extensions: buildDocumentExtensions({ fragment: documentBodyFragment(doc) }),
  });
  editors.push(editor);
  editor.commands.setContent(bodyHtml);
  return editor;
}

const HREF = 'https://a.example/docs';
const OTHER = 'https://b.example/other';

/**
 * One link with text either side of it, no spaces at the seams.
 *
 * `see` is [1,4), the link is [4,12), `for more` is [12,20). No spaces,
 * because a selection whose endpoint lands exactly on a link boundary is the
 * default shape wherever the writing system has no word gaps, and it is the
 * shape the endpoint probe answers wrongly.
 * @returns The editor.
 */
function openOneLink(): Editor {
  return open(`<p>see<a href="${HREF}">our docs</a>for more</p>`);
}

/**
 * Whether the given range carries a link mark.
 * @param editor - The editor.
 * @param from - Range start.
 * @param to - Range end.
 * @returns True when some part of the range carries one.
 */
function hasLinkMark(editor: Editor, from: number, to: number): boolean {
  return editor.state.doc.rangeHasMark(from, to, editor.schema.marks.link);
}

/**
 * The href stored in the document at the given position.
 *
 * Read from the document rather than from the rendered HTML: the extension's
 * `renderHTML` neutralises an href it disapproves of to `href=""`, so HTML
 * looks clean while the mark itself is in the document and on its way to every
 * peer.
 * @param editor - The editor.
 * @param pos - A position inside the link's text.
 * @returns The href, or null when nothing there carries a link.
 */
function storedHrefAt(editor: Editor, pos: number): string | null {
  const node = editor.state.doc.nodeAt(pos);
  const mark = node?.marks.find((m) => m.type === editor.schema.marks.link);
  return typeof mark?.attrs.href === 'string' ? mark.attrs.href : null;
}

describe('which link a selection holds', () => {
  /**
   * Eight relative positions a selection can hold against one link. The ninth
   * shape, a select-all, has its own case below — it is a different kind of
   * selection rather than another position.
   */
  const POSITIONS: readonly {
    name: string;
    from: number;
    to: number;
    holdsLink: boolean;
  }[] = [
    { name: 'exactly the link', from: 4, to: 12, holdsLink: true },
    { name: 'from inside the link out', from: 6, to: 14, holdsLink: true },
    { name: 'from outside the link in', from: 2, to: 6, holdsLink: true },
    { name: 'swallowing the link whole', from: 2, to: 14, holdsLink: true },
    { name: 'the whole paragraph', from: 1, to: 20, holdsLink: true },
    { name: 'touching the link end, no overlap', from: 12, to: 20, holdsLink: false },
    { name: 'touching the link start, no overlap', from: 1, to: 4, holdsLink: false },
    { name: 'clear of the link', from: 14, to: 18, holdsLink: false },
  ];

  POSITIONS.forEach((position) => {
    it(`answers ${position.holdsLink ? 'the link' : 'no link'} for a selection ${position.name}`, () => {
      const editor = openOneLink();
      editor.commands.setTextSelection({ from: position.from, to: position.to });

      const resolved = resolveLinkSelection(editor.state);

      if (position.holdsLink) {
        expect(resolved.range).toEqual({ from: 4, to: 12 });
        expect(resolved.href).toBe(HREF);
      } else {
        expect(resolved.range).toBeNull();
        expect(resolved.href).toBeNull();
      }
    });
  });

  it('answers the link for a select-all', () => {
    const editor = openOneLink();
    const { state } = editor.view;
    editor.view.dispatch(state.tr.setSelection(new AllSelection(state.doc)));

    const resolved = resolveLinkSelection(editor.state);

    expect(resolved.range).toEqual({ from: 4, to: 12 });
    expect(resolved.href).toBe(HREF);
  });

  it('answers no link for an empty document', () => {
    const editor = open('<p>plain</p>');
    editor.commands.setTextSelection({ from: 1, to: 6 });

    expect(resolveLinkSelection(editor.state).range).toBeNull();
  });
});

describe('which of two adjacent links a selection takes', () => {
  /**
   * Two links touching, `first` at [1,6) and `second` at [6,12).
   * @returns The editor.
   */
  function openTwoLinks(): Editor {
    return open(
      `<p><a href="${HREF}">first</a><a href="${OTHER}">second</a></p>`,
    );
  }

  it('takes the earlier one when dragged forwards', () => {
    const editor = openTwoLinks();
    editor.commands.setTextSelection({ from: 1, to: 12 });

    const resolved = resolveLinkSelection(editor.state);

    expect(resolved.range).toEqual({ from: 1, to: 6 });
    expect(resolved.href).toBe(HREF);
  });

  it('takes the earlier one when dragged backwards', () => {
    // `$from` is the document-order end whichever way the drag went, so this
    // pair and the one above must resolve to the same link.
    const editor = openTwoLinks();
    const { state } = editor.view;
    editor.view.dispatch(state.tr.setSelection(TextSelection.create(state.doc, 12, 1)));

    const resolved = resolveLinkSelection(editor.state);

    expect(resolved.range).toEqual({ from: 1, to: 6 });
    expect(resolved.href).toBe(HREF);
  });

  it('leaves the other one alone when the first is unlinked', () => {
    const editor = openTwoLinks();
    editor.commands.setTextSelection({ from: 1, to: 12 });

    removeLink(editor, { from: 1, to: 6 });

    expect(hasLinkMark(editor, 1, 6)).toBe(false);
    expect(editor.getHTML()).toContain(OTHER);
  });
});

describe('what a write leaves in the document', () => {
  it('links only the resolved range, not the rest of the selection', () => {
    const editor = openOneLink();
    editor.commands.setTextSelection({ from: 2, to: 14 });

    applyLink(editor, { from: 4, to: 12 }, OTHER);

    expect(hasLinkMark(editor, 1, 4)).toBe(false);
    expect(hasLinkMark(editor, 12, 20)).toBe(false);
    expect(editor.getHTML()).toContain(OTHER);
    expect(editor.getHTML()).not.toContain(HREF);
  });

  it('leaves no link behind when one is removed', () => {
    const editor = openOneLink();

    removeLink(editor, { from: 4, to: 12 });

    expect(hasLinkMark(editor, 4, 12)).toBe(false);
    expect(editor.getHTML()).not.toContain(HREF);
  });

  it('leaves no link behind when the link text is itself an address', () => {
    // What pasting a URL leaves behind: the visible text reads as an address,
    // and the mark runs to the space after it. Autolink re-links a change
    // whose range ends in whitespace when the text scans as one, and a bare
    // transaction carries nothing to tell it not to — measured, the mark comes
    // straight back. `example.com ` is twelve characters, so the mark is
    // [4,16) — a range one short of that leaves the trailing space marked, and
    // a bare transaction then produces output identical to the command's,
    // which is what let this case pass against either.
    const editor = open('<p>see<a href="https://example.com">example.com </a>ok</p>');

    removeLink(editor, { from: 4, to: 16 });

    expect(hasLinkMark(editor, 4, 16)).toBe(false);
    expect(editor.getHTML()).not.toContain('example.com</a>');
  });

  it('keeps a script href out of the document', () => {
    const editor = openOneLink();

    applyLink(editor, { from: 4, to: 12 }, 'javascript:alert(1)');

    expect(storedHrefAt(editor, 6)).toBe(HREF);
  });

  it('keeps a data href out of the document', () => {
    const editor = openOneLink();

    applyLink(editor, { from: 4, to: 12 }, 'data:text/html,x');

    expect(storedHrefAt(editor, 6)).toBe(HREF);
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
    const editor = open('<p>plain</p>');

    applyLink(editor, { from: 1, to: 6 }, normalizeLinkUrl('example.com'));

    expect(editor.getHTML()).toContain('https://example.com');
  });

  it('is also what autolink gives a URL typed into the body', () => {
    // The extension recognises a URL followed by a space on its own. Its
    // protocol comes from the same option the popover normalises with, so the
    // two paths cannot disagree about what `example.com` means.
    const editor = open('<p></p>');
    editor.commands.setTextSelection(1);
    editor.commands.insertContent('example.com ');

    expect(editor.getHTML()).toContain('https://example.com');
  });

  it('leaves a typed email address as text, so a mailto: link is hand-made', () => {
    // Which is why `mailto:` earns its place on the hosted-scheme exception
    // list by being a thing people type, not by being a thing this editor
    // writes: autolink recognises URLs and not addresses. Measured — the body
    // below comes back as `<p>someone@a.example </p>`, no anchor.
    const editor = open('<p></p>');
    editor.commands.setTextSelection(1);
    editor.commands.insertContent('someone@a.example ');

    expect(editor.getHTML()).not.toContain('<a');
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
    const editor = open('<p>plain</p>');

    applyLink(editor, { from: 1, to: 6 }, normalizeLinkUrl('example.com '));

    expect(editor.getHTML()).toContain('href="https://example.com"');
  });
});

describe('which span the panel anchors to', () => {
  it('takes the link when the selection holds one', () => {
    const editor = openOneLink();
    editor.commands.setTextSelection({ from: 4, to: 12 });

    expect(resolveLinkSelection(editor.state).range).toEqual({ from: 4, to: 12 });
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
  // only about the first leaves the second live — measured, `setLink` over a
  // code block returns byte-identical HTML.
  it('accepts ordinary prose', () => {
    const editor = open('<p>plain words here</p>');
    expect(canLinkSpan(editor.state, 1, 12)).toBe(true);
  });

  it('accepts prose that already holds a link', () => {
    const editor = openOneLink();
    expect(canLinkSpan(editor.state, 4, 12)).toBe(true);
  });

  it('refuses inline code', () => {
    const editor = open('<p>run <code>npm ci</code> first</p>');
    expect(canLinkSpan(editor.state, 5, 11)).toBe(false);
  });

  it('refuses a span that only partly holds inline code', () => {
    const editor = open('<p>run <code>npm ci</code> first</p>');
    expect(canLinkSpan(editor.state, 1, 11)).toBe(false);
  });

  it('refuses a code block', () => {
    const editor = open('<pre><code>npm install</code></pre>');
    expect(canLinkSpan(editor.state, 1, 12)).toBe(false);
  });

  it('refuses a span running from prose into a code block', () => {
    const editor = open('<p>see this</p><pre><code>npm i x</code></pre>');
    expect(canLinkSpan(editor.state, 1, 18)).toBe(false);
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
  // hold dots — so it is read as one, and the extension's own check refuses
  // the scheme `example.com:`. Pinned as the behaviour it is; #908 is where
  // the question of what a person means by it gets decided.
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
