// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * inner#1790 v2 web test spec 21.3a and 23.8: the executor cases the editor
 * checks after a write run on (EQ-01 to EQ-04, W7-39 to W7-41), and the
 * editor rebuilt from the same Yjs that EQ-01 compares against.
 *
 * Where a case has every block in its range, a leading paragraph `top` is
 * added so EQ-02 has a block outside the range to watch; it changes nothing
 * the executor does to the rest.
 */

import { Editor } from '@tiptap/core';
import { NodeSelection } from '@tiptap/pm/state';
import { expect } from 'vitest';
import * as Y from 'yjs';

import { documentBodyFragment } from '@breatic/shared';
import { REFERENCE_MENTION_NODE } from '@web/features/reference-mention/mention-node';
import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';
import { tableBlock } from '@web/spaces/document/__tests__/table-fixtures';
import {
  CHIP_A,
  caretIntoEmpty,
  chipParagraph,
  deleteBetween,
  expectBodyInStep,
  expectTiptapInStep,
  flush,
  fragmentOf,
  nodesOf,
  pBlock as p,
  paragraphs,
  posOf,
  press,
  select,
  selectAllAndDelete,
  sideMenuDelete,
  tiptapExtensions,
  type BlockInput,
  type OpenBody,
  type OpenTiptap,
  type TiptapKind,
} from '@web/features/collab-editor/__tests__/helpers/space-editor-harness';

export const IMAGE: BlockInput = { type: 'image', props: { url: 'https://cdn.example/a.png', name: 'a' } };

/**
 * The document an editor rebuilt from a copy of the Yjs document shows.
 * @param doc - The Space document.
 * @returns The rebuilt body's ProseMirror document, as JSON.
 */
export function rebuiltBody(doc: Y.Doc): unknown {
  const fresh = new Y.Doc();
  Y.applyUpdate(fresh, Y.encodeStateAsUpdate(doc));
  const editor = buildDocumentEditor({ fragment: documentBodyFragment(fresh) });
  editor.mount(document.createElement('div'));
  const json = editor.prosemirrorView.state.doc.toJSON() as unknown;
  editor.unmount();
  fresh.destroy();
  return json;
}

/**
 * The document a TipTap editor of the same kind rebuilt from a copy of the Yjs document shows.
 * @param doc - The canvas document.
 * @param kind - Which editor.
 * @returns The rebuilt editor's document, as JSON.
 */
export function rebuiltTiptap(doc: Y.Doc, kind: TiptapKind): unknown {
  const fresh = new Y.Doc();
  Y.applyUpdate(fresh, Y.encodeStateAsUpdate(doc));
  const editor = new Editor({ element: document.createElement('div'), extensions: tiptapExtensions(kind, fragmentOf(fresh, kind)) });
  const json = editor.state.doc.toJSON() as unknown;
  editor.destroy();
  fresh.destroy();
  return json;
}

/** One executor case on the body. */
export interface BodyCase {
  readonly id: string;
  readonly blocks: BlockInput[];
  readonly code: 'F' | 'O';
  /** Runs before the watched write (X-13: X-12 first). */
  readonly prep?: (body: OpenBody) => Promise<void>;
  readonly op: (body: OpenBody) => void;
  /** The first block is outside the range. */
  readonly keepFirst: boolean;
}

/**
 * Deletes the body's hard break with a node selection.
 * @param body - The open body.
 */
export function deleteHardBreak(body: OpenBody): void {
  const at = nodesOf(body.view.state.doc, 'hardBreak')[0];
  body.view.dispatch(body.view.state.tr.setSelection(NodeSelection.create(body.view.state.doc, at)));
  press(body.view, 'Backspace');
}

/**
 * Backspace with the caret in the first empty paragraph.
 * @param body - The open body.
 */
export function backspaceInEmpty(body: OpenBody): void {
  caretIntoEmpty(body.view, 'paragraph');
  press(body.view, 'Backspace');
}

export const BODY_CASES: readonly BodyCase[] = [
  { id: 'X-03', blocks: [p('top'), p('a'), p('b'), p('c')], code: 'F', op: (body) => { sideMenuDelete(body, 2); }, keepFirst: true },
  { id: 'X-04', blocks: [p('top'), p('a'), p('b', [p('b1')]), p('c')], code: 'F', op: (body) => { sideMenuDelete(body, 2); }, keepFirst: true },
  { id: 'X-07', blocks: [p('top'), p('Hello'), p('World')], code: 'F', op: (body) => { deleteBetween(body, ['Hello', 2], ['World', 2]); }, keepFirst: true },
  { id: 'X-09', blocks: [p('top'), p('Hello'), p('World')], code: 'F', op: (body) => { deleteBetween(body, ['Hello', 2], ['World', 5]); }, keepFirst: true },
  { id: 'X-10', blocks: [p('top'), p('Hello'), p('World')], code: 'F', op: (body) => { deleteBetween(body, ['Hello', 0], ['World', 2]); }, keepFirst: true },
  { id: 'X-12', blocks: [p('top'), p('ab\ncd')], code: 'F', op: deleteHardBreak, keepFirst: true },
  {
    id: 'X-13', blocks: [p('top'), p('ab\ncd')], code: 'F',
    prep: async (body) => { deleteHardBreak(body); await flush(); },
    op: (body) => { const start = posOf(body.view.state.doc, 'abcd', 1); select(body.view, start, start + 2); press(body.view, 'Backspace'); },
    keepFirst: true,
  },
  { id: 'X-14', blocks: [p('top'), p('abc', [p('def')])], code: 'F', op: (body) => { deleteBetween(body, ['abc', 1], ['def', 2]); }, keepFirst: true },
  { id: 'X-17', blocks: [p('top'), p('ab'), p('cd', [p('fgh')])], code: 'F', op: (body) => { deleteBetween(body, ['ab', 1], ['cd', 2]); }, keepFirst: true },
  { id: 'X-06', blocks: [p('one'), p('two'), p('three')], code: 'F', op: (body) => { selectAllAndDelete(body); }, keepFirst: false },
  { id: 'X-21', blocks: [IMAGE, p('x')], code: 'F', op: (body) => { selectAllAndDelete(body); }, keepFirst: false },
  { id: 'X-24', blocks: [tableBlock({ rows: [{ cells: ['a', 'b'] }, { cells: ['c', 'd'] }] })], code: 'F', op: (body) => { selectAllAndDelete(body); }, keepFirst: false },
  { id: 'K-01', blocks: [p('a'), p(''), p('b')], code: 'F', op: backspaceInEmpty, keepFirst: true },
  { id: 'K-03', blocks: [p('top'), p('a', [p('')])], code: 'F', op: backspaceInEmpty, keepFirst: true },
  { id: 'X-08 (O)', blocks: [p('Hello'), p('World')], code: 'O', op: (body) => { deleteBetween(body, ['World', 0], ['World', 5]); }, keepFirst: true },
  { id: 'X-01', blocks: [p('top'), p('Hello world')], code: 'F', op: (body) => { deleteBetween(body, ['Hello', 2], ['Hello', 5]); }, keepFirst: true },
  {
    id: 'X-02', blocks: [p('top'), p('Hello world')], code: 'F',
    prep: async (body) => { deleteBetween(body, ['Hello', 2], ['Hello', 5]); await flush(); },
    op: (body) => { deleteBetween(body, ['He world', 1], ['He world', 3]); },
    keepFirst: true,
  },
  {
    id: 'X-11',
    blocks: [p('top'), {
      type: 'paragraph',
      content: [
        { type: 'text', text: 'plain ', styles: {} },
        { type: 'text', text: 'bold', styles: { bold: true } },
        { type: 'text', text: ' tail', styles: {} },
      ],
    }],
    code: 'F', op: (body) => { deleteBetween(body, ['plain ', 3], ['bold', 2]); }, keepFirst: true,
  },
  { id: 'X-19', blocks: [p('top'), tableBlock({ rows: [{ cells: ['abc', 'def'] }] })], code: 'F', op: (body) => { deleteBetween(body, ['abc', 1], ['abc', 2]); }, keepFirst: true },
  { id: 'X-20', blocks: [p('top'), { type: 'codeBlock', content: 'const x' }], code: 'F', op: (body) => { deleteBetween(body, ['const x', 3], ['const x', 5]); }, keepFirst: true },
];

/**
 * EQ-01 on the body.
 * @param body - The open body.
 */
export function expectBodyMatchesRebuilt(body: OpenBody): void {
  expect(rebuiltBody(body.doc)).toEqual(body.view.state.doc.toJSON());
  expectBodyInStep(body);
}

/** One executor case on a canvas TipTap editor. */
export interface TiptapCase {
  readonly id: string;
  readonly kind: TiptapKind;
  readonly content: Record<string, unknown>;
  readonly prep?: (open: OpenTiptap) => Promise<void>;
  readonly op: (open: OpenTiptap) => void;
  readonly keepFirst: boolean;
}

export const TOP_THEN_CHIP: Record<string, unknown> = {
  type: 'doc',
  content: [
    { type: 'paragraph', content: [{ type: 'text', text: 'top' }] },
    ...(chipParagraph('ab ', CHIP_A, ' cd')['content'] as unknown[]),
  ],
};

/**
 * Selects the chip with a node selection and presses Backspace.
 * @param open - The open editor.
 */
export function deleteChip(open: OpenTiptap): void {
  const at = nodesOf(open.view.state.doc, REFERENCE_MENTION_NODE)[0];
  open.view.dispatch(open.view.state.tr.setSelection(NodeSelection.create(open.view.state.doc, at)));
  press(open.view, 'Backspace');
}

export const TIPTAP_CASES: readonly TiptapCase[] = [
  {
    id: 'XT-02', kind: 'textBody', content: paragraphs('a', 'b'),
    op: (open) => { press(open.view, 'a', { mod: true }); press(open.view, 'Backspace'); },
    keepFirst: false,
  },
  { id: 'XT-03', kind: 'prompt', content: TOP_THEN_CHIP, op: deleteChip, keepFirst: true },
  {
    id: 'XT-04', kind: 'prompt', content: TOP_THEN_CHIP,
    prep: async (open) => { deleteChip(open); await flush(); },
    op: (open) => { const start = posOf(open.view.state.doc, 'abcd', 1); select(open.view, start, start + 2); press(open.view, 'Backspace'); },
    keepFirst: true,
  },
];

/**
 * EQ-01 on a TipTap editor.
 * @param open - The open editor.
 */
export function expectTiptapMatchesRebuilt(open: OpenTiptap): void {
  expect(rebuiltTiptap(open.doc, open.kind)).toEqual(open.view.state.doc.toJSON());
  expectTiptapInStep(open);
}

