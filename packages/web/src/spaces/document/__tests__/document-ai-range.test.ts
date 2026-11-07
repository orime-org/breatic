// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The AI output dialog's original range (inner#1860, design §5.4, §6.3): the
 * words the user selected, followed while the dialog is open, through the
 * same local-range tracking the unposted comment uses, in an instance of its
 * own. Every editor `buildDocumentEditor` builds carries it.
 *
 * present → gone once no letter is left, by the user's own edit or one that
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
import { aiCoverIn, aiRangeIn, DOCUMENT_AI_RANGE } from '@web/spaces/document/document-ai-range';
import { EMPTY_LINE_CLASS, MEDIA_IN_SELECTION_CLASS } from '@web/spaces/document/document-selection-paint';
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
    readWho: () => ({ role: 'editor', viewerId: 'user-1' }),
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
 * Opens the range on a stretch inside one block, as the dialog does.
 * @param range - The stretch.
 * @returns The command.
 */
function at(range: { from: number; to: number }): { range: { from: number; to: number }; firstId: null; lastId: null } {
  return { range, firstId: null, lastId: null };
}

/**
 * What replace would cover now, as a list.
 * @param editor - The editor.
 * @returns The one range, or none.
 */
function coverList(editor: Pick<Editor, 'prosemirrorState'>): { from: number; to: number }[] {
  const cover = aiCoverIn(editor.prosemirrorState);
  return cover === null ? [] : [cover];
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
  return coverList(editor).map(({ from, to }) => editor.prosemirrorState.doc.textBetween(from, to)).join('|');
}

describe('the AI dialog\'s range', () => {
  it('is there in every editor the builder makes, holding nothing until opened', async () => {
    const handle = await openHandle('The quick brown fox.');

    expect(aiRangeIn(handle.editor.prosemirrorState)).toBeNull();
  });

  it('holds the words it was opened on and follows them through the user\'s edits', async () => {
    const handle = await openHandle('The quick brown fox.');
    const view = handle.editor.prosemirrorView!;
    view.dispatch(view.state.tr.setMeta(DOCUMENT_AI_RANGE, at(rangeOf(handle.editor, 'quick brown'))));

    expect(aiWords(handle.editor)).toBe('quick brown');

    view.dispatch(view.state.tr.insertText('Look: ', rangeOf(handle.editor, 'The').from));
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, rangeOf(handle.editor, 'fox').from)));

    expect(aiWords(handle.editor)).toBe('quick brown');
  });

  it('is gone once every word it covered is deleted', async () => {
    const handle = await openHandle('The quick brown fox.');
    const view = handle.editor.prosemirrorView!;
    const target = rangeOf(handle.editor, 'quick brown');
    view.dispatch(view.state.tr.setMeta(DOCUMENT_AI_RANGE, at(target)));

    view.dispatch(view.state.tr.delete(target.from, target.to));

    expect(aiRangeIn(handle.editor.prosemirrorState)).toEqual({ kind: 'gone' });
  });

  it('stays gone when undo writes the words back', async () => {
    const handle = await openHandle('The quick brown fox.');
    const view = handle.editor.prosemirrorView!;
    const target = rangeOf(handle.editor, 'quick brown');
    view.dispatch(view.state.tr.setMeta(DOCUMENT_AI_RANGE, at(target)));
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
    view.dispatch(view.state.tr.setMeta(DOCUMENT_AI_RANGE, at(rangeOf(handle.editor, 'quick'))));

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
    viewA.dispatch(viewA.state.tr.setMeta(DOCUMENT_AI_RANGE, at(rangeOf(a, 'quick brown'))));

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
  /** One edit: by the user (local) or a collaborator (through Yjs), or an undo / redo of the user's. */
  type Edit =
    | { readonly by: 'user' | 'collaborator'; readonly kind: 'insert'; readonly at: number; readonly text: string }
    | { readonly by: 'user' | 'collaborator'; readonly kind: 'delete'; readonly at: number; readonly length: number }
    | { readonly by: 'user'; readonly kind: 'overtype'; readonly at: number; readonly length: number; readonly text: string }
    | { readonly by: 'user'; readonly kind: 'undo' | 'redo' };

  const edit: fc.Arbitrary<Edit> = fc.oneof(
    fc.record({ by: fc.constantFrom('user' as const, 'collaborator' as const), kind: fc.constant('insert' as const), at: fc.nat(), text: fc.constantFrom('x', 'yz', ' ') }),
    fc.record({ by: fc.constantFrom('user' as const, 'collaborator' as const), kind: fc.constant('delete' as const), at: fc.nat(), length: fc.integer({ min: 1, max: 6 }) }),
    fc.record({ by: fc.constant('user' as const), kind: fc.constantFrom('undo' as const, 'redo' as const) }),
    fc.record({ by: fc.constant('user' as const), kind: fc.constant('overtype' as const), at: fc.nat(), length: fc.integer({ min: 1, max: 6 }), text: fc.constantFrom('x', 'yz') }),
  );

  /**
   * The capital letters of a text: only the original words have any.
   * @param text - The text.
   * @returns Its capitals, in order.
   */
  const capitals = (text: string): string => text.replace(/[^A-Z]/g, '');

  const holdsItsLetters = fc.property(fc.array(edit, { minLength: 1, maxLength: 25 }), (edits) => {
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
    viewA.dispatch(viewA.state.tr.setMeta(DOCUMENT_AI_RANGE, at(rangeOf(a, 'ABCDEF'))));

    let wasGone = false;
    let peerTouched = false;
    for (const step of edits) {
      if (!('at' in step)) {
        undo.manager.stopCapturing();
        if (step.kind === 'undo') undo.manager.undo();
        else undo.manager.redo();
      } else {
        const view = step.by === 'user' ? viewA : b.prosemirrorView!;
        const size = view.state.doc.content.size;
        // Positions inside the paragraph's text: 1 past the block wrappers.
        const textStart = 3;
        const textEnd = Math.max(textStart, size - 3);
        const at = textStart + (step.at % (textEnd - textStart + 1));
        const end = 'length' in step ? Math.min(textEnd, at + step.length) : at;
        const tr = step.kind === 'insert'
          ? view.state.tr.insertText(step.text, at)
          : step.kind === 'overtype' ? view.state.tr.insertText(step.text, at, end) : view.state.tr.delete(at, end);
        // A collaborator editing the range's words while the user edits
        // them too is outside what the range answers for (concurrent edits of
        // the same words): after it, only gone staying gone is held to.
        const held = aiRangeIn(a.prosemirrorState);
        const reach = { from: at, to: end };
        if (step.by === 'collaborator' && held?.kind === 'present' && coverList(a).some(({ from, to }) => reach.to >= from && reach.from <= to)) peerTouched = true;
        if (step.kind !== 'delete' || tr.docChanged) {
          if (step.by === 'user') undo.manager.stopCapturing();
          view.dispatch(tr);
        }
      }
      sync(docA, docB);

      const range = aiRangeIn(a.prosemirrorState);
      const left = capitals(a.prosemirrorState.doc.textContent);
      if (wasGone) expect(range).toEqual({ kind: 'gone' });
      if (range?.kind === 'present') {
        if (!peerTouched) expect(capitals(aiWords(a))).toBe(left);
      } else {
        wasGone = true;
      }
    }
  });

  it('covers exactly the original letters still in the body, and once gone stays gone', () => {
    fc.assert(holdsItsLetters, { numRuns: 40 });
  });

  it.each([-1009072999, -1635687800])('holds to its letters under the edits of seed %i', (seed) => {
    fc.assert(holdsItsLetters, { numRuns: 40, seed });
  });

  it('holds what the user types over its words, and keeps them when typing over words before them', () => {
    const overAll: Edit[] = [{ by: 'user', kind: 'overtype', at: 5, length: 6, text: 'yz' }];
    const overHalves: Edit[] = [
      { by: 'user', kind: 'overtype', at: 8, length: 3, text: 'x' },
      { by: 'user', kind: 'delete', at: 5, length: 3 },
    ];
    const overBefore: Edit[] = [
      { by: 'user', kind: 'overtype', at: 0, length: 4, text: 'x' },
      { by: 'user', kind: 'insert', at: 0, text: 'x' },
    ];
    fc.assert(holdsItsLetters, { numRuns: 1, examples: [[overAll], [overHalves], [overBefore]] });
  });

  it('gives back a piece cut off by typing once undo writes its deleted letters back', () => {
    const typedThenDeleted: Edit[] = [
      { by: 'user', kind: 'insert', at: 957030108, text: 'x' },
      { by: 'user', kind: 'delete', at: 53248643, length: 3 },
      { by: 'user', kind: 'undo' },
    ];
    fc.assert(holdsItsLetters, { numRuns: 1, examples: [[typedThenDeleted]] });
  });
});

describe('the comment draft over several stretches', () => {
  it('gives each stretch back its own words when undo writes a deleted one back', async () => {
    const handle = await openHandle('alpha beta gamma');
    const view = handle.editor.prosemirrorView!;
    view.dispatch(view.state.tr.setMeta(DOCUMENT_COMMENT_DRAFT_RANGE, [rangeOf(handle.editor, 'alpha'), rangeOf(handle.editor, 'beta'), rangeOf(handle.editor, 'gamma')]));
    handle.undoManager.stopCapturing();
    const gone = rangeOf(handle.editor, 'beta');
    view.dispatch(view.state.tr.delete(gone.from, gone.to));
    handle.undoManager.stopCapturing();
    const words = (): string[] => draftRangeIn(handle.editor.prosemirrorState)!.segments.map(({ from, to }) => handle.editor.prosemirrorState.doc.textBetween(from, to));
    expect(words()).toEqual(['alpha', 'gamma']);
    handle.undoManager.undo();
    expect(words()).toEqual(['alpha', 'beta', 'gamma']);
  });
});

describe('the AI range beside an unposted comment', () => {
  it('each holds its own words', async () => {
    const handle = await openHandle('The quick brown fox jumps.');
    const view = handle.editor.prosemirrorView!;
    view.dispatch(view.state.tr.setMeta(DOCUMENT_COMMENT_DRAFT_RANGE, [rangeOf(handle.editor, 'fox')]));
    view.dispatch(view.state.tr.setMeta(DOCUMENT_AI_RANGE, at(rangeOf(handle.editor, 'quick'))));

    expect(aiWords(handle.editor)).toBe('quick');
    const draft = draftRangeIn(handle.editor.prosemirrorState);
    expect(draft?.segments.map(({ from, to }) => handle.editor.prosemirrorState.doc.textBetween(from, to))).toEqual(['fox']);
  });

  it('losing the AI range\'s words leaves the comment draft aimed', async () => {
    const handle = await openHandle('The quick brown fox jumps.');
    const view = handle.editor.prosemirrorView!;
    view.dispatch(view.state.tr.setMeta(DOCUMENT_COMMENT_DRAFT_RANGE, [rangeOf(handle.editor, 'fox')]));
    const quick = rangeOf(handle.editor, 'quick');
    view.dispatch(view.state.tr.setMeta(DOCUMENT_AI_RANGE, at(quick)));

    view.dispatch(view.state.tr.delete(quick.from, quick.to));

    expect(aiRangeIn(handle.editor.prosemirrorState)).toEqual({ kind: 'gone' });
    expect(draftRangeIn(handle.editor.prosemirrorState)).not.toBeNull();
  });

  it('closing one leaves the other', async () => {
    const handle = await openHandle('The quick brown fox jumps.');
    const view = handle.editor.prosemirrorView!;
    view.dispatch(view.state.tr.setMeta(DOCUMENT_COMMENT_DRAFT_RANGE, [rangeOf(handle.editor, 'fox')]));
    view.dispatch(view.state.tr.setMeta(DOCUMENT_AI_RANGE, at(rangeOf(handle.editor, 'quick'))));

    view.dispatch(view.state.tr.setMeta(DOCUMENT_AI_RANGE, null));
    expect(draftRangeIn(handle.editor.prosemirrorState)).not.toBeNull();

    view.dispatch(view.state.tr.setMeta(DOCUMENT_AI_RANGE, at(rangeOf(handle.editor, 'quick'))));
    view.dispatch(view.state.tr.setMeta(DOCUMENT_COMMENT_DRAFT_RANGE, null));
    expect(aiWords(handle.editor)).toBe('quick');
  });
});

describe('the range painted while the dialog holds the focus (§5.3)', () => {
  it('paints an image and an empty line at its edges, and an image inside, as selected', async () => {
    const handle = await openHandle('x');
    handle.editor.replaceBlocks(handle.editor.document, [
      { type: 'paragraph', content: 'Before.' },
      { type: 'image', props: { url: 'https://assets.example/a.png' } },
      { type: 'paragraph', content: 'Middle.' },
      { type: 'image', props: { url: 'https://assets.example/b.png' } },
      { type: 'paragraph', content: 'More.' },
      { type: 'paragraph' },
      { type: 'paragraph', content: 'After.' },
    ] as never);
    const ids = (handle.editor.document as Array<{ id: string }>).map((b) => b.id);
    const view = handle.editor.prosemirrorView!;
    view.dispatch(view.state.tr.setMeta(DOCUMENT_AI_RANGE, {
      range: { from: rangeOf(handle.editor, 'Middle.').from, to: rangeOf(handle.editor, 'More.').to },
      firstId: ids[1]!,
      lastId: ids[5]!,
    }));
    view.dom.blur();

    const painted = (id: string, cls: string): boolean =>
      view.dom.querySelector(`[data-id="${id}"] .${cls}, [data-id="${id}"].${cls}`) !== null
      || [...view.dom.querySelectorAll(`.${cls}`)].some((el) => el.closest(`[data-id="${id}"]`) !== null);
    expect([painted(ids[1]!, MEDIA_IN_SELECTION_CLASS), painted(ids[3]!, MEDIA_IN_SELECTION_CLASS), painted(ids[5]!, EMPTY_LINE_CLASS)]).toEqual([true, true, true]);
    expect(painted(ids[0]!, MEDIA_IN_SELECTION_CLASS) || painted(ids[6]!, EMPTY_LINE_CLASS)).toBe(false);
  });
});
