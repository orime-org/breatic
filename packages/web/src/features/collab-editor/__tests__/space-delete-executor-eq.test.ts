// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * inner#1790 v2 web test spec 21.3a and 23.9: the editor after an executor
 * write (design 5.3 step 8). The executor writes Yjs while holding the
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
 * The cases are in `helpers/executor-cases.ts`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Node as PMNode } from '@tiptap/pm/model';
import { TextSelection, type PluginKey, type Transaction } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';

vi.mock('@web/lib/toast', () => ({
  toast: { warning: vi.fn(), error: vi.fn(), info: vi.fn(), success: vi.fn() },
}));
vi.mock('@web/features/collab-editor/space-delete-executor', async (importOriginal) => {
  const actual = await importOriginal<typeof Executor>();
  return { ...actual, planSpaceDelete: vi.fn(actual.planSpaceDelete) };
});

import { changeLocale } from '@web/i18n/locale-bootstrap';
import type * as Executor from '@web/features/collab-editor/space-delete-executor';
import { planSpaceDelete } from '@web/features/collab-editor/space-delete-executor';
import {
  BODY_CASES,
  TIPTAP_CASES,
  expectBodyMatchesRebuilt,
  expectTiptapMatchesRebuilt,
  type BodyCase,
  type TiptapCase,
} from '@web/features/collab-editor/__tests__/helpers/executor-cases';
import { P6, at, deleteOffsets, openMarked, type How } from '@web/features/collab-editor/__tests__/helpers/marked-paragraph';
import {
  CANVAS_NAME,
  DOCUMENT_NAME,
  backspaceChar,
  capture,
  clearToasts,
  deleteBetween,
  enterState,
  expectWarnings,
  flush,
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
  topBlockIds,
  typeText,
  type OpenBody,
  type OpenTiptap,
} from '@web/features/collab-editor/__tests__/helpers/space-editor-harness';

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

  it.each(BODY_CASES.filter((entry) => ['X-07', 'K-01', 'X-06', 'X-01', 'X-02', 'X-11', 'X-19', 'X-20'].includes(entry.id)).map((entry) => [entry.id, entry] as const))(
    'EQ-04: %s, warning and one undo bring the blocks back with their ids, still matching Yjs',
    async (_id, entry) => {
      const body = openBody(entry.blocks);
      const before = rows(body.view.state.doc);
      const ids = topBlockIds(body.editor);
      enterState(DOCUMENT_NAME, entry.code);
      if (entry.prep !== undefined) await entry.prep(body);
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

/** EQ-01 cases on the body that only EQ-01 adds (spec 23.9). */
const EQ01_BODY_CASES: readonly BodyCase[] = [
  { id: 'X-08 (F)', blocks: [p('Hello'), p('World')], code: 'F', op: (body) => { deleteBetween(body, ['World', 0], ['World', 5]); }, keepFirst: true },
];

/** EQ-01 cases on the TipTap editors that only EQ-01 adds (spec 23.9). */
const EQ01_TIPTAP_CASES: readonly TiptapCase[] = [
  {
    id: 'XT-01', kind: 'textBody', content: paragraphs('hello world'),
    op: (open) => { const start = posOf(open.view.state.doc, 'hello', 3); select(open.view, start, start + 4); press(open.view, 'Backspace'); },
    keepFirst: true,
  },
  {
    id: 'XT-06', kind: 'prompt', content: paragraphs('hello world'),
    op: (open) => { select(open.view, posOf(open.view.state.doc, 'world', 5)); backspaceChar(open.view); },
    keepFirst: true,
  },
];

/** The PT cases EQ-01 adds, on `P6` (spec 21.3). */
const EQ01_PT_CASES: ReadonlyArray<{ id: string; from: number; to: number; how: How }> = [
  { id: 'PT-01', from: at('plain', 2), to: at('plain', 3), how: 'backspace' },
  { id: 'PT-02', from: at('boldword'), to: at('boldword', 1), how: 'backspace' },
  { id: 'PT-03', from: at('boldword', 7), to: at('boldword', 8), how: 'backspace' },
  { id: 'PT-04', from: at('boldword', 3), to: at('boldword', 4), how: 'backspace' },
  { id: 'PT-05', from: at('boldword', 8), to: at('boldword', 9), how: 'backspace' },
  { id: 'PT-06', from: at('italword', 7), to: at('italword', 8), how: 'backspace' },
  { id: 'PT-07', from: at('linkword'), to: at('linkword', 1), how: 'backspace' },
  { id: 'PT-08', from: at('linkword', 7), to: at('linkword', 8), how: 'backspace' },
  { id: 'PT-09', from: at('text', 2), to: at('middle', 2), how: 'range' },
  { id: 'PT-10', from: at('italword', 2), to: at('tail', 2), how: 'range' },
  { id: 'PT-11', from: at('commented', 2), to: at('commented', 3), how: 'backspace' },
  { id: 'PT-12', from: at('tail', 2), to: at('end', 1), how: 'range' },
  { id: 'PT-15', from: at('boldword', 3), to: at('boldword', 4), how: 'delete' },
];

describe('23.9 EQ-01 on the deletions inside one text block, now through the executor', () => {
  it.each(EQ01_BODY_CASES.map((entry) => [entry.id, entry] as const))('EQ-01: %s, an editor rebuilt from the same Yjs shows the same document', async (_id, entry) => {
    vi.mocked(planSpaceDelete).mockClear();
    const { body } = await runBody(entry);
    expect(vi.mocked(planSpaceDelete)).toHaveBeenCalledTimes(1);
    expectBodyMatchesRebuilt(body);
    expectWarnings();
  });

  it.each(EQ01_TIPTAP_CASES.map((entry) => [entry.id, entry] as const))('EQ-01: %s, an editor rebuilt from the same Yjs shows the same document', async (_id, entry) => {
    vi.mocked(planSpaceDelete).mockClear();
    const { open } = await runTiptap(entry);
    expect(vi.mocked(planSpaceDelete)).toHaveBeenCalledTimes(1);
    expectTiptapMatchesRebuilt(open);
    expectWarnings();
  });

  it.each(EQ01_PT_CASES.map((entry) => [entry.id, entry] as const))('EQ-01: %s on P6, an editor rebuilt from the same Yjs shows the same document', async (_id, { from, to, how }) => {
    const { body } = await openMarked(P6);
    enterState(DOCUMENT_NAME, 'F');
    vi.mocked(planSpaceDelete).mockClear();
    const cap = capture(body.doc);
    deleteOffsets(body.view, from, to, how);
    await flush();
    cap.stop();
    expect(vi.mocked(planSpaceDelete)).toHaveBeenCalledTimes(1);
    expect(cap.updates).toHaveLength(1);
    expectBodyMatchesRebuilt(body);
    expectWarnings();
  });
});
