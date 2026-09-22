// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Pasted words arrive without their comments (#18, A19).
 *
 * The rule is the user's (2026-09-22): copying text copies the content, not
 * the discussion about it — the same answer Google Docs gives, in both
 * directions. It holds inside one document too, and there the reason is
 * mechanical: the library derives a thread's range by merging every mark that
 * carries its id into `min(from) → max(to)`
 * (`comments/extension.ts:28-57`). Leave the marks on a second copy and that
 * one thread now claims both copies and all the body between them.
 *
 * The slice is rebuilt rather than filtered in place: `Slice` and `Fragment`
 * are immutable, and `openStart` / `openEnd` have to survive untouched or the
 * paste lands as whole blocks where it should have joined a line.
 *
 * TDD: red because `stripCommentMarks` does not exist yet.
 */

import { Fragment, Slice, type Schema } from '@tiptap/pm/model';
import { describe, it, expect } from 'vitest';
import * as Y from 'yjs';

import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';
import { stripCommentMarks } from '@web/spaces/document/document-comment-paste';

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

/** Every thread id the marks in this fragment carry, depth first. */
function threadIdsIn(fragment: Fragment): string[] {
  const found: string[] = [];
  fragment.descendants((node) => {
    for (const mark of node.marks) {
      if (mark.type.name === 'comment') {
        found.push(mark.attrs.threadId as string);
      }
    }
    return true;
  });
  return found;
}

/** Every mark name in this fragment, depth first. */
function markNamesIn(fragment: Fragment): string[] {
  const found: string[] = [];
  fragment.descendants((node) => {
    for (const mark of node.marks) found.push(mark.type.name);
    return true;
  });
  return found;
}

/** A comment mark for the named thread. */
const comment = (threadId: string): ReturnType<Schema['mark']> =>
  schema.marks.comment.create({ threadId, orphan: false });

describe('stripCommentMarks', () => {
  it('takes the comment off pasted text', () => {
    const slice = new Slice(
      Fragment.from(
        schema.nodes.paragraph.create(null, [
          schema.text('commented', [comment('t1')]),
        ]),
      ),
      0,
      0,
    );

    expect(threadIdsIn(slice.content)).toEqual(['t1']);
    expect(threadIdsIn(stripCommentMarks(slice, schema).content)).toEqual([]);
  });

  it('leaves every other mark alone', () => {
    const slice = new Slice(
      Fragment.from(
        schema.nodes.paragraph.create(null, [
          schema.text('bold and commented', [
            schema.marks.bold.create(null),
            comment('t1'),
          ]),
        ]),
      ),
      0,
      0,
    );

    expect(markNamesIn(stripCommentMarks(slice, schema).content).sort()).toEqual(
      ['bold'],
    );
  });

  it('reaches text nested inside a block', () => {
    // The shape a whole-block copy actually has: a `blockContainer` wrapping
    // the content node, so the marks sit two levels down and a pass over the
    // slice's own children would miss them.
    const slice = new Slice(
      Fragment.from(
        schema.nodes.blockContainer.create(null, [
          schema.nodes.paragraph.create(null, [
            schema.text('in a block', [comment('t1')]),
          ]),
        ]),
      ),
      0,
      0,
    );

    expect(threadIdsIn(slice.content)).toEqual(['t1']);
    expect(threadIdsIn(stripCommentMarks(slice, schema).content)).toEqual([]);
  });

  it('takes off both marks where two comments overlap', () => {
    // `excludes: ""` lets them coexist, so a run can carry more than one and
    // dropping the first is not enough.
    const slice = new Slice(
      Fragment.from(
        schema.nodes.paragraph.create(null, [
          schema.text('shared', [comment('t1'), comment('t2')]),
        ]),
      ),
      0,
      0,
    );

    expect(threadIdsIn(slice.content).sort()).toEqual(['t1', 't2']);
    expect(threadIdsIn(stripCommentMarks(slice, schema).content)).toEqual([]);
  });

  it('keeps the open depths, so a mid-line paste still joins that line', () => {
    const slice = new Slice(
      Fragment.from(
        schema.nodes.paragraph.create(null, [
          schema.text('commented', [comment('t1')]),
        ]),
      ),
      1,
      1,
    );
    const stripped = stripCommentMarks(slice, schema);

    expect(stripped.openStart).toBe(1);
    expect(stripped.openEnd).toBe(1);
  });

  it('keeps the text and the block structure', () => {
    const slice = new Slice(
      Fragment.fromArray([
        schema.nodes.paragraph.create(null, [
          schema.text('first', [comment('t1')]),
        ]),
        schema.nodes.paragraph.create(null, [schema.text('second')]),
      ]),
      0,
      0,
    );
    const stripped = stripCommentMarks(slice, schema);

    expect(stripped.content.childCount).toBe(2);
    expect(stripped.content.child(0).textContent).toBe('first');
    expect(stripped.content.child(1).textContent).toBe('second');
  });
});
