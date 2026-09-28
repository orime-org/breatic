// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What arrives with pasted and dragged content (#18, A19 · A19.1).
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
 */

import { Fragment, Slice, type Schema } from '@tiptap/pm/model';
import { describe, it, expect } from 'vitest';
import * as Y from 'yjs';

import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';
import {
  commentsArrivingWith,
  commentPastePlugin,
  stripCommentMarks,
} from '@web/spaces/document/document-comment-paste';

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

describe('commentsArrivingWith', () => {
  /** A slice of one commented run, the shape every case below starts from. */
  const commented = (text: string): Slice =>
    new Slice(
      Fragment.from(
        schema.nodes.paragraph.create(null, [schema.text(text, [comment('t1')])]),
      ),
      0,
      0,
    );

  /** A view that has a drag in flight, or none. */
  const viewThatIs = (
    dragging: object | null,
  ): Parameters<typeof commentsArrivingWith>[1] =>
    ({ state: { schema }, dragging }) as never;

  it('takes the comment off content that was pasted', () => {
    const landed = commentsArrivingWith(
      commented('commented'),
      viewThatIs(null),
      false,
    );

    expect(threadIdsIn(landed.content)).toEqual([]);
  });

  it('takes it off content that was dragged as a copy', () => {
    // Holding the modifier turns a drag into a copy, and a copy is a copy
    // however it was made.
    const landed = commentsArrivingWith(
      commented('commented'),
      viewThatIs({}),
      true,
    );

    expect(threadIdsIn(landed.content)).toEqual([]);
  });

  it('keeps it on content that was dragged to a new place', () => {
    // The words are the same words, in a new position: what was said about
    // them still applies (user 2026-09-23).
    const landed = commentsArrivingWith(
      commented('commented'),
      viewThatIs({}),
      false,
    );

    expect(threadIdsIn(landed.content)).toEqual(['t1']);
  });

  it('keeps it on the part that was dragged, however small that part is', () => {
    // Half of a commented run, dragged away: it carries the comment, and the
    // half left behind keeps its own marks because nothing touched them. One
    // thread, highlighted in two places — the same shape an Enter through a
    // comment already leaves (measured 2026-09-23).
    const landed = commentsArrivingWith(
      commented('half'),
      viewThatIs({}),
      false,
    );

    expect(threadIdsIn(landed.content)).toEqual(['t1']);
    expect(landed.content.child(0).textContent).toBe('half');
  });

  it('strips a paste even when the last drop was a copy', () => {
    // The flag outlives the drop that set it — it is written on every drop
    // and never reset, and the editor holding it lives as long as the tab —
    // so the question a paste asks is whether a drag is in flight at all.
    const landed = commentsArrivingWith(
      commented('commented'),
      viewThatIs(null),
      true,
    );

    expect(threadIdsIn(landed.content)).toEqual([]);
  });
});

describe('the drop the plugin reads the modifier from', () => {
  /** A slice of one commented run. */
  const commented = (): Slice =>
    new Slice(
      Fragment.from(
        schema.nodes.paragraph.create(null, [schema.text('run', [comment('t1')])]),
      ),
      0,
      0,
    );

  /**
   * Drops with the copy modifier as the argument says, then lands a slice.
   * @param copying - Whether the modifier was down at the drop.
   * @returns The thread ids that survived.
   */
  const landAfterDrop = (copying: boolean): readonly string[] => {
    const props = commentPastePlugin().props as unknown as {
      handleDOMEvents: {
        drop: (view: unknown, event: MouseEvent) => boolean;
      };
      transformPasted: (slice: Slice, view: unknown) => Slice;
    };
    // ProseMirror reads `altKey` on a Mac and `ctrlKey` elsewhere; the test
    // sets both so it says the same thing on either.
    props.handleDOMEvents.drop(null, {
      altKey: copying,
      ctrlKey: copying,
    } as MouseEvent);
    const view = { state: { schema }, dragging: {} };
    return threadIdsIn(props.transformPasted(commented(), view).content);
  };

  it('keeps the comment when the modifier was up at the drop', () => {
    expect(landAfterDrop(false)).toEqual(['t1']);
  });

  it('takes it off when the modifier was down at the drop', () => {
    // ProseMirror decides whether to delete the source by reading the DROP
    // event (`prosemirror-view/dist/index.js:3850`), five lines after it
    // hands the slice to `transformPasted` — so pressing the modifier mid-
    // drag makes a copy, and the snapshot taken at dragstart still says move.
    expect(landAfterDrop(true)).toEqual([]);
  });

  /**
   * Drops a whole row with the copy modifier as the argument says.
   * @param copying - Whether the modifier was down at the drop.
   * @returns The id the landed row carries.
   */
  const rowIdAfterDrop = (copying: boolean): unknown => {
    const props = commentPastePlugin().props as unknown as {
      handleDOMEvents: {
        drop: (view: unknown, event: MouseEvent) => boolean;
      };
      transformPasted: (slice: Slice, view: unknown) => Slice;
    };
    props.handleDOMEvents.drop(null, {
      altKey: copying,
      ctrlKey: copying,
    } as MouseEvent);
    const row = new Slice(
      Fragment.from(
        schema.nodes.blockContainer.create({ id: 'row-1' }, [
          schema.nodes.paragraph.create(null, [schema.text('run')]),
        ]),
      ),
      0,
      0,
    );
    const view = { state: { schema }, dragging: {} };
    return props.transformPasted(row, view).content.child(0).attrs['id'];
  };

  it('takes the row ids off rows dragged as a copy, so the editor gives them new ones', () => {
    // BlockNote only renews ids when the drop reports `effectAllowed ===
    // "copy"`, and ProseMirror sets `"copyMove"` on every drag it starts,
    // so a copied row would otherwise share its source's id.
    expect(rowIdAfterDrop(true)).toBeNull();
  });

  it('keeps the row ids on rows dragged to a new place', () => {
    expect(rowIdAfterDrop(false)).toBe('row-1');
  });
});
