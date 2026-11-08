// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * inner#1790 v2 web test spec 21.4 and W7-34: how long the body takes on a
 * 10 MiB document (design 5.3 line 220, design 8 line 354). The fixture
 * `BIG(n)` is n paragraph blocks of about 460 characters each, built on
 * another document with `prosemirrorJSONToYXmlFragment` and loaded into the
 * mounted production body as a remote update; `BIG(16000)` encodes to about
 * 10.8 MiB, `BIG(4000)` to about 2.7 MiB.
 *
 * Each case measures the same operation first in warning, then full (or over
 * the ceiling) on the same document, and asserts a ratio, never an absolute
 * time. Mounting `BIG(16000)` takes about 20 s in jsdom, so every case has a
 * ten-minute timeout. Run this file on its own.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { prosemirrorJSONToYXmlFragment } from 'y-prosemirror';
import * as Y from 'yjs';

vi.mock('@web/features/collab-editor/space-delete-executor', async (importOriginal) => {
  const actual = await importOriginal<typeof Executor>();
  return { ...actual, planSpaceDelete: vi.fn(actual.planSpaceDelete) };
});
vi.mock('@web/lib/toast', () => ({
  toast: { warning: vi.fn(), error: vi.fn(), info: vi.fn(), success: vi.fn() },
}));

import { documentBodyFragment } from '@breatic/shared';
import { changeLocale } from '@web/i18n/locale-bootstrap';
import type * as Executor from '@web/features/collab-editor/space-delete-executor';
import { planSpaceDelete } from '@web/features/collab-editor/space-delete-executor';
import {
  COPY,
  DOCUMENT_NAME,
  backspaceChar,
  capture,
  caretIntoEmpty,
  clearToasts,
  enterState,
  expectBodyInStep,
  expectUntouched,
  expectWarnings,
  flush,
  mountBody,
  nodesOf,
  posOf,
  press,
  resetHarness,
  rows,
  select,
  selectAllAndDelete,
  type OpenBody,
} from '@web/features/collab-editor/__tests__/helpers/space-editor-harness';

const TEN_MINUTES = 600_000;

const LOREM = 'Lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. ';

/**
 * The text of block i of `BIG(n)`.
 * @param i - The block's index.
 * @returns Its text.
 */
function bigText(i: number): string {
  return `b${i} ${LOREM.repeat(4)}`;
}

/**
 * Mounts the body and loads `BIG(n)` into it as a remote update.
 * @param n - Blocks.
 * @param emptyAt - Indices before which an empty paragraph block is inserted.
 * @returns The open body.
 */
function openBig(n: number, emptyAt: readonly number[] = []): OpenBody {
  const body = mountBody();
  const schema = body.view.state.schema;
  const empties = new Set(emptyAt);
  const containers: unknown[] = [];
  for (let i = 0; i < n; i += 1) {
    if (empties.has(i)) containers.push({ type: 'blockContainer', attrs: { id: `e${i}` }, content: [{ type: 'paragraph' }] });
    containers.push({ type: 'blockContainer', attrs: { id: `b${i}` }, content: [{ type: 'paragraph', content: [{ type: 'text', text: bigText(i) }] }] });
  }
  const source = new Y.Doc();
  prosemirrorJSONToYXmlFragment(schema, { type: 'doc', content: [{ type: 'blockGroup', content: containers }] }, documentBodyFragment(source));
  Y.applyUpdate(body.doc, Y.encodeStateAsUpdate(source), 'remote');
  source.destroy();
  body.view.dom.focus();
  return body;
}

/**
 * Runs an operation and waits for the executor's microtask and any zero-delay timer.
 * @param op - The operation.
 * @returns Milliseconds from the operation to the flush.
 */
async function timed(op: () => void): Promise<number> {
  const start = performance.now();
  op();
  await flush();
  return performance.now() - start;
}

/**
 * The median.
 * @param values - Samples.
 * @returns Their median.
 */
function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * The position of a character of block i's text.
 * @param body - The open body.
 * @param i - The block.
 * @param offset - Characters into its text.
 * @returns The position.
 */
function charPos(body: OpenBody, i: number, offset: number): number {
  return posOf(body.view.state.doc, `b${i} Lorem`) + offset;
}

/**
 * The number of top-level blocks.
 * @param body - The open body.
 * @returns The count.
 */
function blockCount(body: OpenBody): number {
  return body.view.state.doc.firstChild!.childCount;
}

beforeEach(() => {
  changeLocale('en');
  clearToasts();
  vi.mocked(planSpaceDelete).mockClear();
});

afterEach(() => {
  resetHarness();
});

describe('21.4 timings on a 10 MiB body', () => {
  it('PF-01 / W7-34: BIG(16000), a one-character Backspace in the first block: full median at most 1.5 times warning, one pure delete and one plan each', async () => {
    const body = openBig(16000);
    enterState(DOCUMENT_NAME, 'W');
    const warning: number[] = [];
    for (const offset of [100, 90, 80, 70, 60]) {
      select(body.view, charPos(body, 0, offset));
      warning.push(await timed(() => { backspaceChar(body.view); }));
    }
    enterState(DOCUMENT_NAME, 'F');
    const full: number[] = [];
    for (const offset of [50, 40, 30, 20, 10]) {
      select(body.view, charPos(body, 0, offset));
      vi.mocked(planSpaceDelete).mockClear();
      const cap = capture(body.doc);
      full.push(await timed(() => { backspaceChar(body.view); }));
      expect(cap.updates).toHaveLength(1);
      expect(cap.shape()).toBe('D');
      expect(vi.mocked(planSpaceDelete)).toHaveBeenCalledTimes(1);
      cap.stop();
    }
    expectWarnings();
    expect(median(full)).toBeLessThanOrEqual(1.5 * median(warning));
  }, TEN_MINUTES);

  it('PF-02: BIG(16000), select all and Backspace: full at most 2 times warning; one update, R, the X-06 result', async () => {
    const body = openBig(16000);
    enterState(DOCUMENT_NAME, 'W');
    const warning = await timed(() => { selectAllAndDelete(body); });
    body.editor.undo();
    await flush();
    expect(blockCount(body)).toBe(16000);
    enterState(DOCUMENT_NAME, 'F');
    select(body.view, charPos(body, 0, 1));
    const cap = capture(body.doc);
    const full = await timed(() => { selectAllAndDelete(body); });
    expect(cap.updates).toHaveLength(1);
    expect(cap.shape()).toBe('R');
    expect(rows(body.view.state.doc)).toEqual([['paragraph', '']]);
    expectWarnings();
    expect(full).toBeLessThanOrEqual(2 * warning);
  }, TEN_MINUTES);

  it('PF-03: BIG(16000) over the ceiling, five one-character Backspaces: each refused with the over-ceiling toast, nothing written, no planning', async () => {
    const body = openBig(16000);
    enterState(DOCUMENT_NAME, 'O');
    for (const offset of [50, 40, 30, 20, 10]) {
      clearToasts();
      select(body.view, charPos(body, 0, offset));
      const cap = capture(body.doc);
      backspaceChar(body.view);
      await flush();
      expectUntouched(body.doc, cap);
      expectWarnings(COPY.T_OVER);
      cap.stop();
    }
    expect(vi.mocked(planSpaceDelete)).toHaveBeenCalledTimes(0);
  }, TEN_MINUTES);

  it('PF-04: the executor\'s own work for a full select-all delete grows at most 8 times from BIG(4000) to BIG(16000)', async () => {
    /**
     * Times the executor's planning and Yjs write for a full select-all
     * delete on BIG(n). The editor's DOM update is left out: jsdom rebuilds a
     * parent's live childNodes list on every removal, which makes removing
     * many blocks quadratic there and not in a browser (the warning path, which
     * never reaches the executor, grows the same way).
     * @param n - Blocks.
     * @returns Milliseconds.
     */
    const { planSpaceDelete: actualPlan } = await vi.importActual<typeof Executor>('@web/features/collab-editor/space-delete-executor');
    const measure = async (n: number): Promise<number> => {
      const body = openBig(n);
      enterState(DOCUMENT_NAME, 'F');
      select(body.view, charPos(body, 0, 1));
      let planMs = 0;
      vi.mocked(planSpaceDelete).mockImplementation((...args) => {
        const start = performance.now();
        const plan = actualPlan(...args);
        planMs += performance.now() - start;
        return plan;
      });
      let writeStart = 0;
      let writeMs = 0;
      const onBefore = (tr: Y.Transaction): void => { if (tr.local) writeStart = performance.now(); };
      const onAfter = (tr: Y.Transaction): void => { if (tr.local) writeMs += performance.now() - writeStart; };
      body.doc.on('beforeTransaction', onBefore);
      body.doc.on('afterTransaction', onAfter);
      const cap = capture(body.doc);
      await timed(() => { selectAllAndDelete(body); });
      body.doc.off('beforeTransaction', onBefore);
      body.doc.off('afterTransaction', onAfter);
      vi.mocked(planSpaceDelete).mockImplementation(actualPlan);
      expect(cap.updates).toHaveLength(1);
      expect(cap.shape()).toBe('R');
      cap.stop();
      resetHarness();
      return planMs + writeMs;
    };
    const small = await measure(4000);
    const large = await measure(16000);
    expect(large).toBeLessThanOrEqual(8 * small);
  }, TEN_MINUTES);

  it('PF-05: BIG(16000) with 20 empty blocks, Backspace in an empty block: full median at most 1.5 times warning; the block goes whole (R)', async () => {
    const empties = Array.from({ length: 20 }, (_, k) => 100 + k * 790);
    const body = openBig(16000, empties);
    enterState(DOCUMENT_NAME, 'W');
    const warning: number[] = [];
    for (let k = 0; k < 3; k += 1) {
      caretIntoEmpty(body.view, 'paragraph', 0);
      warning.push(await timed(() => { press(body.view, 'Backspace'); }));
    }
    enterState(DOCUMENT_NAME, 'F');
    const full: number[] = [];
    for (let k = 0; k < 3; k += 1) {
      caretIntoEmpty(body.view, 'paragraph', 0);
      const count = blockCount(body);
      const cap = capture(body.doc);
      full.push(await timed(() => { press(body.view, 'Backspace'); }));
      expect(cap.updates).toHaveLength(1);
      expect(cap.shape()).toBe('R');
      expect(blockCount(body)).toBe(count - 1);
      cap.stop();
    }
    expectBodyInStep(body);
    expectWarnings();
    expect(median(full)).toBeLessThanOrEqual(1.5 * median(warning));
  }, TEN_MINUTES);

  it('PF-06: BIG(16000), a selection from the 6th character of block i to the 6th of block i+1 deleted: full median at most 1.5 times warning; no merge, one pure delete', async () => {
    const body = openBig(16000);
    enterState(DOCUMENT_NAME, 'W');
    const warning: number[] = [];
    for (const i of [1000, 3000, 5000]) {
      const from = charPos(body, i, 6);
      const to = charPos(body, i + 1, 6);
      warning.push(await timed(() => { select(body.view, from, to); press(body.view, 'Backspace'); }));
    }
    enterState(DOCUMENT_NAME, 'F');
    const full: number[] = [];
    for (const i of [8000, 10000, 12000]) {
      const keep = charPos(body, i, 0);
      const from = keep + 6;
      const to = charPos(body, i + 1, 6);
      const count = blockCount(body);
      const cap = capture(body.doc);
      full.push(await timed(() => { select(body.view, from, to); press(body.view, 'Backspace'); }));
      expect(cap.updates).toHaveLength(1);
      expect(cap.shape()).toBe('D');
      expect(blockCount(body)).toBe(count);
      // Block i keeps its first 6 characters and was not merged with block i+1.
      expect(body.view.state.doc.nodeAt(keep - 1)?.textContent).toBe(bigText(i).slice(0, 6));
      cap.stop();
    }
    expect(nodesOf(body.view.state.doc, 'blockContainer')).toHaveLength(16000 - 3);
    expectBodyInStep(body);
    expectWarnings();
    expect(median(full)).toBeLessThanOrEqual(1.5 * median(warning));
  }, TEN_MINUTES);
});
