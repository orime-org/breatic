// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Where one thread's highlight actually is (#18, A4).
 *
 * The library keeps a position table, and a thread with more than one mark is
 * merged there into a single span from its first start to its last end
 * (`threadPositions`). That answers "roughly where is this comment", which is
 * enough to hang a floating card off, and it is wrong for "which words is this
 * comment about" — an Enter inside a commented run splits the mark in two, and
 * everything typed into the gap afterwards falls inside the merged span
 * without carrying the mark.
 *
 * So this walks the marks. `orphan` is not read: this answers where a thread's
 * marks are, which is a different question from whether a reader may press
 * them (`document-comment-hit.ts`). A settled thread still shows the words it
 * was about.
 *
 * TDD: red because the module does not exist yet.
 */

import { type Mark, type Node as PMNode, type Schema } from '@tiptap/pm/model';
import { describe, it, expect } from 'vitest';
import * as Y from 'yjs';

import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';
import {
  threadQuoteIn,
  threadRangesIn,
} from '@web/spaces/document/document-comment-ranges';

/**
 * The ProseMirror schema this build assembles.
 * @returns The schema, off a throwaway document.
 */
function schemaNow(): Schema {
  const probe = new Y.Doc();
  return buildDocumentEditor({ fragment: probe.getXmlFragment('probe') })
    .pmSchema as unknown as Schema;
}

const schema = schemaNow();

/** A comment mark for the named thread. */
const comment = (threadId: string, orphan = false): Mark =>
  schema.marks.comment.create({ threadId, orphan });

/** One paragraph block holding the runs given. */
function block(
  ...runs: readonly { text: string; marks?: readonly Mark[] }[]
): PMNode {
  return schema.nodes.blockContainer.create(null, [
    schema.nodes.paragraph.create(
      null,
      runs.map((run) => schema.text(run.text, run.marks as Mark[] | null)),
    ),
  ]);
}

describe('threadRangesIn', () => {
  it('names the one stretch a single mark covers', () => {
    const doc = schema.nodes.doc.create(null, [
      block({ text: 'commented', marks: [comment('t1')] }),
    ]);
    const found = threadRangesIn(doc, 't1');
    expect(found).toHaveLength(1);
    expect(doc.textBetween(found[0]!.from, found[0]!.to)).toBe('commented');
  });

  it('names each stretch separately once an Enter has split the comment', () => {
    const doc = schema.nodes.doc.create(null, [
      block({ text: 'first half', marks: [comment('t1')] }),
      block({ text: 'typed in between' }),
      block({ text: 'second half', marks: [comment('t1')] }),
    ]);
    expect(threadRangesIn(doc, 't1')).toHaveLength(2);
  });

  it('names nothing for a thread whose words are gone', () => {
    const doc = schema.nodes.doc.create(null, [block({ text: 'plain' })]);
    expect(threadRangesIn(doc, 't1')).toEqual([]);
  });

  it('names the marks of a settled thread, which still show their words', () => {
    const doc = schema.nodes.doc.create(null, [
      block({ text: 'settled', marks: [comment('t1', true)] }),
    ]);
    expect(threadRangesIn(doc, 't1')).toHaveLength(1);
  });

  it('names only the thread asked for', () => {
    const doc = schema.nodes.doc.create(null, [
      block(
        { text: 'mine', marks: [comment('t1')] },
        { text: 'theirs', marks: [comment('t2')] },
      ),
    ]);
    const found = threadRangesIn(doc, 't2');
    expect(found).toHaveLength(1);
    expect(doc.textBetween(found[0]!.from, found[0]!.to)).toBe('theirs');
  });
});

describe('threadQuoteIn', () => {
  it('reads the words a comment is about', () => {
    const doc = schema.nodes.doc.create(null, [
      block(
        { text: 'before ' },
        { text: 'commented', marks: [comment('t1')] },
        { text: ' after' },
      ),
    ]);
    expect(threadQuoteIn(doc, 't1')).toBe('commented');
  });

  it('leaves out what was typed into the gap of a split comment', () => {
    // The merged position table would read all three blocks here, so the card
    // would quote a line nobody commented on.
    const doc = schema.nodes.doc.create(null, [
      block({ text: 'first half', marks: [comment('t1')] }),
      block({ text: 'typed in between' }),
      block({ text: 'second half', marks: [comment('t1')] }),
    ]);
    expect(threadQuoteIn(doc, 't1')).toBe('first half second half');
  });

  it('answers nothing once the words are gone', () => {
    const doc = schema.nodes.doc.create(null, [block({ text: 'plain' })]);
    expect(threadQuoteIn(doc, 't1')).toBeNull();
  });
});
