// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * inner#1790 v2 web test spec 21.3a (round 6): the editor after an executor
 * write (design 5.3 line 220). The executor writes Yjs while holding the
 * binding's `mux`, so y-prosemirror (or y-tiptap) does not redraw the whole
 * document from Yjs; the executor then dispatches one transaction carrying the
 * sync plugin's meta that turns the editor into the document step 5
 * simulated, replacing only the blocks that changed.
 *
 * EQ-01: an editor rebuilt from the same Yjs shows what this editor shows.
 * EQ-02: exactly one sync-keyed transaction follows the write, and it leaves
 * a block outside the range alone (its DOM node is the same object and no
 * step of that transaction reaches it). The cases that delete every block
 * have no block outside the range and assert the count only.
 * EQ-03: a peer's update and a later keystroke still map correctly.
 * EQ-04: undo brings the content back and the two still agree.
 *
 * Where a case of sections 11 to 13 has every block in its range, a leading
 * paragraph `top` is added so EQ-02 has a block to watch; it changes nothing
 * the executor does to the rest.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Editor } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import { NodeSelection, TextSelection, type PluginKey, type Transaction } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';
import * as Y from 'yjs';

vi.mock('@web/lib/toast', () => ({
  toast: { warning: vi.fn(), error: vi.fn(), info: vi.fn(), success: vi.fn() },
}));

import { documentBodyFragment } from '@breatic/shared';
import { changeLocale } from '@web/i18n/locale-bootstrap';
import { REFERENCE_MENTION_NODE } from '@web/features/reference-mention/mention-node';
import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';
import { tableBlock } from '@web/spaces/document/__tests__/table-fixtures';
import {
  CANVAS_NAME,
  CHIP_A,
  DOCUMENT_NAME,
  capture,
  caretIntoEmpty,
  chipParagraph,
  clearToasts,
  deleteBetween,
  enterState,
  expectBodyInStep,
  expectTiptapInStep,
  expectWarnings,
  flush,
  fragmentOf,
  nodesOf,
  openBody,
  openTiptap,
  pBlock as p,
  paragraphs,
  posOf,
  press,
  remoteBodyParagraph,
  remoteTiptapEdit,
  resetHarness,
  rows,
  select,
  selectAllAndDelete,
  sideMenuDelete,
  tiptapExtensions,
  topBlockIds,
  typeText,
  type BlockInput,
  type OpenBody,
  type OpenTiptap,
  type TiptapKind,
} from '@web/features/collab-editor/__tests__/helpers/space-editor-harness';

const IMAGE: BlockInput = { type: 'image', props: { url: 'https://cdn.example/a.png', name: 'a' } };

/**
 * The document an editor rebuilt from a copy of the Yjs document shows.
 * @param doc - The Space document.
 * @returns The rebuilt body's ProseMirror document, as JSON.
 */
function rebuiltBody(doc: Y.Doc): unknown {
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
function rebuiltTiptap(doc: Y.Doc, kind: TiptapKind): unknown {
  const fresh = new Y.Doc();
  Y.applyUpdate(fresh, Y.encodeStateAsUpdate(doc));
  const editor = new Editor({ element: document.createElement('div'), extensions: tiptapExtensions(kind, fragmentOf(fresh, kind)) });
  const json = editor.state.doc.toJSON() as unknown;
  editor.destroy();
  fresh.destroy();
  return json;
}

/** What the view dispatched with the sync key's meta and a document change. */
interface SyncRecorder {
  readonly transactions: Transaction[];
  stop: () => void;
}

/**
 * Records the document-changing transactions carrying a sync key's meta.
 * @param view - The view.
 * @param key - The editor's sync plugin key.
 * @returns The recorder.
 */
function recordSync(view: EditorView, key: PluginKey): SyncRecorder {
  const transactions: Transaction[] = [];
  const own = view.dispatch.bind(view);
  view.dispatch = (tr: Transaction): void => {
    if (tr.docChanged && tr.getMeta(key) !== undefined) transactions.push(tr);
    own(tr);
  };
  return {
    transactions,
    stop: () => {
      view.dispatch = own;
    },
  };
}

/** The first block of an editor, watched by EQ-02. */
interface Watched {
  readonly dom: Node | null;
  /** The end of the block in the document before the write. */
  readonly end: number;
}

/**
 * The first top-level block's DOM node and end.
 * @param view - The view.
 * @param pos - The block's position (1 in the body, inside its block group; 0 in a TipTap editor).
 * @returns The watched block.
 */
function watch(view: EditorView, pos: number): Watched {
  return { dom: view.nodeDOM(pos), end: pos + view.state.doc.nodeAt(pos)!.nodeSize };
}

/**
 * EQ-02: one sync-keyed transaction, and the watched block untouched by it.
 * @param view - The view.
 * @param recorder - The recorder started before the write.
 * @param watched - The watched block, or null when every block was in the range.
 * @param pos - The watched block's position.
 */
function expectOnlyChangedBlocksReplaced(view: EditorView, recorder: SyncRecorder, watched: Watched | null, pos: number): void {
  expect(recorder.transactions).toHaveLength(1);
  if (watched === null) return;
  for (const step of recorder.transactions[0].steps) {
    step.getMap().forEach((oldStart) => {
      expect(oldStart).toBeGreaterThanOrEqual(watched.end);
    });
  }
  expect(view.nodeDOM(pos)).toBe(watched.dom);
}

/** One executor case on the body. */
interface BodyCase {
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
function deleteHardBreak(body: OpenBody): void {
  const at = nodesOf(body.view.state.doc, 'hardBreak')[0];
  body.view.dispatch(body.view.state.tr.setSelection(NodeSelection.create(body.view.state.doc, at)));
  press(body.view, 'Backspace');
}

/**
 * Backspace with the caret in the first empty paragraph.
 * @param body - The open body.
 */
function backspaceInEmpty(body: OpenBody): void {
  caretIntoEmpty(body.view, 'paragraph');
  press(body.view, 'Backspace');
}

const BODY_CASES: readonly BodyCase[] = [
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
];

/** The position of the body's first block container. */
const BODY_FIRST = 1;

/**
 * Opens the body, runs the case's preparation and its write, and records around the write.
 * @param entry - The case.
 * @returns The body, the recorder and the watched block.
 */
async function runBody(entry: BodyCase): Promise<{ body: OpenBody; recorder: SyncRecorder; watched: Watched | null }> {
  const body = openBody(entry.blocks);
  enterState(DOCUMENT_NAME, entry.code);
  if (entry.prep !== undefined) await entry.prep(body);
  const watched = entry.keepFirst ? watch(body.view, BODY_FIRST) : null;
  const cap = capture(body.doc);
  entry.op(body);
  const recorder = recordSync(body.view, body.syncKey);
  await flush();
  recorder.stop();
  // The executor took it.
  expect(cap.updates).toHaveLength(1);
  cap.stop();
  return { body, recorder, watched };
}

/**
 * EQ-01 on the body.
 * @param body - The open body.
 */
function expectBodyMatchesRebuilt(body: OpenBody): void {
  expect(rebuiltBody(body.doc)).toEqual(body.view.state.doc.toJSON());
  expectBodyInStep(body);
}

/** One executor case on a canvas TipTap editor. */
interface TiptapCase {
  readonly id: string;
  readonly kind: TiptapKind;
  readonly content: Record<string, unknown>;
  readonly prep?: (open: OpenTiptap) => Promise<void>;
  readonly op: (open: OpenTiptap) => void;
  readonly keepFirst: boolean;
}

const TOP_THEN_CHIP: Record<string, unknown> = {
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
function deleteChip(open: OpenTiptap): void {
  const at = nodesOf(open.view.state.doc, REFERENCE_MENTION_NODE)[0];
  open.view.dispatch(open.view.state.tr.setSelection(NodeSelection.create(open.view.state.doc, at)));
  press(open.view, 'Backspace');
}

const TIPTAP_CASES: readonly TiptapCase[] = [
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
 * Opens the TipTap editor, runs the case and records around the write.
 * @param entry - The case.
 * @returns The editor, the recorder and the watched block.
 */
async function runTiptap(entry: TiptapCase): Promise<{ open: OpenTiptap; recorder: SyncRecorder; watched: Watched | null }> {
  const open = openTiptap(entry.kind, entry.content);
  enterState(CANVAS_NAME, 'F');
  if (entry.prep !== undefined) await entry.prep(open);
  const watched = entry.keepFirst ? watch(open.view, 0) : null;
  const cap = capture(open.doc);
  entry.op(open);
  const recorder = recordSync(open.view, open.syncKey);
  await flush();
  recorder.stop();
  expect(cap.updates).toHaveLength(1);
  cap.stop();
  return { open, recorder, watched };
}

/**
 * EQ-01 on a TipTap editor.
 * @param open - The open editor.
 */
function expectTiptapMatchesRebuilt(open: OpenTiptap): void {
  expect(rebuiltTiptap(open.doc, open.kind)).toEqual(open.view.state.doc.toJSON());
  expectTiptapInStep(open);
}

/**
 * Puts the caret at the start of the document's first text position and types.
 * @param view - The view.
 * @param text - What is typed.
 */
function typeAtStart(view: EditorView, text: string): void {
  view.dispatch(view.state.tr.setSelection(TextSelection.atStart(view.state.doc)));
  typeText(view, text);
}

/**
 * The text of every text block, for comparing contents across a round trip.
 * @param doc - The document.
 * @returns The texts in order.
 */
function texts(doc: PMNode): string[] {
  const out: string[] = [];
  doc.descendants((node) => {
    if (node.isTextblock) out.push(node.textContent);
    return true;
  });
  return out;
}

beforeEach(() => {
  changeLocale('en');
  clearToasts();
});

afterEach(() => {
  resetHarness();
});

describe('21.3a the editor after an executor write, document body', () => {
  it.each(BODY_CASES.map((entry) => [entry.id, entry] as const))('EQ-01: %s, an editor rebuilt from the same Yjs shows the same document', async (_id, entry) => {
    const { body } = await runBody(entry);
    expectBodyMatchesRebuilt(body);
    expectWarnings();
  });

  it.each(BODY_CASES.map((entry) => [entry.id, entry] as const))('EQ-02: %s, one sync-keyed transaction replaces only the blocks that changed', async (_id, entry) => {
    const { body, recorder, watched } = await runBody(entry);
    expectOnlyChangedBlocksReplaced(body.view, recorder, watched, BODY_FIRST);
  });

  it.each(BODY_CASES.map((entry) => [entry.id, entry] as const))('EQ-03: %s, then a peer\'s paragraph and a keystroke in warning still map onto Yjs', async (_id, entry) => {
    const { body } = await runBody(entry);
    remoteBodyParagraph(body.doc, 'peer');
    await flush();
    expect(texts(body.view.state.doc)).toContain('peer');
    enterState(DOCUMENT_NAME, 'W');
    const cap = capture(body.doc);
    typeAtStart(body.view, 'x');
    await flush();
    expect(cap.updates).toHaveLength(1);
    expect(cap.shape()).toBe('S');
    expect(texts(body.view.state.doc).some((text) => text.startsWith('x'))).toBe(true);
    expectBodyMatchesRebuilt(body);
  });

  it.each(BODY_CASES.filter((entry) => ['X-07', 'K-01', 'X-06'].includes(entry.id)).map((entry) => [entry.id, entry] as const))(
    'EQ-04: %s, warning and one undo bring the blocks back with their ids, still matching Yjs',
    async (_id, entry) => {
      const body = openBody(entry.blocks);
      const before = rows(body.view.state.doc);
      const ids = topBlockIds(body.editor);
      enterState(DOCUMENT_NAME, entry.code);
      entry.op(body);
      await flush();
      expect(rows(body.view.state.doc)).not.toEqual(before);
      enterState(DOCUMENT_NAME, 'W');
      body.editor.undo();
      await flush();
      expect(rows(body.view.state.doc)).toEqual(before);
      expect(topBlockIds(body.editor)).toEqual(ids);
      expectBodyMatchesRebuilt(body);
    },
  );
});

describe('21.3a the editor after an executor write, canvas TipTap editors', () => {
  it.each(TIPTAP_CASES.map((entry) => [entry.id, entry] as const))('EQ-01: %s, an editor rebuilt from the same Yjs shows the same document', async (_id, entry) => {
    const { open } = await runTiptap(entry);
    expectTiptapMatchesRebuilt(open);
    expectWarnings();
  });

  it.each(TIPTAP_CASES.map((entry) => [entry.id, entry] as const))('EQ-02: %s, one sync-keyed transaction replaces only the blocks that changed', async (_id, entry) => {
    const { open, recorder, watched } = await runTiptap(entry);
    expectOnlyChangedBlocksReplaced(open.view, recorder, watched, 0);
  });

  it.each(TIPTAP_CASES.map((entry) => [entry.id, entry] as const))('EQ-03: %s, then a peer\'s paragraph and a keystroke in warning still map onto Yjs', async (_id, entry) => {
    const { open } = await runTiptap(entry);
    remoteTiptapEdit(open, (peer) => {
      peer.commands.insertContentAt(peer.state.doc.content.size, { type: 'paragraph', content: [{ type: 'text', text: 'peer' }] });
    });
    await flush();
    expect(texts(open.view.state.doc)).toContain('peer');
    enterState(CANVAS_NAME, 'W');
    const cap = capture(open.doc);
    typeAtStart(open.view, 'x');
    await flush();
    expect(cap.updates).toHaveLength(1);
    expect(cap.shape()).toBe('S');
    expect(texts(open.view.state.doc).some((text) => text.startsWith('x'))).toBe(true);
    expectTiptapMatchesRebuilt(open);
  });
});
