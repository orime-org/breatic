// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * #916 acceptance C4 and D1 to D5: what the toolbar's two faces do.
 *
 * The toolbar drives itself now, so these cases reach it the way a reader
 * does — by putting the caret in a link — rather than by handing a component
 * the link to show. The pointer route and its timing belong to the smoke run;
 * jsdom drives neither.
 *
 * Escape out of the field is one of those: `useDismiss` delivers it twice —
 * once through the floating element's own `onKeyDown`, once through its
 * listener on the document — and what separates the two answers is React
 * flushing the first before the second arrives, which only a browser does.
 * The case that says so is in `selection-bubble-bar.spec.ts`.
 *
 * ## Where the borrow cases went
 *
 * Eight cases pinned what the toolbar did with the caret it took: that it put
 * one inside the link, froze the controller's position, and handed both back
 * on each way out. The toolbar no longer touches the caret — it holds the link
 * by a handle, which is what the caret was standing in for — so those cases
 * have no subject. What they were protecting is protected by construction:
 * `document-link-toolbar` contains no `setSelection`.
 */

import * as React from 'react';
import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  render,
  screen,
  cleanup,
  fireEvent,
  waitFor,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as Y from 'yjs';
import { TextSelection } from '@tiptap/pm/state';

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
 * An editor over one paragraph holding two links, with the toolbar mounted.
 * @param options - How to open it.
 * @param options.firstText - The text of the first link.
 * @param options.firstHref - The address on the first link.
 * @param options.caret - False to leave the caret outside every link.
 * @returns The editor, the two link spans, and the render handles.
 */
function openToolbar(options?: {
  firstText?: string;
  firstHref?: string;
  caret?: boolean;
}): {
  editor: ReturnType<typeof buildDocumentEditor>;
  doc: Y.Doc;
  range: { from: number; to: number };
  secondLink: { from: number; to: number };
  unmount: () => void;
  } {
  const doc = new Y.Doc();
  const editor = buildDocumentEditor({ fragment: documentBodyFragment(doc) });
  const root = document.createElement('div');
  document.body.appendChild(root);
  editor.mount(root);
  mounted.push(editor);
  editor.replaceBlocks(editor.document, [
    {
      type: 'paragraph',
      content: [
        { type: 'text', text: 'see ', styles: {} },
        {
          type: 'link',
          href: options?.firstHref ?? HREF,
          content: options?.firstText ?? 'our docs',
        },
        { type: 'text', text: ' and ', styles: {} },
        { type: 'link', href: OTHER, content: 'more here' },
        { type: 'text', text: ' now', styles: {} },
      ],
    },
  ] as never);

  const [range, secondLink] = spansOfLinks(editor);
  const viewport = document.createElement('div');
  document.body.appendChild(viewport);
  // Rendered INTO the viewport, which is also where the toolbar portals
  // itself — as on a real page, where the scroller holding the portal is
  // inside the React root. React listens on that root, so a key pressed in
  // the toolbar reaches React's own handlers only when the portal sits under
  // it; render beside the viewport and half of every press disappears.
  const { unmount } = render(
    <DocumentLinkToolbar
      editor={editor}
      viewport={viewport}
      yielding={false}
    />,
    { wrapper: React.StrictMode, container: viewport },
  );
  if (options?.caret !== false) caretInside(editor, range!);
  return { editor, doc, range: range!, secondLink: secondLink!, unmount };
}

/** Put the caret one character into the given link. */
function caretInside(
  editor: ReturnType<typeof buildDocumentEditor>,
  span: { from: number; to: number },
): void {
  editor.transact((tr) => {
    tr.setSelection(TextSelection.create(tr.doc, span.from + 1));
  });
}

/** Where each link in the body sits, in document order. */
function spansOfLinks(
  editor: ReturnType<typeof buildDocumentEditor>,
): { from: number; to: number }[] {
  const found: { from: number; to: number }[] = [];
  const { doc, schema } = editor.prosemirrorState;
  doc.descendants((node, pos) => {
    if (node.isText && node.marks.some((m) => m.type === schema.marks.link)) {
      found.push({ from: pos, to: pos + (node.text?.length ?? 0) });
    }
    return true;
  });
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

/** The text drawn as the link being changed, or null when none is. */
function markedText(
  editor: ReturnType<typeof buildDocumentEditor>,
): string | null {
  const drawn = editor.prosemirrorView?.dom.querySelector(
    '[data-show-selection]',
  );
  return drawn ? (drawn.textContent ?? '') : null;
}

/** Let a co-editor write into the shared document. */
function peerWrites(doc: Y.Doc, write: (text: Y.XmlText) => void): void {
  const peer = new Y.Doc();
  Y.applyUpdate(peer, Y.encodeStateAsUpdate(doc));
  const group = documentBodyFragment(peer).get(0) as Y.XmlElement;
  const container = group.get(0) as Y.XmlElement;
  const paragraph = container.get(0) as Y.XmlElement;
  write(paragraph.get(0) as Y.XmlText);
  Y.applyUpdate(doc, Y.encodeStateAsUpdate(peer));
}

describe('the caret reaching a link', () => {
  it('raises the toolbar showing the address and the two things to do', async () => {
    // Acceptance A6 and D-face. The caret route needs no delay: the link is
    // either under the caret or it is not.
    openToolbar();

    await waitFor(() => {
      expect(screen.getByTestId('doc-link-toolbar')).toBeInTheDocument();
    });
    expect(screen.getByTestId('doc-link-url')).toHaveTextContent(HREF);
    expect(screen.getByTestId('doc-link-edit')).toBeVisible();
    expect(screen.getByTestId('doc-link-remove')).toBeVisible();
  });

  it('raises nothing while the caret is outside every link', () => {
    openToolbar({ caret: false });

    expect(screen.queryByTestId('doc-link-toolbar')).not.toBeInTheDocument();
  });

  it('takes it away when the caret leaves', async () => {
    const { editor } = openToolbar();
    await screen.findByTestId('doc-link-toolbar');

    editor.transact((tr) => {
      tr.setSelection(TextSelection.create(tr.doc, 1));
    });

    await waitFor(() => {
      expect(screen.queryByTestId('doc-link-toolbar')).not.toBeInTheDocument();
    });
  });

  it('reaches a link one character long', async () => {
    // Such a run has no interior, so the caret reaches it at a boundary. The
    // route used to answer with nothing there, and pressing edit on the one
    // the pointer raised took the whole toolbar off the screen.
    const { editor, range } = openToolbar({ firstText: 'A', caret: false });
    editor.transact((tr) => {
      tr.setSelection(TextSelection.create(tr.doc, range.to));
    });

    await waitFor(() => {
      expect(screen.getByTestId('doc-link-url')).toHaveTextContent(HREF);
    });
  });

  it('offers the address as something that opens in a new tab', async () => {
    openToolbar();
    const shown = await screen.findByTestId('doc-link-url');

    expect(shown.getAttribute('href')).toBe(HREF);
    expect(shown.getAttribute('target')).toBe('_blank');
    expect(shown.getAttribute('rel')).toContain('noopener');
  });

  it('shows an address the body would refuse without making it pressable', async () => {
    // Addresses arrive from co-editors as well as from this keyboard, and the
    // body renders a refused one with `href=""`. Every surface that turns a
    // stored address into an href asks the same question.
    openToolbar({ firstHref: 'data:text/html,<script>alert(1)</script>' });
    const shown = await screen.findByTestId('doc-link-url');

    expect(shown.getAttribute('href')).toBeNull();
    expect(shown).toHaveTextContent('data:text/html');
  });
});

describe('pressing edit on the toolbar', () => {
  it('swaps to the field, holding the address it showed', async () => {
    openToolbar();
    await screen.findByTestId('doc-link-toolbar');

    await userEvent.click(screen.getByTestId('doc-link-edit'));

    expect(screen.getByTestId('doc-link-input')).toHaveValue(HREF);
  });

  it('draws the link as selected, so the reader sees which one is changing', async () => {
    const { editor } = openToolbar();
    await screen.findByTestId('doc-link-toolbar');

    await userEvent.click(screen.getByTestId('doc-link-edit'));

    expect(markedText(editor)).toBe('our docs');
  });

  it('leaves the reader s caret alone', async () => {
    // What the toolbar is about is held by a handle. The caret was standing in
    // for that handle, and moving it was what took the reader's place away.
    const { editor, range } = openToolbar();
    await screen.findByTestId('doc-link-toolbar');
    const before = editor.prosemirrorState.selection.from;
    expect(before).toBe(range.from + 1);

    await userEvent.click(screen.getByTestId('doc-link-edit'));

    expect(editor.prosemirrorState.selection.from).toBe(before);
  });
});

describe('confirming a new address', () => {
  it('writes it onto the link the toolbar opened over', async () => {
    const { editor } = openToolbar();
    await screen.findByTestId('doc-link-toolbar');
    await userEvent.click(screen.getByTestId('doc-link-edit'));

    await userEvent.clear(screen.getByTestId('doc-link-input'));
    await userEvent.type(screen.getByTestId('doc-link-input'), 'c.example/x');
    await userEvent.click(screen.getByTestId('doc-link-confirm'));

    expect(storedHrefs(editor)).toEqual(['https://c.example/x', OTHER]);
  });

  it('writes onto it after a peer has written ahead of it', async () => {
    // The handle answers where the link is now; an offset taken when the
    // field opened would land the address on whatever moved into its place.
    const { editor, doc } = openToolbar();
    await screen.findByTestId('doc-link-toolbar');
    await userEvent.click(screen.getByTestId('doc-link-edit'));
    peerWrites(doc, (text) => {
      text.insert(0, 'AAA ');
    });

    await userEvent.clear(screen.getByTestId('doc-link-input'));
    await userEvent.type(screen.getByTestId('doc-link-input'), 'c.example/x');
    await userEvent.click(screen.getByTestId('doc-link-confirm'));

    expect(storedHrefs(editor)).toEqual(['https://c.example/x', OTHER]);
    expect(editor.prosemirrorState.doc.textContent).toBe(
      'AAA see our docs and more here now',
    );
  });

  it('returns to the address, showing what was written', async () => {
    openToolbar();
    await screen.findByTestId('doc-link-toolbar');
    await userEvent.click(screen.getByTestId('doc-link-edit'));

    await userEvent.clear(screen.getByTestId('doc-link-input'));
    await userEvent.type(screen.getByTestId('doc-link-input'), 'c.example/x');
    await userEvent.click(screen.getByTestId('doc-link-confirm'));

    expect(screen.queryByTestId('doc-link-input')).not.toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByTestId('doc-link-url')).toHaveTextContent(
        'https://c.example/x',
      );
    });
  });

  it('stops drawing the link as selected', async () => {
    const { editor } = openToolbar();
    await screen.findByTestId('doc-link-toolbar');
    await userEvent.click(screen.getByTestId('doc-link-edit'));
    expect(markedText(editor)).toBe('our docs');

    await userEvent.clear(screen.getByTestId('doc-link-input'));
    await userEvent.type(screen.getByTestId('doc-link-input'), 'c.example/x');
    await userEvent.click(screen.getByTestId('doc-link-confirm'));

    expect(markedText(editor)).toBeNull();
  });

  it('says so and leaves the link alone for an address that is not one', async () => {
    const { editor } = openToolbar();
    await screen.findByTestId('doc-link-toolbar');
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
  it('takes the link off that text and puts the toolbar away', async () => {
    const { editor } = openToolbar();
    await screen.findByTestId('doc-link-toolbar');

    await userEvent.click(screen.getByTestId('doc-link-remove'));

    expect(storedHrefs(editor)).toEqual([OTHER]);
    await waitFor(() => {
      expect(screen.queryByTestId('doc-link-toolbar')).not.toBeInTheDocument();
    });
  });
});

describe('pressing remove with the focus on its button', () => {
  it('hands the editor the focus back', async () => {
    // The press put the focus on a button inside the toolbar, and the toolbar
    // is about to go; a removed focused element drops the focus on the body,
    // where ProseMirror stops reading the selection back.
    const { editor } = openToolbar();
    await screen.findByTestId('doc-link-toolbar');
    const asked = vi.spyOn(editor.prosemirrorView!, 'focus');

    await userEvent.click(screen.getByTestId('doc-link-remove'));

    expect(asked).toHaveBeenCalled();
  });
});

describe('dismissing the field', () => {
  it('steps back to the address on Escape', async () => {
    openToolbar();
    await screen.findByTestId('doc-link-toolbar');
    await userEvent.click(screen.getByTestId('doc-link-edit'));

    fireEvent.keyDown(document, { key: 'Escape' });

    await waitFor(() => {
      expect(screen.getByTestId('doc-link-url')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('doc-link-input')).not.toBeInTheDocument();
  });

  it('takes the toolbar away on a press outside', async () => {
    // Not a step back: a press somewhere else takes the pointer off the link
    // the toolbar hangs from, and a toolbar left parked over a link nobody is
    // pointing at has nothing left to take it away.
    openToolbar();
    await screen.findByTestId('doc-link-toolbar');
    await userEvent.click(screen.getByTestId('doc-link-edit'));

    fireEvent.pointerDown(document.body);

    await waitFor(() => {
      expect(screen.queryByTestId('doc-link-toolbar')).not.toBeInTheDocument();
    });
  });

  it('asks the editor for the focus back', async () => {
    const { editor } = openToolbar();
    await screen.findByTestId('doc-link-toolbar');
    await userEvent.click(screen.getByTestId('doc-link-edit'));
    const asked = vi.spyOn(editor.prosemirrorView!, 'focus');

    fireEvent.keyDown(document, { key: 'Escape' });

    await waitFor(() => {
      expect(asked).toHaveBeenCalled();
    });
  });
});

describe('a co-editor writing under the toolbar', () => {
  it('keeps it on the same link when they write before it', async () => {
    // Acceptance F1.
    const { doc } = openToolbar();
    await screen.findByTestId('doc-link-toolbar');

    peerWrites(doc, (text) => {
      text.insert(0, 'AAA ');
    });

    await waitFor(() => {
      expect(screen.getByTestId('doc-link-url')).toHaveTextContent(HREF);
    });
  });

  it('takes it away when they delete the link', async () => {
    // Acceptance F2.
    const { doc } = openToolbar();
    await screen.findByTestId('doc-link-toolbar');

    peerWrites(doc, (text) => {
      text.delete(0, text.length);
    });

    await waitFor(() => {
      expect(screen.queryByTestId('doc-link-toolbar')).not.toBeInTheDocument();
    });
  });

  it('hands the editor the focus when they delete the link being edited', async () => {
    // The field has the focus to be typed into. Removing a focused element
    // drops the focus on the body, where keystrokes reach nothing at all —
    // the reader has to click back into the document to carry on.
    const { editor, doc } = openToolbar();
    await screen.findByTestId('doc-link-toolbar');
    await userEvent.click(screen.getByTestId('doc-link-edit'));
    await screen.findByTestId('doc-link-input');
    const asked = vi.spyOn(editor.prosemirrorView!, 'focus');

    peerWrites(doc, (text) => {
      text.delete(4, 8);
    });

    await waitFor(() => {
      expect(asked).toHaveBeenCalled();
    });
  });

  it('leaves nothing of the open field behind when they delete its link', async () => {
    // `link-gone` × `form`. Letting go of the link has to take the face and
    // the draft with it: what comes back over the NEXT link is otherwise the
    // field, carrying an address typed for a link that no longer exists, one
    // Enter away from being written onto a link the reader never opened.
    const { editor, doc, range, secondLink } = openToolbar();
    await screen.findByTestId('doc-link-toolbar');
    await userEvent.click(screen.getByTestId('doc-link-edit'));
    fireEvent.change(await screen.findByTestId('doc-link-input'), {
      target: { value: 'https://typed.example' },
    });

    peerWrites(doc, (text) => {
      // Yjs counts characters where the range counts document positions:
      // `our docs` is the eight characters after `see `.
      text.delete(4, 8);
    });
    await waitFor(() => {
      expect(screen.queryByTestId('doc-link-toolbar')).not.toBeInTheDocument();
    });

    const moved = secondLink.from - (range.to - range.from);
    editor.transact((tr) => {
      tr.setSelection(TextSelection.create(tr.doc, moved + 1));
    });

    await waitFor(() => {
      expect(screen.getByTestId('doc-link-url')).toHaveTextContent(OTHER);
    });
    expect(screen.queryByTestId('doc-link-input')).not.toBeInTheDocument();
  });
});

describe('a toolbar the reader dismissed', () => {
  it('stays away while the caret is still in the link', async () => {
    // `remote-change` × `closed`. Every edit in the document re-asks what link
    // the caret is on, and the caret has not moved — so without the dismissal
    // standing, a co-editor typing anywhere puts the toolbar straight back
    // over text the reader took it away from.
    const { doc } = openToolbar();
    await screen.findByTestId('doc-link-toolbar');
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => {
      expect(screen.queryByTestId('doc-link-toolbar')).not.toBeInTheDocument();
    });

    peerWrites(doc, (text) => {
      text.insert(0, 'AAA ');
    });

    await new Promise((settle) => {
      setTimeout(settle, 20);
    });
    expect(screen.queryByTestId('doc-link-toolbar')).not.toBeInTheDocument();
  });

  it('comes back once the caret has left that link and returned', async () => {
    // The dismissal is about one link, not about the toolbar: reaching the
    // link again is a fresh ask.
    const { editor, range } = openToolbar();
    await screen.findByTestId('doc-link-toolbar');
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => {
      expect(screen.queryByTestId('doc-link-toolbar')).not.toBeInTheDocument();
    });

    editor.transact((tr) => {
      tr.setSelection(TextSelection.create(tr.doc, 1));
    });
    editor.transact((tr) => {
      tr.setSelection(TextSelection.create(tr.doc, range.from + 1));
    });

    await waitFor(() => {
      expect(screen.getByTestId('doc-link-url')).toHaveTextContent(HREF);
    });
  });
});

describe('the caret moving from one link into another', () => {
  it('re-targets the toolbar at the link the caret is in', async () => {
    // `caret-into-link` × `read`. One ArrowDown between two linked lines is
    // one selection change with no position outside a link in between, so
    // nothing else re-targets it.
    const { editor, secondLink } = openToolbar();
    await screen.findByTestId('doc-link-toolbar');

    editor.transact((tr) => {
      tr.setSelection(TextSelection.create(tr.doc, secondLink.from + 1));
    });

    await waitFor(() => {
      expect(screen.getByTestId('doc-link-url')).toHaveTextContent(OTHER);
    });
  });

  it('acts on the link the caret is in, not the one it left', async () => {
    const { editor, secondLink } = openToolbar();
    await screen.findByTestId('doc-link-toolbar');
    editor.transact((tr) => {
      tr.setSelection(TextSelection.create(tr.doc, secondLink.from + 1));
    });
    await waitFor(() => {
      expect(screen.getByTestId('doc-link-url')).toHaveTextContent(OTHER);
    });

    await userEvent.click(screen.getByTestId('doc-link-remove'));

    expect(storedHrefs(editor)).toEqual([HREF]);
  });
});

describe('the toolbar outliving the editor it sits over', () => {
  it('unmounts without raising, with the field still open', async () => {
    // Closing a Space tab evicts the editor, and that IS its teardown
    // (`document-editor-cache`); the overlays above the body belong to
    // components further up and have not been cleaned up yet.
    const { editor, unmount } = openToolbar();
    await screen.findByTestId('doc-link-toolbar');
    await userEvent.click(screen.getByTestId('doc-link-edit'));

    editor.unmount();

    expect(() => {
      unmount();
    }).not.toThrow();
  });
});
