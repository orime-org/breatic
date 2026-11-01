// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The AI output dialog's original range (inner#1860, design §5.4, §6.3): the
 * words the reader selected, followed while the dialog is open, through the
 * same local-range tracking the unposted comment uses, in an instance of its
 * own. Every editor `buildDocumentEditor` builds carries it.
 *
 * present → gone once no letter is left, by the reader's own edit or one that
 * comes in through Yjs; gone stays gone, even when undo writes the words back
 * (the comment draft's rule, `document-comment-draft-range.ts`).
 *
 * The comment draft's own tests stay as they are
 * (`document-comment-draft-range.test.ts`); the cases here that open both
 * pin that the two instances do not reach each other.
 */

import { afterEach, describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { TextSelection } from '@tiptap/pm/state';
import { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';

import { documentBodyFragment, encodeInitialSpaceContent } from '@breatic/shared';

import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';
import { aiRangeIn, DOCUMENT_AI_RANGE } from '@web/spaces/document/document-ai-range';
import {
  DOCUMENT_COMMENT_DRAFT_RANGE,
  draftRangeIn,
} from '@web/spaces/document/document-comment-draft-range';
import {
  _resetDocumentEditorCacheForTests,
  adoptDocumentEditor,
  getDocumentEditor,
  type DocumentEditorHandle,
} from '@web/spaces/document/document-editor-cache';
import { createDocumentUndo } from '@web/spaces/document/document-undo-blocknote';

type Editor = ReturnType<typeof buildDocumentEditor>;

const mounted: Editor[] = [];

afterEach(() => {
  mounted.splice(0).forEach((editor) => {
    editor.unmount();
  });
  _resetDocumentEditorCacheForTests();
  document.body.innerHTML = '';
});

/**
 * A mounted document as a Space opens it, with its undo manager.
 * @param words - The one paragraph it holds.
 * @returns The handle.
 */
async function openHandle(words: string): Promise<DocumentEditorHandle> {
  const doc = new Y.Doc();
  const handle = getDocumentEditor(doc, `project-p/document-${String(Math.random())}`, {
    caretProvider: { awareness: new Awareness(doc) },
    readWho: () => ({ role: 'editor', viewerId: 'reader-1' }),
    editable: true,
  });
  const root = document.createElement('div');
  document.body.appendChild(root);
  adoptDocumentEditor(handle, root);
  handle.editor.replaceBlocks(handle.editor.document, await handle.editor.tryParseMarkdownToBlocks(words));
  handle.undoManager.clear();
  return handle;
}

/**
 * A mounted editor over a Y.Doc, the way a second client opens it.
 * @param doc - Its copy of the document.
 * @returns The editor.
 */
function openClient(doc: Y.Doc): Editor {
  const editor = buildDocumentEditor({
    fragment: documentBodyFragment(doc),
    extensions: [createDocumentUndo(doc).extension],
  });
  const root = document.createElement('div');
  document.body.appendChild(root);
  editor.mount(root);
  mounted.push(editor);
  return editor;
}

/** Exchanges everything each side is missing, both ways. */
function sync(a: Y.Doc, b: Y.Doc): void {
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a, Y.encodeStateVector(b)));
  Y.applyUpdate(a, Y.encodeStateAsUpdate(b, Y.encodeStateVector(a)));
}

/**
 * Where some words sit in the body.
 * @param editor - The editor.
 * @param words - Words inside one text node.
 * @returns From their first letter to just past their last.
 * @throws {Error} When no text node holds them.
 */
function rangeOf(editor: Pick<Editor, 'prosemirrorState'>, words: string): { from: number; to: number } {
  let found: { from: number; to: number } | null = null;
  editor.prosemirrorState.doc.descendants((node, pos) => {
    if (found !== null) return false;
    const index = node.isText ? (node.text ?? '').indexOf(words) : -1;
    if (index >= 0) found = { from: pos + index, to: pos + index + words.length };
    return found === null;
  });
  if (found === null) throw new Error(`no text holds ${JSON.stringify(words)}`);
  return found;
}

/**
 * The words the AI range covers now.
 * @param editor - The editor.
 * @returns The words, or the range's kind when it covers none.
 */
function aiWords(editor: Pick<Editor, 'prosemirrorState'>): string {
  const range = aiRangeIn(editor.prosemirrorState);
  if (range === null) return 'none';
  if (range.kind === 'gone') return 'gone';
  return range.segments.map(({ from, to }) => editor.prosemirrorState.doc.textBetween(from, to)).join('|');
}

describe('the AI dialog\'s range', () => {
  it('is there in every editor the builder makes, holding nothing until opened', async () => {
    const handle = await openHandle('The quick brown fox.');

    expect(aiRangeIn(handle.editor.prosemirrorState)).toBeNull();
  });

  it('holds the words it was opened on and follows them through the reader\'s edits', async () => {
    const handle = await openHandle('The quick brown fox.');
    const view = handle.editor.prosemirrorView!;
    view.dispatch(view.state.tr.setMeta(DOCUMENT_AI_RANGE, [rangeOf(handle.editor, 'quick brown')]));

    expect(aiWords(handle.editor)).toBe('quick brown');

    view.dispatch(view.state.tr.insertText('Look: ', rangeOf(handle.editor, 'The').from));
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, rangeOf(handle.editor, 'fox').from)));

    expect(aiWords(handle.editor)).toBe('quick brown');
  });

  it('is gone once every word it covered is deleted', async () => {
    const handle = await openHandle('The quick brown fox.');
    const view = handle.editor.prosemirrorView!;
    const target = rangeOf(handle.editor, 'quick brown');
    view.dispatch(view.state.tr.setMeta(DOCUMENT_AI_RANGE, [target]));

    view.dispatch(view.state.tr.delete(target.from, target.to));

    expect(aiRangeIn(handle.editor.prosemirrorState)).toEqual({ kind: 'gone' });
  });

  it('stays gone when undo writes the words back', async () => {
    const handle = await openHandle('The quick brown fox.');
    const view = handle.editor.prosemirrorView!;
    const target = rangeOf(handle.editor, 'quick brown');
    view.dispatch(view.state.tr.setMeta(DOCUMENT_AI_RANGE, [target]));
    handle.undoManager.stopCapturing();
    view.dispatch(view.state.tr.delete(target.from, target.to));
    handle.undoManager.stopCapturing();

    handle.undoManager.undo();

    expect(handle.editor.prosemirrorState.doc.textContent).toContain('quick brown');
    expect(aiRangeIn(handle.editor.prosemirrorState)).toEqual({ kind: 'gone' });
  });

  it('closes', async () => {
    const handle = await openHandle('The quick brown fox.');
    const view = handle.editor.prosemirrorView!;
    view.dispatch(view.state.tr.setMeta(DOCUMENT_AI_RANGE, [rangeOf(handle.editor, 'quick')]));

    view.dispatch(view.state.tr.setMeta(DOCUMENT_AI_RANGE, null));

    expect(aiRangeIn(handle.editor.prosemirrorState)).toBeNull();
  });

  it('follows a collaborator\'s edit that comes in through Yjs, and goes when they delete the words', () => {
    const docA = new Y.Doc();
    Y.applyUpdate(docA, encodeInitialSpaceContent('document'));
    const docB = new Y.Doc();
    Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA));
    const a = openClient(docA);
    const b = openClient(docB);
    a.replaceBlocks(a.document, [{ type: 'paragraph', content: 'The quick brown fox.' }] as never);
    sync(docA, docB);
    const viewA = a.prosemirrorView!;
    viewA.dispatch(viewA.state.tr.setMeta(DOCUMENT_AI_RANGE, [rangeOf(a, 'quick brown')]));

    const viewB = b.prosemirrorView!;
    viewB.dispatch(viewB.state.tr.insertText('Look: ', rangeOf(b, 'The').from));
    sync(docA, docB);

    expect(a.prosemirrorState.doc.textContent).toContain('Look: The quick brown fox.');
    expect(aiWords(a)).toBe('quick brown');

    const gone = rangeOf(b, 'quick brown');
    viewB.dispatch(viewB.state.tr.delete(gone.from, gone.to));
    sync(docA, docB);

    expect(aiRangeIn(a.prosemirrorState)).toEqual({ kind: 'gone' });
  });
});

describe('the AI range under any mix of edits (property)', () => {
  /** One edit: by the reader (local) or a collaborator (through Yjs), or an undo / redo of the reader's. */
  type Edit =
    | { readonly by: 'reader' | 'collaborator'; readonly kind: 'insert'; readonly at: number; readonly text: string }
    | { readonly by: 'reader' | 'collaborator'; readonly kind: 'delete'; readonly at: number; readonly length: number }
    | { readonly by: 'reader'; readonly kind: 'undo' | 'redo' };

  const edit: fc.Arbitrary<Edit> = fc.oneof(
    fc.record({ by: fc.constantFrom('reader' as const, 'collaborator' as const), kind: fc.constant('insert' as const), at: fc.nat(), text: fc.constantFrom('x', 'yz', ' ') }),
    fc.record({ by: fc.constantFrom('reader' as const, 'collaborator' as const), kind: fc.constant('delete' as const), at: fc.nat(), length: fc.integer({ min: 1, max: 6 }) }),
    fc.record({ by: fc.constant('reader' as const), kind: fc.constantFrom('undo' as const, 'redo' as const) }),
  );

  /**
   * The capital letters of a text: only the original words have any.
   * @param text - The text.
   * @returns Its capitals, in order.
   */
  const capitals = (text: string): string => text.replace(/[^A-Z]/g, '');

  it('covers exactly the original letters still in the body, and once gone stays gone', () => {
    fc.assert(
      fc.property(fc.array(edit, { minLength: 1, maxLength: 25 }), (edits) => {
        const docA = new Y.Doc();
        Y.applyUpdate(docA, encodeInitialSpaceContent('document'));
        const docB = new Y.Doc();
        Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA));
        const undo = createDocumentUndo(docA);
        const a = buildDocumentEditor({ fragment: documentBodyFragment(docA), extensions: [undo.extension] });
        const rootA = document.createElement('div');
        document.body.appendChild(rootA);
        a.mount(rootA);
        mounted.push(a);
        const b = openClient(docB);
        a.replaceBlocks(a.document, [{ type: 'paragraph', content: 'left ABCDEF right' }] as never);
        sync(docA, docB);
        undo.manager.clear();
        const viewA = a.prosemirrorView!;
        viewA.dispatch(viewA.state.tr.setMeta(DOCUMENT_AI_RANGE, [rangeOf(a, 'ABCDEF')]));

        let wasGone = false;
        for (const step of edits) {
          if (!('at' in step)) {
            undo.manager.stopCapturing();
            if (step.kind === 'undo') undo.manager.undo();
            else undo.manager.redo();
          } else {
            const view = step.by === 'reader' ? viewA : b.prosemirrorView!;
            const size = view.state.doc.content.size;
            // Positions inside the paragraph's text: 1 past the block wrappers.
            const textStart = 3;
            const textEnd = Math.max(textStart, size - 3);
            const at = textStart + (step.at % (textEnd - textStart + 1));
            const tr = 'text' in step
              ? view.state.tr.insertText(step.text, at)
              : view.state.tr.delete(at, Math.min(textEnd, at + step.length));
            if (step.kind === 'insert' || tr.docChanged) {
              if (step.by === 'reader') undo.manager.stopCapturing();
              view.dispatch(tr);
            }
          }
          sync(docA, docB);

          const range = aiRangeIn(a.prosemirrorState);
          const left = capitals(a.prosemirrorState.doc.textContent);
          if (wasGone) expect(range).toEqual({ kind: 'gone' });
          if (range?.kind === 'present') {
            expect(capitals(aiWords(a))).toBe(left);
          } else {
            wasGone = true;
          }
          if (left === '') {
            expect(range).toEqual({ kind: 'gone' });
            wasGone = true;
          }
        }
      }),
      { numRuns: 40 },
    );
  });
});

describe('the AI range beside an unposted comment', () => {
  it('each holds its own words', async () => {
    const handle = await openHandle('The quick brown fox jumps.');
    const view = handle.editor.prosemirrorView!;
    view.dispatch(view.state.tr.setMeta(DOCUMENT_COMMENT_DRAFT_RANGE, [rangeOf(handle.editor, 'fox')]));
    view.dispatch(view.state.tr.setMeta(DOCUMENT_AI_RANGE, [rangeOf(handle.editor, 'quick')]));

    expect(aiWords(handle.editor)).toBe('quick');
    const draft = draftRangeIn(handle.editor.prosemirrorState);
    expect(draft?.segments.map(({ from, to }) => handle.editor.prosemirrorState.doc.textBetween(from, to))).toEqual(['fox']);
  });

  it('losing the AI range\'s words leaves the comment draft aimed', async () => {
    const handle = await openHandle('The quick brown fox jumps.');
    const view = handle.editor.prosemirrorView!;
    view.dispatch(view.state.tr.setMeta(DOCUMENT_COMMENT_DRAFT_RANGE, [rangeOf(handle.editor, 'fox')]));
    const quick = rangeOf(handle.editor, 'quick');
    view.dispatch(view.state.tr.setMeta(DOCUMENT_AI_RANGE, [quick]));

    view.dispatch(view.state.tr.delete(quick.from, quick.to));

    expect(aiRangeIn(handle.editor.prosemirrorState)).toEqual({ kind: 'gone' });
    expect(draftRangeIn(handle.editor.prosemirrorState)).not.toBeNull();
  });

  it('closing one leaves the other', async () => {
    const handle = await openHandle('The quick brown fox jumps.');
    const view = handle.editor.prosemirrorView!;
    view.dispatch(view.state.tr.setMeta(DOCUMENT_COMMENT_DRAFT_RANGE, [rangeOf(handle.editor, 'fox')]));
    view.dispatch(view.state.tr.setMeta(DOCUMENT_AI_RANGE, [rangeOf(handle.editor, 'quick')]));

    view.dispatch(view.state.tr.setMeta(DOCUMENT_AI_RANGE, null));
    expect(draftRangeIn(handle.editor.prosemirrorState)).not.toBeNull();

    view.dispatch(view.state.tr.setMeta(DOCUMENT_AI_RANGE, [rangeOf(handle.editor, 'quick')]));
    view.dispatch(view.state.tr.setMeta(DOCUMENT_COMMENT_DRAFT_RANGE, null));
    expect(aiWords(handle.editor)).toBe('quick');
  });
});
