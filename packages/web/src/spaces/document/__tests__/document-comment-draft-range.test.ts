// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Where an unposted comment is going to land (#18, A21, design §9.4).
 *
 * These pin the plugin's own states — open, move, close, and the range carried
 * across the reader's own edits by ProseMirror mapping. How the range follows
 * changes that come in through Yjs is pinned in `document-comment-rail.test.tsx`,
 * with a second editor as the peer.
 */

import { TextSelection } from '@tiptap/pm/state';
import { describe, it, expect, afterEach } from 'vitest';
import * as Y from 'yjs';

import { documentBodyFragment } from '@breatic/shared';

import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';
import {
  DOCUMENT_COMMENT_DRAFT_RANGE,
  draftRangeIn,
  mapDraftRange,
  onDraftChange,
} from '@web/spaces/document/document-comment-draft-range';

type Editor = ReturnType<typeof buildDocumentEditor>;

const mounted: Editor[] = [];

afterEach(() => {
  mounted.splice(0).forEach((editor) => {
    editor.unmount();
  });
});

/**
 * Opens an editor holding one paragraph.
 * @returns The editor, mounted.
 */
function open(): Editor {
  const editor = buildDocumentEditor({
    fragment: documentBodyFragment(new Y.Doc()),
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

    expect(mapDraftRange(target, tr)).toEqual({
      from: target.from + 2,
      to: target.to + 2,
    });
  });

  it('leaves it alone when text is inserted after it', () => {
    const editor = open();
    const run = firstRun(editor);
    const target = { from: run.from, to: run.from + 5 };
    const tr = editor.prosemirrorState.tr.insertText('xx', run.to - 1);

    expect(mapDraftRange(target, tr)).toEqual(target);
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

    expect(mapDraftRange(target, tr)).toEqual(target);
  });

  it('does not widen when text is typed against its start', () => {
    const editor = open();
    const run = firstRun(editor);
    const target = { from: run.from + 6, to: run.from + 11 };
    const tr = editor.prosemirrorState.tr.insertText('xx', target.from);

    expect(mapDraftRange(target, tr)).toEqual({
      from: target.from + 2,
      to: target.to + 2,
    });
  });

  it('shrinks when part of what it covers is deleted', () => {
    const editor = open();
    const run = firstRun(editor);
    const target = { from: run.from, to: run.from + 11 };
    const tr = editor.prosemirrorState.tr.delete(run.from + 5, run.from + 8);

    expect(mapDraftRange(target, tr)).toEqual({
      from: target.from,
      to: target.to - 3,
    });
  });

  it('is gone when everything it covered is deleted', () => {
    const editor = open();
    const run = firstRun(editor);
    const target = { from: run.from, to: run.from + 5 };
    const tr = editor.prosemirrorState.tr.delete(target.from, target.to);

    expect(mapDraftRange(target, tr)).toBeNull();
  });

  it('is gone when a larger deletion takes it with it', () => {
    const editor = open();
    const run = firstRun(editor);
    const target = { from: run.from + 6, to: run.from + 11 };
    const tr = editor.prosemirrorState.tr.delete(run.from, run.to - 1);

    expect(mapDraftRange(target, tr)).toBeNull();
  });

  it('is gone for a range that had already collapsed', () => {
    const editor = open();
    const run = firstRun(editor);
    const tr = editor.prosemirrorState.tr.insertText('x', run.to - 1);

    expect(mapDraftRange({ from: run.from, to: run.from }, tr)).toBeNull();
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

    view.dispatch(view.state.tr.setMeta(DOCUMENT_COMMENT_DRAFT_RANGE, [target]));

    expect(draftRangeIn(view.state)).toMatchObject({ segments: [target] });
  });

  it('moves the range as the body is edited under it', () => {
    const editor = open();
    const view = editor.prosemirrorView!;
    const run = firstRun(editor);
    const target = { from: run.from + 6, to: run.from + 11 };

    view.dispatch(view.state.tr.setMeta(DOCUMENT_COMMENT_DRAFT_RANGE, [target]));
    view.dispatch(view.state.tr.insertText('xx', run.from));

    expect(draftRangeIn(view.state)).toMatchObject({
      segments: [{ from: target.from + 2, to: target.to + 2 }],
    });
  });

  it('drops the range when the text it pointed at is deleted', () => {
    const editor = open();
    const view = editor.prosemirrorView!;
    const run = firstRun(editor);
    const target = { from: run.from, to: run.from + 5 };

    view.dispatch(view.state.tr.setMeta(DOCUMENT_COMMENT_DRAFT_RANGE, [target]));
    view.dispatch(view.state.tr.delete(target.from, target.to));

    expect(draftRangeIn(view.state)).toBeNull();
  });

  it('clears the range when the draft closes', () => {
    const editor = open();
    const view = editor.prosemirrorView!;
    const run = firstRun(editor);

    view.dispatch(
      view.state.tr.setMeta(DOCUMENT_COMMENT_DRAFT_RANGE, [{
        from: run.from,
        to: run.from + 5,
      }]),
    );
    view.dispatch(view.state.tr.setMeta(DOCUMENT_COMMENT_DRAFT_RANGE, null));

    expect(draftRangeIn(view.state)).toBeNull();
  });

  it('hands back the same object while the range has not moved', () => {
    // `useSyncExternalStore` requires an identical snapshot while the store
    // has not changed, so an equal-but-new object per transaction would read
    // as a change on every keystroke anywhere in the body.
    const editor = open();
    const view = editor.prosemirrorView!;
    const run = firstRun(editor);

    view.dispatch(
      view.state.tr.setMeta(DOCUMENT_COMMENT_DRAFT_RANGE, [{
        from: run.from,
        to: run.from + 5,
      }]),
    );
    const first = draftRangeIn(view.state);
    view.dispatch(view.state.tr.insertText('x', run.to - 1));

    expect(draftRangeIn(view.state)).toBe(first);
  });

  it('tells a listener when a draft opens, moves and closes', () => {
    // The editor's own events do not cover opening: that transaction carries
    // nothing but the meta, so neither the document nor the selection moves.
    const editor = open();
    const view = editor.prosemirrorView!;
    const run = firstRun(editor);
    let heard = 0;
    const stop = onDraftChange(() => {
      heard += 1;
    });

    view.dispatch(
      view.state.tr.setMeta(DOCUMENT_COMMENT_DRAFT_RANGE, [{
        from: run.from + 6,
        to: run.from + 11,
      }]),
    );
    expect(heard).toBe(1);

    view.dispatch(view.state.tr.insertText('xx', run.from));
    expect(heard).toBe(2);

    view.dispatch(view.state.tr.setMeta(DOCUMENT_COMMENT_DRAFT_RANGE, null));
    expect(heard).toBe(3);

    stop();
    view.dispatch(
      view.state.tr.setMeta(DOCUMENT_COMMENT_DRAFT_RANGE, [{
        from: run.from,
        to: run.from + 5,
      }]),
    );
    expect(heard).toBe(3);
  });

  it('stays quiet when nothing about the range changed', () => {
    const editor = open();
    const view = editor.prosemirrorView!;
    const run = firstRun(editor);
    view.dispatch(
      view.state.tr.setMeta(DOCUMENT_COMMENT_DRAFT_RANGE, [{
        from: run.from,
        to: run.from + 5,
      }]),
    );

    let heard = 0;
    const stop = onDraftChange(() => {
      heard += 1;
    });
    // An edit after the range, which moves neither end.
    view.dispatch(view.state.tr.insertText('!', run.to - 1));
    stop();

    expect(heard).toBe(0);
  });

  it('refuses to open on a range covering no words', () => {
    // The entries are unavailable over text-less ranges already
    // (`canCommentOver`), so one arriving here means a caller is wrong —
    // and holding it would let a comment be written with nothing under it.
    const editor = open();
    const view = editor.prosemirrorView!;
    const run = firstRun(editor);

    view.dispatch(
      view.state.tr.setMeta(DOCUMENT_COMMENT_DRAFT_RANGE, [{
        from: run.from,
        to: run.from,
      }]),
    );

    expect(draftRangeIn(view.state)).toBeNull();
  });

  it('refuses to open on a reversed range', () => {
    const editor = open();
    const view = editor.prosemirrorView!;
    const run = firstRun(editor);

    view.dispatch(
      view.state.tr.setMeta(DOCUMENT_COMMENT_DRAFT_RANGE, [{
        from: run.from + 5,
        to: run.from,
      }]),
    );

    expect(draftRangeIn(view.state)).toBeNull();
  });

  it('keeps the range across a selection change', () => {
    // Moving the caret is not an edit, and a reader clicking elsewhere before
    // typing their comment must not lose where it goes.
    const editor = open();
    const view = editor.prosemirrorView!;
    const run = firstRun(editor);
    const target = { from: run.from, to: run.from + 5 };

    view.dispatch(view.state.tr.setMeta(DOCUMENT_COMMENT_DRAFT_RANGE, [target]));
    view.dispatch(
      view.state.tr.setSelection(
        TextSelection.create(view.state.doc, run.to - 1),
      ),
    );

    expect(draftRangeIn(view.state)).toMatchObject({ segments: [target] });
  });
});
