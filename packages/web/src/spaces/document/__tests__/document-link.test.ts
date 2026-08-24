// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * The link control's three answers, none of which the popover can get wrong
 * without the user losing work.
 *
 * 1. Does this selection hold a link, and which one. Three design rounds were
 *    spent here: a probe that reads the two endpoints answers four of the nine
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

import { describe, it, expect, afterEach } from 'vitest';
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
  /** Every relative position a selection can hold against one link. */
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
    // straight back. `example.com ` is [4,15).
    const editor = open('<p>see<a href="https://example.com">example.com </a>ok</p>');

    removeLink(editor, { from: 4, to: 15 });

    expect(hasLinkMark(editor, 4, 15)).toBe(false);
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
});

describe('which strings are shaped like a URL', () => {
  const SHAPED = ['example.com', HREF, 'breatic', '192.168.1.1'];
  const UNSHAPED = ['hello world', 'htp:/breatic', ''];

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
});
