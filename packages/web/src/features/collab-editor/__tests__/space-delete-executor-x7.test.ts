// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * inner#1790 v2 web test spec 23.6: while full, a deletion inside one
 * `XmlText` goes to the delete executor (design 5.3 state table, `full`
 * row), including next to a mark boundary with the same character on both
 * sides, where a diff of the text alone cannot tell which character went.
 * Every case follows template `X7` (`helpers/marked-paragraph.ts`).
 *
 * The document body is the production one, its paragraph loaded as a remote
 * update. The canvas text node body and prompt have no marks in their
 * schema, so W7-32 runs the same characters unmarked there.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fc from 'fast-check';

vi.mock('@web/lib/toast', () => ({
  toast: { warning: vi.fn(), error: vi.fn(), info: vi.fn(), success: vi.fn() },
}));
vi.mock('@web/features/collab-editor/space-delete-executor', async (importOriginal) => {
  const actual = await importOriginal<typeof Executor>();
  return { ...actual, planSpaceDelete: vi.fn(actual.planSpaceDelete) };
});

import { documentCommentThreads } from '@breatic/shared';
import { changeLocale } from '@web/i18n/locale-bootstrap';
import type * as Executor from '@web/features/collab-editor/space-delete-executor';
import {
  bodySubject,
  expectX7,
  openMarked,
  tiptapSubject,
  type How,
  type MarkName,
  type Run,
} from '@web/features/collab-editor/__tests__/helpers/marked-paragraph';
import {
  CANVAS_NAME,
  DOCUMENT_NAME,
  clearToasts,
  enterState,
  openTiptap,
  paragraphs,
  resetHarness,
  type TiptapKind,
} from '@web/features/collab-editor/__tests__/helpers/space-editor-harness';

/**
 * Opens the body with the runs, enters `F` and runs template `X7`.
 * @param runs - The paragraph.
 * @param from - Start offset of the deletion.
 * @param to - End offset.
 * @param how - How it is deleted.
 * @returns Resolves when the template has been checked.
 */
async function bodyX7(runs: readonly Run[], from: number, to: number, how: How): Promise<void> {
  const { body } = await openMarked(runs);
  enterState(DOCUMENT_NAME, 'F');
  await expectX7(bodySubject(body), from, to, how);
}

beforeEach(() => {
  changeLocale('en');
  clearToasts();
});

afterEach(() => {
  resetHarness();
});

const XA_AB: readonly Run[] = [{ text: 'xa' }, { text: 'ab', marks: ['bold'] }];
const WORD_BOLD: readonly Run[] = [{ text: 'word ' }, { text: ' bold', marks: ['bold'] }];

describe('23.6 a deletion inside one XmlText goes to the executor while full', () => {
  it.each([
    { how: 'backspace' as const, where: 'Backspace after it' },
    { how: 'delete' as const, where: 'Delete before it' },
  ])('W7-27: [p xa + bold ab], the plain a next to the bold a, $where: X7, x + bold ab', async ({ how }) => {
    await bodyX7(XA_AB, 1, 2, how);
  });

  it.each([
    { how: 'backspace' as const, where: 'Backspace after it' },
    { how: 'delete' as const, where: 'Delete before it' },
  ])('W7-28: [p xa + bold ab], the first bold a, $where: X7, xa + bold b', async ({ how }) => {
    await bodyX7(XA_AB, 2, 3, how);
  });

  it.each([
    { which: 'the plain space', from: 4 },
    { which: 'the bold space', from: 5 },
  ])('W7-29: [p word␠ + bold ␠bold], deleting $which: X7', async ({ from }) => {
    await bodyX7(WORD_BOLD, from, from + 1, 'backspace');
  });

  it('W7-30: [p aa + bold aa], a range across the mark boundary (a|a): X7, a + bold a', async () => {
    await bodyX7([{ text: 'aa' }, { text: 'aa', marks: ['bold'] }], 1, 3, 'range');
  });

  it.each([
    { which: 'the italic a', from: 1 },
    { which: 'the link a', from: 2 },
    { which: 'the commented a', from: 3 },
  ])('W7-31: [p a + italic a + link a + commented a (t1)], deleting $which: X7, thread t1 untouched', async ({ from }) => {
    const { body, threadId } = await openMarked([{ text: 'a' }, { text: 'a', marks: ['italic'] }, { text: 'a', marks: ['link'] }, { text: 'a', marks: ['comment'] }]);
    enterState(DOCUMENT_NAME, 'F');
    const threads = documentCommentThreads(body.doc);
    const before = JSON.stringify(threads.toJSON());
    await expectX7(bodySubject(body), from, from + 1, 'backspace');
    expect(JSON.stringify(threads.toJSON())).toBe(before);
    expect(threads.has(threadId!)).toBe(true);
  });

  it.each((['textBody', 'prompt'] as const).flatMap((kind: TiptapKind) => [
    { kind, text: 'xaab', from: 1, how: 'backspace' as const, what: 'W7-27 Backspace' },
    { kind, text: 'xaab', from: 1, how: 'delete' as const, what: 'W7-27 Delete' },
    { kind, text: 'word  bold', from: 4, how: 'backspace' as const, what: 'W7-29 the first space' },
    { kind, text: 'word  bold', from: 5, how: 'backspace' as const, what: 'W7-29 the second space' },
  ]))('W7-32: canvas $kind, $what: X7', async ({ kind, text, from, how }) => {
    const open = openTiptap(kind, paragraphs(text));
    enterState(CANVAS_NAME, 'F');
    await expectX7(tiptapSubject(open, CANVAS_NAME), from, from + 1, how);
  });
});

/** A mark set a generated run carries. */
const marks = fc.subarray<MarkName>(['bold', 'italic', 'link', 'comment']);

/** One generated run: one to four characters of `a` and space. */
const run = fc.record({
  text: fc.array(fc.constantFrom('a', ' '), { minLength: 1, maxLength: 4 }).map((chars) => chars.join('')),
  marks,
});

/** A deletion inside a paragraph of `length` characters. */
type Deletion = { from: number; to: number; how: How };

/**
 * A deletion for a paragraph: one character by Backspace or Delete, or a range.
 * @param length - The paragraph's length.
 * @returns The arbitrary.
 */
function deletion(length: number): fc.Arbitrary<Deletion> {
  const one = fc.record({ at: fc.integer({ min: 0, max: length - 1 }), how: fc.constantFrom<How>('backspace', 'delete') })
    .map(({ at, how }) => ({ from: at, to: at + 1, how }));
  const range = fc.tuple(fc.integer({ min: 0, max: length }), fc.integer({ min: 0, max: length }))
    .filter(([a, b]) => a !== b)
    .map(([a, b]) => ({ from: Math.min(a, b), to: Math.max(a, b), how: 'range' as const }));
  return fc.oneof(one, range);
}

describe('23.6 property', () => {
  it('W7-33: any paragraph of a and space runs under random marks, any one-character or range deletion in F follows X7', async () => {
    const cases = fc.array(run, { minLength: 1, maxLength: 8 })
      .chain((runs) => deletion(runs.reduce((n, r) => n + r.text.length, 0)).map((d) => ({ runs, d })));
    await fc.assert(fc.asyncProperty(cases, async ({ runs, d }) => {
      resetHarness();
      clearToasts();
      await bodyX7(runs, d.from, d.to, d.how);
    }), { numRuns: 300 });
  }, 600_000);
});
