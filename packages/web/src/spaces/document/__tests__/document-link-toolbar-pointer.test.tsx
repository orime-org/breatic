// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * #985: which link the toolbar is about while a pointer rests on one.
 *
 * Two answers are stood in for so that these cases can ask the question they
 * are about. `posAtCoords` turns coordinates into a position and `underPointer`
 * asks whether a point falls inside a run's rectangles; jsdom lays nothing out,
 * so both answer nothing there. Here a pointer's `clientX` IS a document
 * position, which leaves the geometry to `selection-bubble-bar.spec.ts` and
 * leaves these cases the part they can decide: which of the two routes holds
 * the toolbar, and which records keep it away.
 */

import * as React from 'react';
import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  render,
  screen,
  cleanup,
  fireEvent,
  waitFor,
  act,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as Y from 'yjs';
import { TextSelection } from '@tiptap/pm/state';

import { documentBodyFragment } from '@breatic/shared';

vi.mock('@web/spaces/document/document-link-anchor', async () => {
  const actual = await vi.importActual<
    typeof import('@web/spaces/document/document-link-anchor')
      >('@web/spaces/document/document-link-anchor');
  return {
    ...actual,
    underPointer: (
      _editor: unknown,
      span: { from: number; to: number },
      point: { clientX: number },
    ): boolean => point.clientX >= span.from && point.clientX <= span.to,
    panelReference: () => ({
      getBoundingClientRect: () => new DOMRect(0, 0, 1, 1),
      getClientRects: () => [new DOMRect(0, 0, 1, 1)] as unknown as DOMRectList,
      contextElement: document.body,
    }),
  };
});

const { buildDocumentEditor } = await import(
  '@web/spaces/document/build-document-editor'
);
const { DocumentLinkToolbar } = await import(
  '@web/spaces/document/DocumentLinkToolbar'
);

const HREF = 'https://a.example/docs';
const OTHER = 'https://b.example/more';
const WRITTEN = 'https://c.example/x';

/** The delays the toolbar counts, plus room for the timers to land. */
const PAST_BOTH_DELAYS = 400;

interface Scene {
  editor: ReturnType<typeof buildDocumentEditor>;
  doc: Y.Doc;
  first: { from: number; to: number };
  second: { from: number; to: number };
  point: (at: number) => void;
  writes: () => void;
  leaveBody: () => void;
  view: NonNullable<ReturnType<typeof buildDocumentEditor>['prosemirrorView']>;
}

const mounted: ReturnType<typeof buildDocumentEditor>[] = [];

afterEach(() => {
  cleanup();
  mounted.splice(0).forEach((editor) => {
    editor.unmount();
  });
  vi.restoreAllMocks();
});

/**
 * A body with two links on one line, with the toolbar mounted over it.
 * @returns The editor, both link spans, and the two things a reader does.
 */
function openBody(): Scene {
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
        { type: 'link', href: HREF, content: 'our docs' },
        { type: 'text', text: ' and ', styles: {} },
        { type: 'link', href: OTHER, content: 'more here' },
        { type: 'text', text: ' now', styles: {} },
      ],
    },
  ] as never);

  const spans: { from: number; to: number }[] = [];
  const { doc: pmDoc, schema } = editor.prosemirrorState;
  pmDoc.descendants((node, pos) => {
    if (node.isText && node.marks.some((m) => m.type === schema.marks.link)) {
      spans.push({ from: pos, to: pos + (node.text?.length ?? 0) });
    }
    return true;
  });
  const [first, second] = spans as [
    { from: number; to: number },
    { from: number; to: number },
  ];

  const view = editor.prosemirrorView!;
  vi.spyOn(view, 'posAtCoords').mockImplementation(
    (coords: { left: number; top: number }) => ({
      pos: coords.left,
      inside: -1,
    }),
  );

  const viewport = document.createElement('div');
  document.body.appendChild(viewport);
  render(
    <DocumentLinkToolbar editor={editor} viewport={viewport} yielding={false} />,
    { container: viewport },
  );

  const point = (at: number): void => {
    act(() => {
      view.dom.dispatchEvent(
        new MouseEvent('mousemove', { bubbles: true, clientX: at, clientY: 0 }),
      );
    });
  };
  const writes = (): void => {
    act(() => {
      fireEvent.keyDown(view.dom, { key: 'x' });
      view.dispatch(
        view.state.tr.insertText('x', view.state.selection.from),
      );
    });
  };
  const leaveBody = (): void => {
    act(() => {
      view.dom.dispatchEvent(new MouseEvent('mouseleave', { bubbles: true }));
    });
  };
  return { editor, doc, first, second, point, writes, leaveBody, view };
}

/** Put the caret one character into the given link. */
function caretInside(
  editor: ReturnType<typeof buildDocumentEditor>,
  span: { from: number; to: number },
): void {
  act(() => {
    editor.transact((tr) => {
      tr.setSelection(TextSelection.create(tr.doc, span.from + 1));
    });
  });
}

/** Let a co-editor delete a run of the line. */
function peerDeletes(doc: Y.Doc, at: number, length: number): void {
  const peer = new Y.Doc();
  Y.applyUpdate(peer, Y.encodeStateAsUpdate(doc));
  const group = documentBodyFragment(peer).get(0) as Y.XmlElement;
  const container = group.get(0) as Y.XmlElement;
  const paragraph = container.get(0) as Y.XmlElement;
  const text = paragraph.get(0) as Y.XmlText;
  act(() => {
    text.delete(at, length);
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(peer));
  });
}

/** Let a co-editor write at the end of the line. */
function peerWrites(doc: Y.Doc): void {
  const peer = new Y.Doc();
  Y.applyUpdate(peer, Y.encodeStateAsUpdate(doc));
  const group = documentBodyFragment(peer).get(0) as Y.XmlElement;
  const container = group.get(0) as Y.XmlElement;
  const paragraph = container.get(0) as Y.XmlElement;
  const text = paragraph.get(0) as Y.XmlText;
  act(() => {
    text.insert(text.length, '!');
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(peer));
  });
}

/** Wait past both countdowns. */
async function settle(ms = PAST_BOTH_DELAYS): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => {
      setTimeout(resolve, ms);
    });
  });
}

/** Write an address into the field and confirm it. */
async function confirmAnAddress(): Promise<void> {
  await userEvent.click(screen.getByTestId('doc-link-edit'));
  await userEvent.clear(screen.getByTestId('doc-link-input'));
  await userEvent.type(screen.getByTestId('doc-link-input'), 'c.example/x');
  await userEvent.click(screen.getByTestId('doc-link-confirm'));
  await waitFor(() => {
    expect(screen.getByTestId('doc-link-url')).toHaveTextContent(WRITTEN);
  });
}

describe('the link the pointer is resting on', () => {
  it('keeps it while the reader writes inside the link the caret is in', async () => {
    // A1 and A5. A caret that has not left its link has entered nothing, and
    // the character typed into it moves the link's own extent — which is why
    // the question is asked of the link and not of where it sat.
    const { editor, first, second, point, writes } = openBody();
    caretInside(editor, first);
    await screen.findByTestId('doc-link-toolbar');
    point(second.from + 2);
    await waitFor(() => {
      expect(screen.getByTestId('doc-link-url')).toHaveTextContent(OTHER);
    });

    writes();
    await settle(120);

    expect(screen.getByTestId('doc-link-url')).toHaveTextContent(OTHER);
  });

  it('stands while the reader writes after confirming an address on it', async () => {
    // A5: the toolbar the pointer raised goes when the pointer leaves, and a
    // keystroke is not the pointer leaving.
    const { first, point, writes } = openBody();
    point(first.from + 2);
    await waitFor(() => {
      expect(screen.getByTestId('doc-link-url')).toHaveTextContent(HREF);
    });
    await confirmAnAddress();

    writes();
    await settle();

    expect(screen.getByTestId('doc-link-url')).toHaveTextContent(WRITTEN);
  });

  it('takes the written address away on Escape', async () => {
    // A dismissal is the reader taking the whole toolbar away, and the address
    // they just wrote goes with it: the reading it was owed is the reader
    // making it go.
    const { editor, first, second, point } = openBody();
    caretInside(editor, first);
    await screen.findByTestId('doc-link-toolbar');
    point(first.from + 2);
    await settle(200);
    await confirmAnAddress();
    point(second.from + 200);
    await settle(50);

    fireEvent.keyDown(document, { key: 'Escape' });
    await settle(300);

    expect(screen.queryByTestId('doc-link-toolbar')).not.toBeInTheDocument();
  });

  it('stays away after a dismissal while the caret is in another link', async () => {
    // A4: Escape takes the toolbar away without the pointer moving, and what
    // the reader dismissed includes the link their caret is parked in — which
    // is the one the caret route would otherwise put straight back.
    const { editor, doc, first, second, point } = openBody();
    caretInside(editor, first);
    await screen.findByTestId('doc-link-toolbar');
    point(second.from + 2);
    await waitFor(() => {
      expect(screen.getByTestId('doc-link-url')).toHaveTextContent(OTHER);
    });

    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => {
      expect(screen.queryByTestId('doc-link-toolbar')).not.toBeInTheDocument();
    });

    peerWrites(doc);
    await settle(120);

    expect(screen.queryByTestId('doc-link-toolbar')).not.toBeInTheDocument();
  });

  it('goes on that keystroke once the pointer has left the link', async () => {
    // A3. The address stood because it was owed a reading, and the pointer had
    // already gone. The keystroke says it has been read, which leaves the
    // toolbar standing on a reason that ended a while ago.
    const { first, point, writes } = openBody();
    point(first.from + 2);
    await waitFor(() => {
      expect(screen.getByTestId('doc-link-url')).toHaveTextContent(HREF);
    });
    await userEvent.click(screen.getByTestId('doc-link-edit'));
    await userEvent.clear(screen.getByTestId('doc-link-input'));
    await userEvent.type(screen.getByTestId('doc-link-input'), 'c.example/x');
    // The reader reaches for the keyboard, which takes the pointer off both,
    // and confirms from there.
    act(() => {
      fireEvent.mouseLeave(screen.getByTestId('doc-link-toolbar'));
    });
    point(1);
    // Past the close delay, so the countdown the leave started lands while the
    // field is still up and is refused. What takes the toolbar away after the
    // confirm is then the keystroke and nothing else.
    await settle();
    await userEvent.keyboard('{Enter}');
    await waitFor(() => {
      expect(screen.getByTestId('doc-link-url')).toHaveTextContent(WRITTEN);
    });

    writes();
    await settle();

    expect(screen.queryByTestId('doc-link-toolbar')).not.toBeInTheDocument();
  });

  it('stays away once a press lands the caret in the link it dismissed', async () => {
    // A press is an outside press, and it dismisses before it moves the caret:
    // the link the reader took the toolbar away from is the one the caret is
    // about to land in, which is a standing reason to raise it again.
    const { editor, first, point } = openBody();
    point(first.from + 2);
    await waitFor(() => {
      expect(screen.getByTestId('doc-link-url')).toHaveTextContent(HREF);
    });

    // `useDismiss` reads the press off `pointerdown`, which is what decides
    // the toolbar's answer; the caret moves on the `mousedown` behind it.
    fireEvent.pointerDown(editor.prosemirrorView!.dom);
    await waitFor(() => {
      expect(screen.queryByTestId('doc-link-toolbar')).not.toBeInTheDocument();
    });
    caretInside(editor, first);
    await settle(120);

    expect(screen.queryByTestId('doc-link-toolbar')).not.toBeInTheDocument();
  });

  it('comes back when the hand leaves the link it pressed and returns', async () => {
    // Reaching the link again is a fresh ask. What holds the dismissal is the
    // hand that made it still resting there; the caret the press dropped into
    // the link was never a reason the reader gave, so it holds nothing.
    const { editor, first, point, leaveBody } = openBody();
    point(first.from + 2);
    await waitFor(() => {
      expect(screen.getByTestId('doc-link-url')).toHaveTextContent(HREF);
    });
    fireEvent.pointerDown(editor.prosemirrorView!.dom);
    await waitFor(() => {
      expect(screen.queryByTestId('doc-link-toolbar')).not.toBeInTheDocument();
    });
    caretInside(editor, first);
    await settle(120);

    leaveBody();
    await settle(300);
    point(first.from + 2);

    await waitFor(() => {
      expect(screen.getByTestId('doc-link-url')).toHaveTextContent(HREF);
    });
  });

  it('stays away after that dismissal when the reader writes as well', async () => {
    // The same dismissal against this reader's own next character: both are a
    // change in the document, and neither is a reason to put it back.
    const { editor, first, second, point, writes } = openBody();
    caretInside(editor, first);
    await screen.findByTestId('doc-link-toolbar');
    point(second.from + 2);
    await waitFor(() => {
      expect(screen.getByTestId('doc-link-url')).toHaveTextContent(OTHER);
    });

    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => {
      expect(screen.queryByTestId('doc-link-toolbar')).not.toBeInTheDocument();
    });

    writes();
    await settle(120);

    expect(screen.queryByTestId('doc-link-toolbar')).not.toBeInTheDocument();
  });

  it('stays while the hand rests on the toolbar and the caret walks out', async () => {
    // A5. The toolbar is one of the two places the hand can rest: the close
    // countdown and the step back from the field both treat it that way, and
    // the reader reaching for Remove is the gesture it is there for.
    const { editor, first, point, leaveBody } = openBody();
    caretInside(editor, first);
    await screen.findByTestId('doc-link-toolbar');
    point(first.from + 2);
    await settle(200);
    // The hand travels from the link onto the toolbar.
    leaveBody();
    act(() => {
      fireEvent.mouseEnter(screen.getByTestId('doc-link-toolbar'));
    });
    await settle(50);

    // One arrow key. The hand has not moved.
    act(() => {
      editor.transact((tr) => {
        tr.setSelection(TextSelection.create(tr.doc, 1));
      });
    });
    await settle();

    expect(screen.getByTestId('doc-link-url')).toHaveTextContent(HREF);
  });

  it('keeps the caret its link when Escape leaves the field', async () => {
    // Stepping back from the field is the toolbar's own reason expiring, not
    // the reader taking anything away, so nothing is recorded against the link
    // their caret never left (A6).
    const { editor, first, second, point, writes } = openBody();
    caretInside(editor, first);
    await screen.findByTestId('doc-link-toolbar');
    point(second.from + 2);
    await waitFor(() => {
      expect(screen.getByTestId('doc-link-url')).toHaveTextContent(OTHER);
    });
    await userEvent.click(screen.getByTestId('doc-link-edit'));
    act(() => {
      fireEvent.mouseLeave(screen.getByTestId('doc-link-toolbar'));
    });
    point(1);
    await settle(50);
    fireEvent.keyDown(document, { key: 'Escape' });
    await settle();

    writes();
    await settle(200);

    expect(screen.getByTestId('doc-link-url')).toHaveTextContent(HREF);
  });

  it('lets the caret reach a link the pointer was dismissed on', async () => {
    // A4 takes away what the reader asked about, which was the pointer's claim
    // on that link. Reaching it with the caret is a different claim and a
    // fresh ask (A6, and §6.1's `click-link` x `closed` row).
    const { editor, first, point } = openBody();
    point(first.from + 2);
    await waitFor(() => {
      expect(screen.getByTestId('doc-link-url')).toHaveTextContent(HREF);
    });
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => {
      expect(screen.queryByTestId('doc-link-toolbar')).not.toBeInTheDocument();
    });
    // The hand leaves the link, which is what ends what the reader took away.
    point(1);
    await settle();

    caretInside(editor, first);
    await settle(200);

    expect(screen.getByTestId('doc-link-url')).toHaveTextContent(HREF);
  });

  it('hands the toolbar to the pointer when a peer deletes the caret link', async () => {
    // A1. The caret's link going is one reason ending; the hand resting on
    // another link is a reason of its own that outlives it.
    const { editor, doc, first, second, point } = openBody();
    point(second.from + 2);
    await waitFor(() => {
      expect(screen.getByTestId('doc-link-url')).toHaveTextContent(OTHER);
    });
    caretInside(editor, first);
    await waitFor(() => {
      expect(screen.getByTestId('doc-link-url')).toHaveTextContent(HREF);
    });

    // 'see ' is four characters; the first link is the eight after it.
    peerDeletes(doc, 4, 8);
    await settle();

    expect(screen.getByTestId('doc-link-url')).toHaveTextContent(OTHER);
  });

  it('goes when a peer deletes the link the pointer had just reached', async () => {
    // A3. The hand left the link the toolbar was about, and what it travelled
    // to is gone, so nothing stands.
    const { doc, first, second, point } = openBody();
    point(first.from + 2);
    await waitFor(() => {
      expect(screen.getByTestId('doc-link-url')).toHaveTextContent(HREF);
    });

    point(second.from + 2);
    // 'see our docs and ' is seventeen characters; the second link is the nine
    // after it.
    peerDeletes(doc, 17, 9);
    await settle();

    expect(screen.queryByTestId('doc-link-toolbar')).not.toBeInTheDocument();
  });

  it('keeps the address it wrote through a key that writes nothing', async () => {
    // D2. The address is the only word the reader gets that the write landed,
    // and a modifier tapped on the way to a shortcut is not them moving on.
    const { first, point, view } = openBody();
    point(first.from + 2);
    await waitFor(() => {
      expect(screen.getByTestId('doc-link-url')).toHaveTextContent(HREF);
    });
    await userEvent.click(screen.getByTestId('doc-link-edit'));
    await userEvent.clear(screen.getByTestId('doc-link-input'));
    await userEvent.type(screen.getByTestId('doc-link-input'), 'c.example/x');
    // The hand leaves both before the confirm, so what keeps the address on
    // screen afterwards is that it is owed a reading and nothing else.
    act(() => {
      fireEvent.mouseLeave(screen.getByTestId('doc-link-toolbar'));
    });
    point(1);
    await settle();
    await userEvent.keyboard('{Enter}');
    await waitFor(() => {
      expect(screen.getByTestId('doc-link-url')).toHaveTextContent(WRITTEN);
    });

    act(() => {
      fireEvent.keyDown(view.dom, { key: 'Shift' });
    });
    await settle();

    expect(screen.getByTestId('doc-link-url')).toHaveTextContent(WRITTEN);
  });

  it('leaves the toolbar with the caret when a peer writes and the hand is elsewhere', async () => {
    // Two reasons stand at once, on different links, and the caret's arrived
    // last. Nothing new happens on a co-editor's keystroke, so whichever
    // reason the toolbar is already about keeps it — asking the reasons afresh
    // would hand it to the pointer, moving the toolbar to a link the reader
    // has been resting on without acting for as long as they have been typing.
    const { editor, doc, first, second, point } = openBody();
    point(second.from + 2);
    await waitFor(() => {
      expect(screen.getByTestId('doc-link-url')).toHaveTextContent(OTHER);
    });
    caretInside(editor, first);
    await waitFor(() => {
      expect(screen.getByTestId('doc-link-url')).toHaveTextContent(HREF);
    });

    peerWrites(doc);
    await settle();

    expect(screen.getByTestId('doc-link-url')).toHaveTextContent(HREF);
  });
});
