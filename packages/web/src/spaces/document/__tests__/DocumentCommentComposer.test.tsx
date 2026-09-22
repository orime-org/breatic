// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The box a reader writes a comment in (#18, A1 · A2 · A21 · A22).
 *
 * It is on screen exactly while a draft is open, and a draft is open exactly
 * while the plugin holds a range — so nothing here decides when to appear.
 * What it owns is the words, and it hands them to `postComment` when the
 * reader posts.
 *
 * Two closings are not the reader's doing and owe them an account: the text it
 * was aimed at is gone (A21), or their right to write here was taken away
 * mid-draft (A22). Both come from `reduceDraft`'s `drop`, delivered with the
 * canvas annotations, and both leave the notice standing until the reader
 * dismisses it or opens another box.
 *
 * The quote shows the words the comment is about, and it does not distinguish
 * a whole-block comment from a text one: design §6.1 settles that the two
 * entries are identical past the range, so there is no kind to draw.
 *
 * TDD: red because the component does not exist yet.
 */

import { render, screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TextSelection } from '@tiptap/pm/state';
import { describe, it, expect, afterEach } from 'vitest';
import * as Y from 'yjs';

import { CommentsExtension } from '@blocknote/core/comments';

import { documentBodyFragment, documentCommentThreads } from '@breatic/shared';

import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';
import { DocumentCommentComposer } from '@web/spaces/document/DocumentCommentComposer';
import {
  DOCUMENT_COMMENT_DRAFT_RANGE,
  documentCommentDraftRange,
  draftRangeIn,
} from '@web/spaces/document/document-comment-draft-range';

type Editor = ReturnType<typeof buildDocumentEditor>;

const mounted: Editor[] = [];

afterEach(() => {
  cleanup();
  mounted.splice(0).forEach((editor) => {
    editor.unmount();
  });
});

/**
 * Opens an editor with comments and the draft plugin, holding one paragraph.
 * @returns The editor and the document behind it.
 */
function open(): { editor: Editor; doc: Y.Doc } {
  const doc = new Y.Doc();
  const editor = buildDocumentEditor({
    fragment: documentBodyFragment(doc),
    comments: { doc, readWho: () => ({ role: 'editor', viewerId: 'u1' }) },
    extensions: [documentCommentDraftRange()],
  });
  const root = document.createElement('div');
  document.body.appendChild(root);
  editor.mount(root);
  mounted.push(editor);
  editor.replaceBlocks(editor.document, [
    { type: 'paragraph', content: 'alpha bravo charlie' },
  ] as never);
  return { editor, doc };
}

/** Where the first run of text sits. */
function firstRun(editor: Editor): { from: number; to: number } {
  let at: { from: number; to: number } | undefined;
  editor.prosemirrorState.doc.descendants((node, pos) => {
    if (node.isText && at === undefined) {
      at = { from: pos, to: pos + node.nodeSize };
    }
    return true;
  });
  return at!;
}

/**
 * Opens a draft aimed at a range, the way an entry does.
 * @param editor - The editor.
 * @param range - Where the comment is going.
 */
function aimAt(editor: Editor, range: { from: number; to: number }): void {
  const view = editor.prosemirrorView!;
  view.dispatch(view.state.tr.setMeta(DOCUMENT_COMMENT_DRAFT_RANGE, range));
}

/** The composer, rendered over one editor. */
function show(editor: Editor, myRole: 'editor' | 'viewer' = 'editor'): void {
  render(<DocumentCommentComposer editor={editor} myRole={myRole} />);
}

describe('DocumentCommentComposer', () => {
  it('stays away while no draft is open', () => {
    const { editor } = open();
    show(editor);

    expect(screen.queryByTestId('doc-comment-composer')).toBeNull();
  });

  it('appears when a draft opens, showing the words it is about', async () => {
    const { editor } = open();
    const run = firstRun(editor);
    show(editor);

    aimAt(editor, { from: run.from, to: run.from + 5 });

    await waitFor(() => {
      expect(screen.getByTestId('doc-comment-composer')).toBeInTheDocument();
    });
    expect(screen.getByTestId('doc-comment-quote')).toHaveTextContent('alpha');
  });

  it('posts what the reader typed, marking the words', async () => {
    const { editor, doc } = open();
    const run = firstRun(editor);
    show(editor);
    aimAt(editor, { from: run.from, to: run.from + 5 });

    await waitFor(() => {
      expect(screen.getByTestId('doc-comment-composer')).toBeInTheDocument();
    });
    await userEvent.type(
      screen.getByTestId('doc-comment-input'),
      'a first thought',
    );
    await userEvent.click(screen.getByTestId('doc-comment-post'));

    await waitFor(() => {
      expect([...documentCommentThreads(doc).keys()]).toHaveLength(1);
    });
    const comments = editor.getExtension(CommentsExtension)!;
    const stored = [...comments.threadStore.getThreads().values()][0];
    expect(JSON.stringify(stored?.comments[0]?.body)).toContain(
      'a first thought',
    );
  });

  it('closes after posting, leaving nothing on screen', async () => {
    const { editor } = open();
    const run = firstRun(editor);
    show(editor);
    aimAt(editor, { from: run.from, to: run.from + 5 });

    await waitFor(() => {
      expect(screen.getByTestId('doc-comment-composer')).toBeInTheDocument();
    });
    await userEvent.type(screen.getByTestId('doc-comment-input'), 'done');
    await userEvent.click(screen.getByTestId('doc-comment-post'));

    await waitFor(() => {
      expect(screen.queryByTestId('doc-comment-composer')).toBeNull();
    });
  });

  it('refuses to post nothing', async () => {
    // Blank words are not worth writing, and `reduceDraft` answers a save on
    // them by leaving the draft alone — so the box stays and nothing is made.
    const { editor, doc } = open();
    const run = firstRun(editor);
    show(editor);
    aimAt(editor, { from: run.from, to: run.from + 5 });

    await waitFor(() => {
      expect(screen.getByTestId('doc-comment-composer')).toBeInTheDocument();
    });
    await userEvent.type(screen.getByTestId('doc-comment-input'), '   ');
    await userEvent.click(screen.getByTestId('doc-comment-post'));

    expect([...documentCommentThreads(doc).keys()]).toHaveLength(0);
    expect(screen.getByTestId('doc-comment-composer')).toBeInTheDocument();
  });

  it('throws the words away on Escape, per the demo', async () => {
    const { editor, doc } = open();
    const run = firstRun(editor);
    show(editor);
    aimAt(editor, { from: run.from, to: run.from + 5 });

    await waitFor(() => {
      expect(screen.getByTestId('doc-comment-composer')).toBeInTheDocument();
    });
    await userEvent.type(screen.getByTestId('doc-comment-input'), 'never mind');
    await userEvent.keyboard('{Escape}');

    await waitFor(() => {
      expect(screen.queryByTestId('doc-comment-composer')).toBeNull();
    });
    expect([...documentCommentThreads(doc).keys()]).toHaveLength(0);
  });

  it('says so when the words it was aimed at are deleted', async () => {
    const { editor } = open();
    const run = firstRun(editor);
    const range = { from: run.from, to: run.from + 5 };
    show(editor);
    aimAt(editor, range);

    await waitFor(() => {
      expect(screen.getByTestId('doc-comment-composer')).toBeInTheDocument();
    });
    await userEvent.type(screen.getByTestId('doc-comment-input'), 'about this');

    const view = editor.prosemirrorView!;
    view.dispatch(view.state.tr.delete(range.from, range.to));

    await waitFor(() => {
      expect(screen.getByTestId('doc-comment-dropped')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('doc-comment-input')).toBeNull();
  });

  it('says so when the reader loses the right to write mid-draft', async () => {
    const { editor } = open();
    const run = firstRun(editor);
    const { rerender } = render(
      <DocumentCommentComposer editor={editor} myRole='editor' />,
    );
    aimAt(editor, { from: run.from, to: run.from + 5 });

    await waitFor(() => {
      expect(screen.getByTestId('doc-comment-composer')).toBeInTheDocument();
    });
    await userEvent.type(screen.getByTestId('doc-comment-input'), 'half a');

    rerender(<DocumentCommentComposer editor={editor} myRole='viewer' />);

    await waitFor(() => {
      expect(screen.getByTestId('doc-comment-dropped')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('doc-comment-input')).toBeNull();
  });

  it('follows the words when a peer inserts text above', async () => {
    // The quote is read from the range as it stands, so it keeps naming the
    // same words rather than whatever now sits at those offsets.
    const { editor } = open();
    const run = firstRun(editor);
    show(editor);
    aimAt(editor, { from: run.from + 6, to: run.from + 11 });

    await waitFor(() => {
      expect(screen.getByTestId('doc-comment-quote')).toHaveTextContent('bravo');
    });

    const view = editor.prosemirrorView!;
    view.dispatch(
      view.state.tr.setSelection(
        TextSelection.create(view.state.doc, run.from),
      ),
    );
    view.dispatch(view.state.tr.insertText('xx ', run.from));

    await waitFor(() => {
      expect(screen.getByTestId('doc-comment-quote')).toHaveTextContent('bravo');
    });
  });

  it('closes the draft in the plugin too, not only on screen', async () => {
    // The range IS whether a draft is open, so a post that took the box off
    // screen but left the range behind would leave the plugin saying one is
    // still open — and whoever reads it next would believe it.
    const { editor } = open();
    const run = firstRun(editor);
    show(editor);
    aimAt(editor, { from: run.from, to: run.from + 5 });

    await waitFor(() => {
      expect(screen.getByTestId('doc-comment-composer')).toBeInTheDocument();
    });
    await userEvent.type(screen.getByTestId('doc-comment-input'), 'done');
    await userEvent.click(screen.getByTestId('doc-comment-post'));

    await waitFor(() => {
      expect(draftRangeIn(editor.prosemirrorState)).toBeNull();
    });
  });

  it('closes on Escape with nothing typed', async () => {
    // A reader who presses the entry and changes their mind before typing.
    // Discarding and saving differ here: a save on blank words leaves the
    // draft alone, so the box would stay.
    const { editor } = open();
    const run = firstRun(editor);
    show(editor);
    aimAt(editor, { from: run.from, to: run.from + 5 });

    await waitFor(() => {
      expect(screen.getByTestId('doc-comment-composer')).toBeInTheDocument();
    });
    await userEvent.click(screen.getByTestId('doc-comment-input'));
    await userEvent.keyboard('{Escape}');

    await waitFor(() => {
      expect(screen.queryByTestId('doc-comment-composer')).toBeNull();
    });
  });

  it('quotes the whole range, whatever its length', async () => {
    const { editor } = open();
    const run = firstRun(editor);
    show(editor);
    aimAt(editor, { from: run.from, to: run.from + 11 });

    await waitFor(() => {
      expect(screen.getByTestId('doc-comment-quote')).toHaveTextContent(
        'alpha bravo',
      );
    });
  });
});
