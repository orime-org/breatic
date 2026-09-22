// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Where an unposted comment is going to land (#18, A21, design §9.4).
 *
 * Between pressing the entry and posting, the range carries no mark — the
 * mark is what posting writes — so nothing in the body moves it while the
 * body keeps being edited: the reader typing elsewhere, a peer inserting a
 * paragraph above, somebody pressing undo.
 *
 * So it rides `tr.mapping`, which is what ProseMirror maps positions across
 * a change with, and it is GONE when both ends map to the same point: every
 * character it covered was deleted. Posting into a gone range would write the
 * reader's words into a thread pointing at nothing, which A21 is about.
 *
 * TDD: red because neither export exists yet.
 */

import { TextSelection } from '@tiptap/pm/state';
import { describe, it, expect, afterEach } from 'vitest';
import * as Y from 'yjs';

import { documentBodyFragment } from '@breatic/shared';

import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';
import {
  DOCUMENT_COMMENT_DRAFT_RANGE,
  documentCommentDraftRange,
  draftRangeIn,
  mapDraftRange,
} from '@web/spaces/document/document-comment-draft-range';

type Editor = ReturnType<typeof buildDocumentEditor>;

const mounted: Editor[] = [];

afterEach(() => {
  mounted.splice(0).forEach((editor) => {
    editor.unmount();
  });
});

/**
 * Opens an editor holding one paragraph, with the draft range plugin on.
 * @returns The editor, mounted.
 */
function open(): Editor {
  const editor = buildDocumentEditor({
    fragment: documentBodyFragment(new Y.Doc()),
    extensions: [documentCommentDraftRange()],
  });
  const root = document.createElement('div');
  document.body.appendChild(root);
  editor.mount(root);
  mounted.push(editor);
  editor.replaceBlocks(editor.document, [
    { type: 'paragraph', content: 'alpha bravo charlie' },
  ] as never);
  return editor;
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

describe('mapDraftRange', () => {
  it('moves both ends when text is inserted before it', () => {
    const editor = open();
    const run = firstRun(editor);
    const target = { from: run.from + 6, to: run.from + 11 };
    const tr = editor.prosemirrorState.tr.insertText('xx', run.from);

    expect(mapDraftRange(target, tr.mapping)).toEqual({
      from: target.from + 2,
      to: target.to + 2,
    });
  });

  it('leaves it alone when text is inserted after it', () => {
    const editor = open();
    const run = firstRun(editor);
    const target = { from: run.from, to: run.from + 5 };
    const tr = editor.prosemirrorState.tr.insertText('xx', run.to - 1);

    expect(mapDraftRange(target, tr.mapping)).toEqual(target);
  });

  it('does not widen when text is typed against its end', () => {
    // A reader selects some words, presses the entry, then keeps typing where
    // the selection ended. Those characters are not part of what they are
    // commenting on — the same answer the mark itself gives, whose
    // `inclusive: false` keeps text typed at a comment's end outside it.
    const editor = open();
    const run = firstRun(editor);
    const target = { from: run.from, to: run.from + 5 };
    const tr = editor.prosemirrorState.tr.insertText('xx', target.to);

    expect(mapDraftRange(target, tr.mapping)).toEqual(target);
  });

  it('does not widen when text is typed against its start', () => {
    const editor = open();
    const run = firstRun(editor);
    const target = { from: run.from + 6, to: run.from + 11 };
    const tr = editor.prosemirrorState.tr.insertText('xx', target.from);

    expect(mapDraftRange(target, tr.mapping)).toEqual({
      from: target.from + 2,
      to: target.to + 2,
    });
  });

  it('shrinks when part of what it covers is deleted', () => {
    const editor = open();
    const run = firstRun(editor);
    const target = { from: run.from, to: run.from + 11 };
    const tr = editor.prosemirrorState.tr.delete(run.from + 5, run.from + 8);

    expect(mapDraftRange(target, tr.mapping)).toEqual({
      from: target.from,
      to: target.to - 3,
    });
  });

  it('is gone when everything it covered is deleted', () => {
    const editor = open();
    const run = firstRun(editor);
    const target = { from: run.from, to: run.from + 5 };
    const tr = editor.prosemirrorState.tr.delete(target.from, target.to);

    expect(mapDraftRange(target, tr.mapping)).toBeNull();
  });

  it('is gone when a larger deletion takes it with it', () => {
    const editor = open();
    const run = firstRun(editor);
    const target = { from: run.from + 6, to: run.from + 11 };
    const tr = editor.prosemirrorState.tr.delete(run.from, run.to - 1);

    expect(mapDraftRange(target, tr.mapping)).toBeNull();
  });

  it('is gone for a range that had already collapsed', () => {
    const editor = open();
    const run = firstRun(editor);
    const tr = editor.prosemirrorState.tr.insertText('x', run.to - 1);

    expect(mapDraftRange({ from: run.from, to: run.from }, tr.mapping)).toBeNull();
  });
});

describe('the draft range plugin', () => {
  it('holds nothing until a draft opens', () => {
    expect(draftRangeIn(open().prosemirrorState)).toBeNull();
  });

  it('holds the range a draft opened on', () => {
    const editor = open();
    const view = editor.prosemirrorView!;
    const run = firstRun(editor);
    const target = { from: run.from, to: run.from + 5 };

    view.dispatch(view.state.tr.setMeta(DOCUMENT_COMMENT_DRAFT_RANGE, target));

    expect(draftRangeIn(view.state)).toEqual(target);
  });

  it('moves the range as the body is edited under it', () => {
    const editor = open();
    const view = editor.prosemirrorView!;
    const run = firstRun(editor);
    const target = { from: run.from + 6, to: run.from + 11 };

    view.dispatch(view.state.tr.setMeta(DOCUMENT_COMMENT_DRAFT_RANGE, target));
    view.dispatch(view.state.tr.insertText('xx', run.from));

    expect(draftRangeIn(view.state)).toEqual({
      from: target.from + 2,
      to: target.to + 2,
    });
  });

  it('drops the range when the text it pointed at is deleted', () => {
    const editor = open();
    const view = editor.prosemirrorView!;
    const run = firstRun(editor);
    const target = { from: run.from, to: run.from + 5 };

    view.dispatch(view.state.tr.setMeta(DOCUMENT_COMMENT_DRAFT_RANGE, target));
    view.dispatch(view.state.tr.delete(target.from, target.to));

    expect(draftRangeIn(view.state)).toBeNull();
  });

  it('clears the range when the draft closes', () => {
    const editor = open();
    const view = editor.prosemirrorView!;
    const run = firstRun(editor);

    view.dispatch(
      view.state.tr.setMeta(DOCUMENT_COMMENT_DRAFT_RANGE, {
        from: run.from,
        to: run.from + 5,
      }),
    );
    view.dispatch(view.state.tr.setMeta(DOCUMENT_COMMENT_DRAFT_RANGE, null));

    expect(draftRangeIn(view.state)).toBeNull();
  });

  it('keeps the range across a selection change', () => {
    // Moving the caret is not an edit, and a reader clicking elsewhere before
    // typing their comment must not lose where it goes.
    const editor = open();
    const view = editor.prosemirrorView!;
    const run = firstRun(editor);
    const target = { from: run.from, to: run.from + 5 };

    view.dispatch(view.state.tr.setMeta(DOCUMENT_COMMENT_DRAFT_RANGE, target));
    view.dispatch(
      view.state.tr.setSelection(
        TextSelection.create(view.state.doc, run.to - 1),
      ),
    );

    expect(draftRangeIn(view.state)).toEqual(target);
  });
});
