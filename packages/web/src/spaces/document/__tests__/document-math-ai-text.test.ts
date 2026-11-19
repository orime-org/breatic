// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * inner#1423 A10, design 6.6: formulas through the AI
 * dialog's text layer.
 *
 * A formula's source is exempt from the escaping on the way out and the
 * repair on the way back, as a code block's is, so an echoed answer keeps
 * every backslash. Words that read `$$x$$` without being a formula have their
 * dollars escaped going out, so the echo is words again, not a formula.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';
import { TextSelection } from '@tiptap/pm/state';

import { aiCapture } from '@web/spaces/document/document-ai-launch';
import { aiCoverIn, DOCUMENT_AI_RANGE } from '@web/spaces/document/document-ai-range';
import { aiAnswer, aiRequest, replaceAiAnswer } from '@web/spaces/document/document-ai-text';
import {
  _resetDocumentEditorCacheForTests,
  adoptDocumentEditor,
  getDocumentEditor,
  type DocumentEditorHandle,
} from '@web/spaces/document/document-editor-cache';
import type { LocalRange } from '@web/spaces/document/document-local-range';
import type { ProposalAdmission } from '@web/spaces/document/document-proposal-landing';
import { sourceOf } from '@web/spaces/document/__tests__/math-fixtures';

/** Our own asset host, so media there is ours and survives a write. */
const OURS = 'https://assets.example/';

vi.mock('@web/spaces/document/document-external-media', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ourMediaPrefix: () => OURS,
  ourMediaPrefixReady: async () => OURS,
}));

afterEach(() => {
  _resetDocumentEditorCacheForTests();
  document.body.innerHTML = '';
});

const WRITABLE = (): ProposalAdmission => ({ available: true, writeAccess: 'granted' });

/** A block as the editor reads it, loosely typed. */
interface Seen {
  id: string;
  type: string;
  content: unknown;
  children: Seen[];
}

/** One piece of inline content, loosely typed. */
interface Piece {
  type: string;
  text?: string;
  content?: unknown;
}

/**
 * A mounted document holding some blocks, as a Space opens it.
 * @param list - The blocks, as the block API takes them.
 * @returns The handle.
 */
function openBlocks(list: unknown[]): DocumentEditorHandle {
  const doc = new Y.Doc();
  const handle = getDocumentEditor(doc, `project-p/document-${String(Math.random())}`, {
    caretProvider: { awareness: new Awareness(doc) },
    readWho: () => ({ role: 'editor', viewerId: 'user-1' }),
    editable: true,
  });
  const root = document.createElement('div');
  document.body.appendChild(root);
  adoptDocumentEditor(handle, root);
  handle.editor.replaceBlocks(handle.editor.document, list as never);
  handle.undoManager.clear();
  return handle;
}

/**
 * The body's blocks.
 * @param handle - The document.
 * @returns Them.
 */
function blocks(handle: DocumentEditorHandle): Seen[] {
  return handle.editor.document as unknown as Seen[];
}

/**
 * The words of some content: a string, or styled text pieces.
 * @param content - The content.
 * @returns The words.
 */
function wordsOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return (content as Piece[]).map((piece) => (piece.type === 'text' ? piece.text ?? '' : '')).join('');
}

/**
 * Each top block as its type, its words and the formulas it holds.
 * @param handle - The document.
 * @returns One line per block: `type|words|kind:source,…`.
 */
function shape(handle: DocumentEditorHandle): string[] {
  return blocks(handle).map((block) => {
    const inline = Array.isArray(block.content)
      ? (block.content as Piece[]).filter((piece) => piece.type === 'math').map((piece) => `inline:${sourceOf(piece)}`)
      : [];
    const own = block.type === 'mathBlock' ? [`block:${sourceOf(block)}`] : [];
    return `${block.type}|${wordsOf(block.content)}|${[...own, ...inline].join(',')}`;
  });
}

/**
 * Where some words sit.
 * @param handle - The document.
 * @param words - Words inside one text node.
 * @returns Their range.
 * @throws {Error} When no text node holds them.
 */
function rangeOf(handle: DocumentEditorHandle, words: string): LocalRange {
  let found: LocalRange | null = null;
  handle.editor.prosemirrorState.doc.descendants((node, pos) => {
    if (found !== null) return false;
    const index = node.isText ? (node.text ?? '').indexOf(words) : -1;
    if (index >= 0) found = { from: pos + index, to: pos + index + words.length };
    return found === null;
  });
  if (found === null) throw new Error(`no text holds ${JSON.stringify(words)}`);
  return found;
}

/**
 * Opens the dialog over a stretch, answers what the model is given back and
 * replaces, as the dialog does.
 * @param handle - The document.
 * @param range - The stretch.
 */
function echo(handle: DocumentEditorHandle, range: LocalRange): void {
  const view = handle.editor.prosemirrorView!;
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, range.from, range.to)));
  const captured = aiCapture(view.state);
  expect(captured).not.toBeNull();
  view.dispatch(view.state.tr.setMeta(DOCUMENT_AI_RANGE, captured));
  const state = handle.editor.prosemirrorState;
  const sent = aiRequest(handle.editor, state.doc, aiCoverIn(state)!);
  const answer = aiAnswer(handle.editor, state, sent, OURS, captured!.insertId!);
  expect(replaceAiAnswer(handle, answer, WRITABLE).outcome).toBe('written');
}

/**
 * Echoes everything from the first paragraph to the last.
 * @param handle - The document.
 */
function echoAll(handle: DocumentEditorHandle): void {
  echo(handle, { from: rangeOf(handle, 'Before').from, to: rangeOf(handle, 'After').to });
}

const SOURCES = ['\\frac{a}{b}', 'a\\,b', '50\\%', '\\begin{pmatrix}a\\\\b\\end{pmatrix}', '10\\$'];

describe('formulas echoed through the AI dialog', () => {
  it.each(SOURCES)('keeps the inline source %s', (source) => {
    const h = openBlocks([
      { type: 'paragraph', content: 'Before' },
      { type: 'paragraph', content: [{ type: 'text', text: 'Mass ', styles: {} }, { type: 'math', props: { source: source } }, { type: 'text', text: ' here', styles: {} }] },
      { type: 'paragraph', content: 'After' },
    ]);
    const before = shape(h);

    echoAll(h);

    expect(shape(h)).toEqual(before);
    expect(shape(h)[1]).toBe(`paragraph|Mass  here|inline:${source}`);
  });

  it.each(SOURCES)('keeps the block source %s', (source) => {
    const h = openBlocks([
      { type: 'paragraph', content: 'Before' },
      { type: 'mathBlock', props: { source: source } },
      { type: 'paragraph', content: 'After' },
    ]);

    echoAll(h);

    expect(shape(h)).toEqual(['paragraph|Before|', `mathBlock||block:${source}`, 'paragraph|After|']);
  });

  it.each([
    ['two formulas side by side', [{ type: 'math', props: { source: 'x' } }, { type: 'math', props: { source: 'y' } }], 'paragraph|Mass  here|inline:x,inline:y'],
    ['an empty formula', [{ type: 'math', props: { source: '' } }], 'paragraph|Mass  here|inline:'],
  ])('keeps %s', (_name, formulas, written) => {
    const h = openBlocks([
      { type: 'paragraph', content: 'Before' },
      { type: 'paragraph', content: [{ type: 'text', text: 'Mass ', styles: {} }, ...formulas, { type: 'text', text: ' here', styles: {} }] },
      { type: 'paragraph', content: 'After' },
    ]);

    echoAll(h);

    expect(shape(h)[1]).toBe(written);
  });

  it('keeps words reading $$x$$ as words, not a formula', () => {
    const h = openBlocks([
      { type: 'paragraph', content: 'Before' },
      { type: 'paragraph', content: 'Cost $$x$$ total' },
      { type: 'paragraph', content: 'After' },
    ]);

    echoAll(h);

    expect(shape(h)).toEqual(['paragraph|Before|', 'paragraph|Cost $$x$$ total|', 'paragraph|After|']);
  });
});
