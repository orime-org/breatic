// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * #985 acceptance B1 and B2: a press on a link in the body opens it.
 *
 * The address opens in a new tab and the document is left alone — the press
 * neither navigates this page nor rewrites the selection. Reaching the link
 * itself stays possible through the toolbar, which the caret and the pointer
 * both raise.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import * as Y from 'yjs';

import { documentBodyFragment } from '@breatic/shared';

import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';

const mounted: ReturnType<typeof buildDocumentEditor>[] = [];

afterEach(() => {
  mounted.splice(0).forEach((editor) => {
    editor.unmount();
  });
  vi.restoreAllMocks();
});

/**
 * Opens an editor over one paragraph.
 * @param content - The paragraph's inline content.
 * @returns The editor.
 */
function open(content: unknown[]): ReturnType<typeof buildDocumentEditor> {
  const editor = buildDocumentEditor({
    fragment: documentBodyFragment(new Y.Doc()),
  });
  const root = document.createElement('div');
  document.body.appendChild(root);
  editor.mount(root);
  mounted.push(editor);
  editor.replaceBlocks(editor.document, [
    { type: 'paragraph', content },
  ] as never);
  return editor;
}

/**
 * Presses the anchor at the given index the way a reader does.
 * @param editor - The editor.
 * @param index - Which anchor, in document order.
 */
function pressLink(
  editor: ReturnType<typeof buildDocumentEditor>,
  index: number,
): void {
  const view = editor.prosemirrorView!;
  const anchor = [...view.dom.querySelectorAll('a')][index]!;
  const event = new MouseEvent('click', { bubbles: true, button: 0 });
  Object.defineProperty(event, 'target', { value: anchor });
  view.someProp('handleClick', (handler) =>
    handler(view, view.posAtDOM(anchor, 0), event),
  );
}

/** A link run. */
function link(text: string, href: string): Record<string, unknown> {
  return { type: 'link', href, content: text };
}

describe('the anchor a link renders as', () => {
  it('carries the attribute the click handler looks for', () => {
    // `clickHandler` finds the link by `a[data-inline-content-type="link"]`
    // (`Link/helpers/clickHandler.ts:33-35`, `:48-50`) and answers nothing at
    // all without it, so every case below rests on this one.
    const editor = open([link('ONE', 'https://one.example/')]);
    const anchor = editor.prosemirrorView!.dom.querySelector('a')!;

    expect(anchor.getAttribute('data-inline-content-type')).toBe('link');
  });
});

/** What the toolbar's controller asks about the element under the pointer. */
function probeLinkAt(
  editor: ReturnType<typeof buildDocumentEditor>,
  element: HTMLElement,
): { mark: { attrs: { href: string } }; text: string } | undefined {
  const extension = editor.getExtension('linkToolbar') as unknown as {
    getLinkAtElement: (
      el: HTMLElement,
    ) => { mark: { attrs: { href: string } }; text: string } | undefined;
  };
  return extension.getLinkAtElement(element);
}

describe('the link under an element', () => {
  it('is found for a link of a single character', () => {
    // What the pointer route asks: the controller hands the element under the
    // pointer to `getLinkAtElement`. Probing one character into the anchor
    // lands on the end boundary of a one-character run, and the link mark is
    // declared `inclusive: false` (`.../Link/link.ts:74`), so the marks there
    // drop it — such a link raised no toolbar at all.
    const editor = open([
      { type: 'text', text: 'see ', styles: {} },
      link('A', 'https://one.example/'),
      { type: 'text', text: ' now', styles: {} },
    ]);
    const anchor = editor.prosemirrorView!.dom.querySelector('a')!;

    const found = probeLinkAt(editor, anchor);

    expect(found?.mark.attrs.href).toBe('https://one.example/');
    expect(found?.text).toBe('A');
  });

  it('is found for a longer one too', () => {
    const editor = open([
      { type: 'text', text: 'see ', styles: {} },
      link('ONE', 'https://one.example/'),
    ]);
    const anchor = editor.prosemirrorView!.dom.querySelector('a')!;

    const found = probeLinkAt(editor, anchor);

    expect(found?.text).toBe('ONE');
  });
});

describe('pressing a link in the body', () => {
  it('opens its address in a new tab', () => {
    const opened = vi.spyOn(window, 'open').mockReturnValue(null);
    const editor = open([link('ONE', 'https://one.example/')]);

    pressLink(editor, 0);

    expect(opened).toHaveBeenCalledTimes(1);
    expect(opened.mock.calls[0]![0]).toBe('https://one.example/');
    expect(opened.mock.calls[0]![1]).toBe('_blank');
  });

  it('opens it without a handle back to this tab', () => {
    // The implicit `noopener` the HTML spec gives `<a target=_blank>` does not
    // reach a `window.open` call, so the opened page keeps `window.opener` and
    // can navigate this tab wherever it likes. Addresses in a shared document
    // come from co-editors and from pastes.
    const opened = vi.spyOn(window, 'open').mockReturnValue(null);
    const editor = open([link('ONE', 'https://one.example/')]);

    pressLink(editor, 0);

    expect(opened.mock.calls[0]![2]).toContain('noopener');
    expect(opened.mock.calls[0]![2]).toContain('noreferrer');
  });

  it('opens nothing for an address the renderer refused', () => {
    // Addresses arrive from co-editors as well as from this keyboard, and a
    // peer's client can hold one our own write path refuses. BlockNote answers
    // a refused address by rendering the anchor with `href=""`
    // (`.../Link/link.ts:119-126`, `isValidLink` defaulting to `isAllowedUri`
    // at `:87`). An empty href attribute RESOLVES to the document's own
    // address, so reading `anchor.href` hands back this app's URL — pressing
    // such a link would open a second editor session in a new tab, holding a
    // writable collab seat.
    const opened = vi.spyOn(window, 'open').mockReturnValue(null);
    const editor = open([link('ONE', 'javascript:alert(1)')]);
    const anchor = editor.prosemirrorView!.dom.querySelector('a')!;
    expect(anchor.getAttribute('href')).toBe('');

    pressLink(editor, 0);

    expect(opened).not.toHaveBeenCalled();
  });

  it('opens the one that was pressed when two links touch', () => {
    // `ONE` ends where `TWO` opens, so both runs answer to one position. The
    // anchor the reader pressed is what decides which address opens.
    const opened = vi.spyOn(window, 'open').mockReturnValue(null);
    const editor = open([
      link('ONE', 'https://one.example/'),
      link('TWO', 'https://two.example/'),
    ]);

    pressLink(editor, 1);

    expect(opened.mock.calls[0]![0]).toBe('https://two.example/');
  });

  it('leaves the document as it was', () => {
    // Green from the first run, and that is the point: a press has never
    // written to the document, and the change this file drives does not put a
    // write there either. `toJSON` reads the content alone, so the half of the
    // press that IS changing — the selection — is pinned by the case below.
    vi.spyOn(window, 'open').mockReturnValue(null);
    const editor = open([
      { type: 'text', text: 'go ', styles: {} },
      link('ONE', 'https://one.example/'),
    ]);
    const before = editor.prosemirrorView!.state.doc.toJSON();

    pressLink(editor, 0);

    expect(editor.prosemirrorView!.state.doc.toJSON()).toEqual(before);
  });

  it('does not select the whole link', () => {
    // The press used to answer by selecting the link end to end, which is what
    // made the toolbar unreachable: `getLinkAtSelection` returns nothing while
    // the selection is not empty.
    vi.spyOn(window, 'open').mockReturnValue(null);
    const editor = open([link('ONE', 'https://one.example/')]);

    pressLink(editor, 0);

    const { from, to } = editor.prosemirrorView!.state.selection;
    expect(editor.prosemirrorView!.state.doc.textBetween(from, to)).not.toBe(
      'ONE',
    );
  });
});
