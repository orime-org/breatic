// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Saving and restoring a document snapshot (inner#1129 design §7.4, §7.5).
 *
 * A snapshot is the body's ProseMirror JSON with its comment marks; a restore
 * replaces the whole body with it as one local edit and one undo step, and
 * leaves the comment threads alone (A4, A5, A6). These run on the real body
 * editor, its schema and its undo manager.
 */

import { afterEach, describe, expect, it } from 'vitest';
import fc from 'fast-check';
import * as Y from 'yjs';
import { documentBodyFragment } from '@breatic/shared';

import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';
import { createDocumentUndo } from '@web/spaces/document/document-undo-blocknote';
import { restoreSnapshot, snapshotOf } from '@web/spaces/document/document-version-restore';
import { tableBlock } from '@web/spaces/document/__tests__/table-fixtures';

type Editor = ReturnType<typeof buildDocumentEditor>;
type Json = Record<string, unknown>;
type Threads = ReadonlyMap<string, { resolved?: boolean; deletedAt?: unknown }>;

const mounted: Editor[] = [];

afterEach(() => {
  for (const editor of mounted.splice(0)) editor.unmount();
  document.body.innerHTML = '';
});

/** Mounts the body editor with its production undo. */
function open(blocks: unknown[]): { editor: Editor; undo: Y.UndoManager } {
  const doc = new Y.Doc();
  const { manager, extension } = createDocumentUndo(doc);
  const editor = buildDocumentEditor({ fragment: documentBodyFragment(doc), extensions: [extension] });
  const host = document.createElement('div');
  document.body.appendChild(host);
  editor.mount(host);
  mounted.push(editor);
  editor.replaceBlocks(editor.document, blocks as never);
  manager.clear();
  return { editor, undo: manager };
}

const json = (editor: Editor): Json => editor.prosemirrorState.doc.toJSON() as Json;
const text = (editor: Editor): string => editor.prosemirrorState.doc.textContent;

/** Types words at the end of the first text run, as the user would. */
function type(editor: Editor, words: string): void {
  const view = editor.prosemirrorView!;
  let end = -1;
  view.state.doc.descendants((node, pos) => {
    if (end < 0 && node.isText) end = pos + node.nodeSize;
    return end < 0;
  });
  view.dispatch(view.state.tr.insertText(words, end));
}

/** Puts a comment mark for a thread on the first run of `words`. */
function comment(editor: Editor, words: string, threadId: string): void {
  const view = editor.prosemirrorView!;
  let at = -1;
  view.state.doc.descendants((node, pos) => {
    if (at < 0 && node.isText && node.text!.includes(words)) at = pos + node.text!.indexOf(words);
    return at < 0;
  });
  view.dispatch(view.state.tr.addMark(at, at + words.length, view.state.schema.marks.comment!.create({ threadId, orphan: false })));
}

/** Every comment mark: its thread, its words and whether it is orphaned. */
function marks(editor: Editor): { threadId: string; text: string; orphan: boolean }[] {
  const out: { threadId: string; text: string; orphan: boolean }[] = [];
  editor.prosemirrorState.doc.descendants((node) => {
    for (const mark of node.marks) {
      if (mark.type.name === 'comment') out.push({ threadId: mark.attrs.threadId as string, text: node.text ?? '', orphan: mark.attrs.orphan === true });
    }
    return true;
  });
  return out;
}

const NO_THREADS: Threads = new Map();

describe('restoreSnapshot', () => {
  it('replaces the whole body with the snapshot, media and tables included', () => {
    const saved = open([
      { type: 'heading', props: { level: 2 }, content: 'Title' },
      { type: 'bulletListItem', content: 'item', children: [{ type: 'paragraph', content: 'child' }] },
      tableBlock({ rows: [{ cells: [{ blocks: [{ type: 'paragraph', content: 'a' }, { type: 'image', props: { url: 'https://assets.example.invalid/a.png', caption: 'A' } }] }, 'b'] }] }),
      { type: 'video', props: { url: 'https://assets.example.invalid/v.mp4' } },
      { type: 'audio', props: { url: 'https://assets.example.invalid/s.mp3' } },
    ]).editor;
    const { content } = snapshotOf(saved.prosemirrorState.doc);
    const { editor, undo } = open([{ type: 'paragraph', content: 'something else' }]);

    expect(restoreSnapshot({ editor, undoManager: undo, content, threads: NO_THREADS })).toBe('restored');

    expect(json(editor)).toEqual(json(saved));
  });

  it('is one undo step, apart from the typing just before and after it', () => {
    const { editor, undo } = open([{ type: 'paragraph', content: 'before' }]);
    const { content } = snapshotOf(open([{ type: 'paragraph', content: 'snap' }]).editor.prosemirrorState.doc);
    type(editor, ' typed');

    restoreSnapshot({ editor, undoManager: undo, content, threads: NO_THREADS });
    type(editor, '!');

    expect(text(editor)).toBe('snap!');
    editor.undo();
    expect(text(editor)).toBe('snap');
    editor.undo();
    expect(text(editor)).toBe('before typed');
  });

  it('writes nothing when the body already equals the snapshot', () => {
    const { editor, undo } = open([{ type: 'paragraph', content: 'same' }]);
    const before = json(editor);

    expect(restoreSnapshot({ editor, undoManager: undo, content: snapshotOf(editor.prosemirrorState.doc).content, threads: NO_THREADS })).toBe('unchanged');

    expect(json(editor)).toEqual(before);
    expect(undo.undoStack.length).toBe(0);
  });

  it('puts comments back where the snapshot had them and leaves later ones unanchored', () => {
    const { editor, undo } = open([{ type: 'paragraph', content: 'alpha beta gamma' }]);
    comment(editor, 'beta', 'kept');
    comment(editor, 'alpha', 'resolved-later');
    comment(editor, 'gamma', 'deleted-later');
    const { content } = snapshotOf(editor.prosemirrorState.doc);
    // After the snapshot: the text moves on and a new comment arrives.
    editor.replaceBlocks(editor.document, [{ type: 'paragraph', content: 'rewritten words' }] as never);
    comment(editor, 'words', 'added-later');
    const threads: Threads = new Map([
      ['kept', {}],
      ['resolved-later', { resolved: true }],
      ['deleted-later', { deletedAt: 1 }],
      ['added-later', {}],
    ]);

    restoreSnapshot({ editor, undoManager: undo, content, threads });

    expect(marks(editor)).toEqual([
      { threadId: 'resolved-later', text: 'alpha', orphan: true },
      { threadId: 'kept', text: 'beta', orphan: false },
      { threadId: 'deleted-later', text: 'gamma', orphan: true },
    ]);
  });

  it('orphans a comment whose thread no longer exists, and frees one that was reopened', () => {
    const { editor, undo } = open([{ type: 'paragraph', content: 'one two' }]);
    comment(editor, 'one', 'gone');
    comment(editor, 'two', 'reopened');
    const { content } = snapshotOf(editor.prosemirrorState.doc);
    const orphaned = JSON.parse(JSON.stringify(content).replace('"threadId":"reopened","orphan":false', '"threadId":"reopened","orphan":true')) as Json;
    editor.replaceBlocks(editor.document, [{ type: 'paragraph', content: 'x' }] as never);

    restoreSnapshot({ editor, undoManager: undo, content: orphaned, threads: new Map([['reopened', {}]]) });

    expect(marks(editor).map((m) => [m.threadId, m.orphan])).toEqual([['gone', true], ['reopened', false]]);
  });

  it('refuses content the body schema cannot hold and leaves the body as it was', () => {
    const { editor, undo } = open([{ type: 'paragraph', content: 'kept' }]);
    const before = json(editor);
    const foreign = { type: 'doc', content: [{ type: 'blockGroup', content: [{ type: 'notABlock' }] }] };

    expect(() => restoreSnapshot({ editor, undoManager: undo, content: foreign, threads: NO_THREADS })).toThrow();
    expect(() => restoreSnapshot({ editor, undoManager: undo, content: { type: 'doc', content: [] }, threads: NO_THREADS })).toThrow();

    expect(json(editor)).toEqual(before);
    expect(undo.undoStack.length).toBe(0);
  });

  it('restores random bodies exactly, and one undo takes the restore back', () => {
    const words = fc.stringMatching(/^[a-z]{1,5}$/);
    const block = fc.oneof(
      words.map((content) => ({ type: 'paragraph', content })),
      words.map((content) => ({ type: 'heading', props: { level: 3 }, content })),
      fc.tuple(words, words).map(([content, kid]) => ({ type: 'numberedListItem', content, children: [{ type: 'paragraph', content: kid }] })),
      fc.tuple(words, words).map(([a, b]) => tableBlock({ rows: [{ cells: [a, b] }] })),
      fc.nat(9).map((n) => ({ type: 'image', props: { url: `https://assets.example.invalid/${n}.png` } })),
    );
    const body = fc.array(block, { minLength: 1, maxLength: 5 });
    fc.assert(fc.property(body, body, fc.boolean(), (from, to, commented) => {
      const saved = open(to).editor;
      if (commented) comment(saved, saved.prosemirrorState.doc.textContent.slice(0, 1), 't');
      const { content } = snapshotOf(saved.prosemirrorState.doc);
      const { editor, undo } = open(from);
      const before = json(editor);

      const result = restoreSnapshot({ editor, undoManager: undo, content, threads: new Map([['t', {}]]) });

      expect(json(editor)).toEqual(json(saved));
      if (result === 'restored') {
        editor.undo();
        expect(json(editor)).toEqual(before);
      }
      for (const e of mounted.splice(0)) e.unmount();
    }), { numRuns: 25 });
  });
});

describe('snapshotOf', () => {
  const pending = { type: 'image', props: { uploadId: 'u1', url: '', caption: 'Pending' } };

  it('leaves out blocks still uploading, counting them', () => {
    const { editor } = open([
      { type: 'paragraph', content: 'kept' },
      pending,
      { type: 'video', props: { uploadId: 'u2', url: 'https://assets.example.invalid/done.mp4' } },
    ]);

    const { content, leftOut } = snapshotOf(editor.prosemirrorState.doc);

    expect(leftOut).toBe(1);
    expect(JSON.stringify(content)).not.toContain('"u1"');
    expect(JSON.stringify(content)).toContain('done.mp4');
    expect(() => editor.pmSchema.nodeFromJSON(content).check()).not.toThrow();
  });

  it('keeps a table cell valid when its only block was uploading', () => {
    const { editor } = open([tableBlock({ rows: [{ cells: [{ blocks: [pending] }, 'b'] }] })]);

    const { content, leftOut } = snapshotOf(editor.prosemirrorState.doc);

    expect(leftOut).toBe(1);
    const node = editor.pmSchema.nodeFromJSON(content);
    expect(() => node.check()).not.toThrow();
    expect(node.textContent).toBe('b');
  });

  it('drops a nested group whose only child was uploading, and a body of nothing else stays valid', () => {
    const { editor } = open([{ type: 'bulletListItem', content: 'item', children: [pending] }]);
    const nested = snapshotOf(editor.prosemirrorState.doc);
    expect(nested.leftOut).toBe(1);
    expect(() => editor.pmSchema.nodeFromJSON(nested.content).check()).not.toThrow();

    const only = open([pending]).editor;
    const alone = snapshotOf(only.prosemirrorState.doc);
    expect(alone.leftOut).toBe(1);
    expect(() => only.pmSchema.nodeFromJSON(alone.content).check()).not.toThrow();
  });

  it('keeps what is nested under a block still uploading, in its place', () => {
    const { editor } = open([
      { type: 'paragraph', content: 'before' },
      { ...pending, children: [{ type: 'paragraph', content: 'child one' }, { type: 'paragraph', content: 'child two' }] },
      { type: 'paragraph', content: 'after' },
    ]);

    const { content, leftOut } = snapshotOf(editor.prosemirrorState.doc);

    expect(leftOut).toBe(1);
    const node = editor.pmSchema.nodeFromJSON(content);
    expect(() => node.check()).not.toThrow();
    const lines: string[] = [];
    node.firstChild!.forEach((block) => lines.push(block.textContent));
    expect(lines).toEqual(['before', 'child one', 'child two', 'after']);
  });

  it('does not change the body it reads', () => {
    const { editor } = open([{ type: 'paragraph', content: 'kept' }, pending]);
    const before = json(editor);

    snapshotOf(editor.prosemirrorState.doc);

    expect(json(editor)).toEqual(before);
  });
});
