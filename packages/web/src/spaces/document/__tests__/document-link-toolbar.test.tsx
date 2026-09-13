// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * #916 acceptance C4 and D1 to D4: what the toolbar's two faces do.
 *
 * The controller upstream decides when the toolbar shows and over which link;
 * these cases start from that point and ask only what the presses mean. The
 * timing it owns — the delay, the travel from link to toolbar — is a real
 * pointer's business and belongs to the smoke run.
 */

import * as React from 'react';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as Y from 'yjs';

import { documentBodyFragment } from '@breatic/shared';

import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';
import { DocumentLinkToolbar } from '@web/spaces/document/DocumentLinkToolbar';

const HREF = 'https://a.example/docs';
const OTHER = 'https://b.example/more';

const mounted: ReturnType<typeof buildDocumentEditor>[] = [];

afterEach(() => {
  cleanup();
  mounted.splice(0).forEach((editor) => {
    editor.unmount();
  });
  vi.restoreAllMocks();
});

/**
 * An editor over one paragraph holding one link, and the toolbar over it.
 * @returns The editor, the span of the link, and the two controller callbacks.
 */
function openToolbar(): {
  editor: ReturnType<typeof buildDocumentEditor>;
  range: { from: number; to: number };
  setToolbarOpen: ReturnType<typeof vi.fn>;
  setToolbarPositionFrozen: ReturnType<typeof vi.fn>;
  secondLink: { from: number; to: number };
  handOver: (url: string, range: { from: number; to: number }) => void;
  unmount: () => void;
  } {
  const editor = buildDocumentEditor({
    fragment: documentBodyFragment(new Y.Doc()),
  });
  const root = document.createElement('div');
  document.body.appendChild(root);
  editor.mount(root);
  mounted.push(editor);
  editor.replaceBlocks(editor.document, [
    {
      type: 'paragraph',
      content: [
        { type: 'text', text: 'see ', styles: {} },
        { type: 'link', href: HREF, content: 'our docs' },
        { type: 'text', text: ' and ', styles: {} },
        { type: 'link', href: OTHER, content: 'more here' },
        { type: 'text', text: ' now', styles: {} },
      ],
    },
  ] as never);

  const [range, secondLink] = spansOfLinks(editor);
  const setToolbarOpen = vi.fn();
  const setToolbarPositionFrozen = vi.fn();
  const view = (url: string, span: { from: number; to: number }): React.JSX.Element => (
    <DocumentLinkToolbar
      editor={editor}
      url={url}
      text='our docs'
      range={span}
      setToolbarOpen={setToolbarOpen}
      setToolbarPositionFrozen={setToolbarPositionFrozen}
    />
  );
  const { rerender, unmount } = render(view(HREF, range));
  return {
    editor,
    range,
    secondLink,
    setToolbarOpen,
    setToolbarPositionFrozen,
    handOver: (url, span) => {
      rerender(view(url, span));
    },
    unmount,
  };
}

/**
 * Where each link in the body sits, in document order.
 * @param editor - The editor to read.
 * @returns The spans the link marks cover.
 * @throws {Error} When the body holds fewer than two links.
 */
function spansOfLinks(
  editor: ReturnType<typeof buildDocumentEditor>,
): { from: number; to: number }[] {
  const found: { from: number; to: number }[] = [];
  const { doc, schema } = editor.prosemirrorState;
  doc.descendants((node, pos) => {
    if (!node.isText) return true;
    if (node.marks.some((m) => m.type === schema.marks.link)) {
      found.push({ from: pos, to: pos + (node.text?.length ?? 0) });
    }
    return true;
  });
  if (found.length < 2) throw new Error('the body holds fewer than two links');
  return found;
}

/** Every href the body holds, in document order. */
function storedHrefs(
  editor: ReturnType<typeof buildDocumentEditor>,
): string[] {
  const hrefs: string[] = [];
  const { doc, schema } = editor.prosemirrorState;
  doc.descendants((node) => {
    node.marks.forEach((mark) => {
      if (mark.type === schema.marks.link) {
        const { href } = mark.attrs;
        if (typeof href === 'string') hrefs.push(href);
      }
    });
    return true;
  });
  return hrefs;
}

/** Where the document selection sits right now. */
function selectionSpan(
  editor: ReturnType<typeof buildDocumentEditor>,
): { from: number; to: number } {
  const { from, to } = editor.prosemirrorState.selection;
  return { from, to };
}

/** The text drawn as selected, or null when nothing is drawn. */
function markedText(
  editor: ReturnType<typeof buildDocumentEditor>,
): string | null {
  const marked = editor.prosemirrorView?.dom.querySelectorAll(
    '[data-show-selection]',
  );
  if (!marked || marked.length === 0) return null;
  return [...marked].map((node) => node.textContent ?? '').join('');
}

describe('the toolbar over a link', () => {
  it('opens showing the address and the two things to do with it', () => {
    openToolbar();

    expect(screen.getByTestId('doc-link-url')).toHaveTextContent(HREF);
    expect(screen.getByTestId('doc-link-edit')).toBeInTheDocument();
    expect(screen.getByTestId('doc-link-remove')).toBeInTheDocument();
    expect(screen.queryByTestId('doc-link-input')).not.toBeInTheDocument();
  });

  it('offers the address as something that opens in a new tab', () => {
    // The anchor's own attributes, which is what the browser acts on. Pressing
    // it in jsdom reaches no navigation, so the attributes are the behaviour.
    openToolbar();

    const address = screen.getByTestId('doc-link-url');
    expect(address).toHaveAttribute('href', HREF);
    expect(address).toHaveAttribute('target', '_blank');
    expect(address.getAttribute('rel')).toContain('noopener');
  });
});

describe('pressing edit on the toolbar', () => {
  it('swaps to the field, holding the address it showed', async () => {
    openToolbar();

    await userEvent.click(screen.getByTestId('doc-link-edit'));

    expect(screen.getByTestId('doc-link-input')).toHaveValue(HREF);
    expect(screen.queryByTestId('doc-link-url')).not.toBeInTheDocument();
  });

  it('freezes the position, so the toolbar stays where it was', async () => {
    const { setToolbarPositionFrozen } = openToolbar();

    await userEvent.click(screen.getByTestId('doc-link-edit'));

    expect(setToolbarPositionFrozen).toHaveBeenCalledWith(true);
  });

  it('leaves the document selection where it was', async () => {
    // What keeps the toolbar on screen. `getLinkAtSelection` answers with
    // nothing for a selection that is not empty
    // (`@blocknote/core/src/extensions/LinkToolbar/LinkToolbar.ts:41`), and the
    // controller answers that by dropping the link it is holding — so a press
    // on edit that moved the selection onto the link would take the toolbar
    // away instead of showing the field.
    const { editor } = openToolbar();
    const before = selectionSpan(editor);

    await userEvent.click(screen.getByTestId('doc-link-edit'));

    expect(selectionSpan(editor)).toEqual(before);
  });

  it('draws the link as selected, so the reader sees which one is changing', async () => {
    const { editor } = openToolbar();

    await userEvent.click(screen.getByTestId('doc-link-edit'));

    expect(markedText(editor)).toBe('our docs');
  });

  it('releases the position freeze when the toolbar leaves', async () => {
    // The controller drops the link it holds the moment the caret leaves it,
    // which unmounts this component without passing through confirm, escape or
    // remove. Nothing else can put the flag back, and while it stands the
    // controller returns from `onOpenChange` before it reads the reason
    // (`LinkToolbarController.tsx:124-127`) — so escape, the pointer leaving
    // and a press outside all stop closing the toolbar, for good.
    const { setToolbarPositionFrozen, unmount } = openToolbar();
    await userEvent.click(screen.getByTestId('doc-link-edit'));

    unmount();

    expect(setToolbarPositionFrozen).toHaveBeenLastCalledWith(false);
  });

  it('writes to the link it opened over when the controller hands it another', async () => {
    // A pointer that travels onto a second link makes the controller replace
    // `url` and `range` in place — its own guard only holds for a link the
    // caret found. The field is about the link the reader opened it on.
    const { editor, handOver, secondLink } = openToolbar();
    await userEvent.click(screen.getByTestId('doc-link-edit'));

    handOver(OTHER, secondLink);
    await userEvent.clear(screen.getByTestId('doc-link-input'));
    await userEvent.type(screen.getByTestId('doc-link-input'), 'c.example/x');
    await userEvent.click(screen.getByTestId('doc-link-confirm'));

    expect(storedHrefs(editor)).toEqual(['https://c.example/x', OTHER]);
  });
});

describe('confirming a new address', () => {
  it('writes it onto the same link', async () => {
    const { editor } = openToolbar();
    await userEvent.click(screen.getByTestId('doc-link-edit'));

    await userEvent.clear(screen.getByTestId('doc-link-input'));
    await userEvent.type(screen.getByTestId('doc-link-input'), 'b.example/x');
    await userEvent.click(screen.getByTestId('doc-link-confirm'));

    expect(storedHrefs(editor)).toEqual(['https://b.example/x', OTHER]);
  });

  it('returns to the address and unfreezes', async () => {
    const { setToolbarPositionFrozen } = openToolbar();
    await userEvent.click(screen.getByTestId('doc-link-edit'));

    await userEvent.clear(screen.getByTestId('doc-link-input'));
    await userEvent.type(screen.getByTestId('doc-link-input'), 'b.example/x');
    await userEvent.click(screen.getByTestId('doc-link-confirm'));

    expect(screen.getByTestId('doc-link-url')).toBeInTheDocument();
    expect(setToolbarPositionFrozen).toHaveBeenLastCalledWith(false);
  });

  it('stops drawing the link as selected', async () => {
    const { editor } = openToolbar();
    await userEvent.click(screen.getByTestId('doc-link-edit'));

    await userEvent.clear(screen.getByTestId('doc-link-input'));
    await userEvent.type(screen.getByTestId('doc-link-input'), 'b.example/x');
    await userEvent.click(screen.getByTestId('doc-link-confirm'));

    expect(markedText(editor)).toBeNull();
  });
});

describe('confirming an address that is not one', () => {
  it('says so and leaves the link alone', async () => {
    const { editor } = openToolbar();
    await userEvent.click(screen.getByTestId('doc-link-edit'));

    await userEvent.clear(screen.getByTestId('doc-link-input'));
    await userEvent.type(screen.getByTestId('doc-link-input'), 'not an address');
    await userEvent.click(screen.getByTestId('doc-link-confirm'));

    expect(screen.getByTestId('doc-link-invalid')).toBeInTheDocument();
    expect(screen.getByTestId('doc-link-input')).toHaveAttribute(
      'aria-invalid',
      'true',
    );
    expect(storedHrefs(editor)).toEqual([HREF, OTHER]);
  });
});

describe('pressing remove on the toolbar', () => {
  it('takes the link off that text', async () => {
    const { editor } = openToolbar();

    await userEvent.click(screen.getByTestId('doc-link-remove'));

    expect(storedHrefs(editor)).toEqual([OTHER]);
  });

  it('asks the controller to put the toolbar away', async () => {
    const { setToolbarOpen } = openToolbar();

    await userEvent.click(screen.getByTestId('doc-link-remove'));

    expect(setToolbarOpen).toHaveBeenCalledWith(false);
  });
});

describe('escape while the field is showing', () => {
  it('goes back to the address without writing anything', async () => {
    const { editor } = openToolbar();
    await userEvent.click(screen.getByTestId('doc-link-edit'));
    await userEvent.clear(screen.getByTestId('doc-link-input'));
    await userEvent.type(screen.getByTestId('doc-link-input'), 'b.example/x');

    await userEvent.keyboard('{Escape}');

    expect(screen.getByTestId('doc-link-url')).toBeInTheDocument();
    expect(storedHrefs(editor)).toEqual([HREF, OTHER]);
  });
});
