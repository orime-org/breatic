// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * inner#1790 v2 web test spec 23.8: the binding's mapping after an executor
 * write (design 5.3 step 8). The executor writes Yjs inside the binding's
 * `mux`, so the sync plugin does not rebuild the mapping; every type the write
 * deleted must leave it, it must not grow with repeated writes, and the text
 * blocks the write left must still map onto their `XmlText`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Node as PMNode } from '@tiptap/pm/model';
import type { PluginKey } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';
import * as Y from 'yjs';

vi.mock('@web/lib/toast', () => ({
  toast: { warning: vi.fn(), error: vi.fn(), info: vi.fn(), success: vi.fn() },
}));

import { changeLocale } from '@web/i18n/locale-bootstrap';
import { SPACE_DELETE_META } from '@web/features/collab-editor/space-delete-executor';
import {
  BODY_CASES,
  TIPTAP_CASES,
  expectBodyMatchesRebuilt,
  expectTiptapMatchesRebuilt,
  type BodyCase,
  type TiptapCase,
} from '@web/features/collab-editor/__tests__/helpers/executor-cases';
import {
  CANVAS_NAME,
  DOCUMENT_NAME,
  backspaceChar,
  capture,
  clearToasts,
  enterState,
  flush,
  openBody,
  openTiptap,
  pBlock as p,
  resetHarness,
  rows,
  select,
  sideMenuDelete,
  typeText,
} from '@web/features/collab-editor/__tests__/helpers/space-editor-harness';

/** An editor after an executor write. */
interface Written {
  readonly view: EditorView;
  readonly doc: Y.Doc;
  readonly name: string;
  readonly syncKey: PluginKey;
  /** EQ-01: an editor rebuilt from the same Yjs shows this editor's document. */
  readonly matchesRebuilt: () => void;
  /** The types the executor's Yjs write deleted. */
  readonly deleted: Array<Y.AbstractType<unknown>>;
  /** How many executor writes ran. */
  readonly writes: () => number;
}

/**
 * Collects the types every executor write deletes (its transaction carries `SPACE_DELETE_META`).
 * @param doc - The Space document.
 * @returns The types, and the number of writes.
 */
function collectDeleted(doc: Y.Doc): { deleted: Array<Y.AbstractType<unknown>>; writes: () => number } {
  const deleted: Array<Y.AbstractType<unknown>> = [];
  let writes = 0;
  doc.on('afterTransaction', (tr: Y.Transaction) => {
    if (tr.meta.get(SPACE_DELETE_META) !== true) return;
    writes += 1;
    Y.iterateDeletedStructs(tr, tr.deleteSet, (struct) => {
      if (struct instanceof Y.Item && struct.content instanceof Y.ContentType) deleted.push(struct.content.type);
    });
  });
  return { deleted, writes: () => writes };
}

/**
 * Runs a body case in its state.
 * @param entry - The case.
 * @returns The editor after the write.
 */
async function runBody(entry: BodyCase): Promise<Written> {
  const body = openBody(entry.blocks);
  enterState(DOCUMENT_NAME, entry.code);
  if (entry.prep !== undefined) await entry.prep(body);
  const collected = collectDeleted(body.doc);
  entry.op(body);
  await flush();
  return { view: body.view, doc: body.doc, name: DOCUMENT_NAME, syncKey: body.syncKey, matchesRebuilt: () => { expectBodyMatchesRebuilt(body); }, ...collected };
}

/**
 * Runs a TipTap case in `F`.
 * @param entry - The case.
 * @returns The editor after the write.
 */
async function runTiptap(entry: TiptapCase): Promise<Written> {
  const open = openTiptap(entry.kind, entry.content);
  enterState(CANVAS_NAME, 'F');
  if (entry.prep !== undefined) await entry.prep(open);
  const collected = collectDeleted(open.doc);
  entry.op(open);
  await flush();
  return { view: open.view, doc: open.doc, name: CANVAS_NAME, syncKey: open.syncKey, matchesRebuilt: () => { expectTiptapMatchesRebuilt(open); }, ...collected };
}

/**
 * The binding's mapping.
 * @param view - The view.
 * @param key - The editor's sync plugin key.
 * @returns The mapping from Y types to nodes.
 */
function mappingOf(view: EditorView, key: PluginKey): Map<unknown, unknown> {
  return (key.getState(view.state) as { binding: { mapping: Map<unknown, unknown> } }).binding.mapping;
}

/**
 * The cases with the given ids.
 * @param ids - Case ids.
 * @returns Body and TipTap cases, as one list of runners.
 */
function casesOf(ids: readonly string[]): Array<readonly [string, () => Promise<Written>]> {
  return [
    ...BODY_CASES.filter((entry) => ids.includes(entry.id)).map((entry) => [entry.id, (): Promise<Written> => runBody(entry)] as const),
    ...TIPTAP_CASES.filter((entry) => ids.includes(entry.id)).map((entry) => [entry.id, (): Promise<Written> => runTiptap(entry)] as const),
  ];
}

/**
 * The positions of every text block.
 * @param doc - The document.
 * @returns Their positions, in order.
 */
function textblocks(doc: PMNode): number[] {
  const out: number[] = [];
  doc.descendants((node, pos) => {
    if (node.isTextblock) out.push(pos);
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

describe('23.8 the binding mapping after an executor write', () => {
  it.each(casesOf(['X-03', 'X-04', 'X-07', 'X-09', 'X-10', 'X-17', 'X-06', 'X-21', 'X-24', 'K-01', 'K-03', 'XT-02', 'XT-03']))(
    'W7-39: %s in F, no type the write deleted is left in the binding mapping',
    async (_id, run) => {
      const written = await run();
      expect(written.writes()).toBe(1);
      const mapping = mappingOf(written.view, written.syncKey);
      for (const type of written.deleted) expect(mapping.has(type)).toBe(false);
    },
  );

  it('W7-40: fifty rounds of inserting a block with a child in W and deleting it from the side menu in F leave no deleted type in the mapping', async () => {
    const body = openBody([p('top')]);
    for (let round = 0; round < 50; round += 1) {
      enterState(DOCUMENT_NAME, 'W');
      const last = body.editor.document.at(-1)!;
      body.editor.insertBlocks([p(`blk${round}`, [p(`kid${round}`)])] as never, last, 'after');
      await flush();
      enterState(DOCUMENT_NAME, 'F');
      sideMenuDelete(body, 1);
      await flush();
      expect(rows(body.view.state.doc)).toEqual([['paragraph', 'top']]);
    }
    const stale = [...mappingOf(body.view, body.syncKey).keys()].filter((key) => key instanceof Y.AbstractType && key._item?.deleted === true);
    expect(stale).toHaveLength(0);
  });

  it.each(casesOf(['X-07', 'X-09', 'X-13', 'X-14', 'X-17', 'XT-04']))(
    'W7-41: after %s in F, then W, typing x and Backspace at the start, middle and end of every text block left writes one update each and stays in step',
    async (_id, run) => {
      const written = await run();
      expect(written.writes()).toBe(1);
      enterState(written.name, 'W');
      const { view } = written;
      const withText = textblocks(view.state.doc)
        .map((pos, index) => ({ index, size: view.state.doc.nodeAt(pos)!.content.size }))
        .filter((entry) => entry.size > 0)
        .map((entry) => entry.index);
      expect(withText.length).toBeGreaterThan(0);
      for (const index of withText) {
        for (const where of ['start', 'middle', 'end'] as const) {
          const pos = textblocks(view.state.doc)[index];
          const size = view.state.doc.nodeAt(pos)!.content.size;
          const caret = pos + 1 + (where === 'start' ? 0 : where === 'middle' ? Math.floor(size / 2) : size);
          select(view, caret);
          let cap = capture(written.doc);
          typeText(view, 'x');
          await flush();
          cap.stop();
          expect(cap.updates).toHaveLength(1);
          written.matchesRebuilt();
          select(view, caret + 1);
          cap = capture(written.doc);
          backspaceChar(view);
          await flush();
          cap.stop();
          expect(cap.updates).toHaveLength(1);
          written.matchesRebuilt();
        }
      }
    },
  );
});
