// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Pressing a highlight names every thread under it (#18, A20).
 *
 * Two comments may overlap — `excludes: ""` on the mark is what allows it —
 * and the library's own click handler cannot reach the second one: it takes
 * `node.marks.find(...)`, the first match, and selects that single thread
 * (`comments/extension.ts:261-263`). So the reader pressing a doubly
 * commented run would silently get one of the two, with no way to tell which
 * or to reach the other.
 *
 * The design settles on naming all of them and letting the reader pick, which
 * is what three implementations do (ProseMirror's own `commentsAt` returns a
 * list, Lexical activates every id, CKEditor's `activeAnnotations` is a set);
 * no vendor's help pages answer the question at all.
 *
 * `orphan` is read, as the library's own handler reads it: what a reader can
 * press is what is drawn for them. That attribute is true for a thread that
 * is resolved, withdrawn or gone (`extension.ts:138-142`), and the stylesheet
 * paints no colour for such a mark — so those words look like any others and
 * the press belongs to whoever else wants it.
 *
 * TDD: red because `threadsAtPosition` does not exist yet.
 */

import { type Mark, type Node as PMNode, type Schema } from '@tiptap/pm/model';
import { describe, it, expect } from 'vitest';
import * as Y from 'yjs';

import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';
import { threadsAtPosition } from '@web/spaces/document/document-comment-hit';

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
const comment = (threadId: string): Mark =>
  schema.marks.comment.create({ threadId, orphan: false });

/**
 * A document of one paragraph holding the runs given.
 * @param runs - Each run's text and the marks on it.
 * @returns The document.
 */
function docOf(
  ...runs: readonly { text: string; marks?: readonly Mark[] }[]
): PMNode {
  return schema.nodes.doc.create(null, [
    schema.nodes.blockContainer.create(null, [
      schema.nodes.paragraph.create(
        null,
        runs.map((run) => schema.text(run.text, run.marks as Mark[] | null)),
      ),
    ]),
  ]);
}

/**
 * Where a run's text starts in the document.
 * @param doc - The document to look in.
 * @param text - The run's exact text.
 * @returns That run's start position.
 * @throws {Error} When no run carries that text.
 */
function startOf(doc: PMNode, text: string): number {
  let at: number | undefined;
  doc.descendants((node, pos) => {
    if (node.isText && node.text === text && at === undefined) at = pos;
    return true;
  });
  if (at === undefined) throw new Error(`no run reads ${text}`);
  return at;
}

describe('threadsAtPosition', () => {
  it('names the one thread under a single highlight', () => {
    const doc = docOf({ text: 'commented', marks: [comment('t1')] });
    expect(threadsAtPosition(doc, startOf(doc, 'commented'))).toEqual(['t1']);
  });

  it('names both threads where two highlights overlap', () => {
    const doc = docOf({ text: 'shared', marks: [comment('t1'), comment('t2')] });
    expect([...threadsAtPosition(doc, startOf(doc, 'shared'))].sort()).toEqual([
      't1',
      't2',
    ]);
  });

  it('names nothing under plain text', () => {
    const doc = docOf({ text: 'plain' });
    expect(threadsAtPosition(doc, startOf(doc, 'plain'))).toEqual([]);
  });

  it('names only the threads under the run pressed', () => {
    const doc = docOf(
      { text: 'first', marks: [comment('t1')] },
      { text: 'second', marks: [comment('t2')] },
    );
    expect(threadsAtPosition(doc, startOf(doc, 'second'))).toEqual(['t2']);
  });

  it('names nothing under a mark the stylesheet paints no colour for', () => {
    // `orphan` is the library's word for a mark whose thread is resolved,
    // withdrawn or gone (`extension.ts:138-142`), and `.bn-thread-mark[
    // data-orphan='true']` paints it transparent. Words with nothing drawn on
    // them read as any other words, so a press there belongs to whoever else
    // wants it — the link handler among them.
    const doc = docOf({
      text: 'resolved but here',
      marks: [schema.marks.comment.create({ threadId: 't1', orphan: true })],
    });
    expect(threadsAtPosition(doc, startOf(doc, 'resolved but here'))).toEqual(
      [],
    );
  });

  it('names only the painted one where a painted mark overlaps a settled one', () => {
    const doc = docOf({
      text: 'shared',
      marks: [
        schema.marks.comment.create({ threadId: 'settled', orphan: true }),
        comment('open'),
      ],
    });
    expect(threadsAtPosition(doc, startOf(doc, 'shared'))).toEqual(['open']);
  });

  it('ignores the other marks on the run pressed', () => {
    // Commented text is usually styled too, and a bold mark carries no
    // thread id — reading every mark on the run would name `undefined`.
    const doc = docOf({
      text: 'bold and commented',
      marks: [schema.marks.bold.create(null), comment('t1')],
    });
    expect(threadsAtPosition(doc, startOf(doc, 'bold and commented'))).toEqual([
      't1',
    ]);
  });

  it('names nothing for a position past the end of the document', () => {
    const doc = docOf({ text: 'commented', marks: [comment('t1')] });
    expect(threadsAtPosition(doc, doc.content.size + 10)).toEqual([]);
  });

  it('names nothing where the press landed on no node at all', () => {
    const doc = docOf({ text: 'commented', marks: [comment('t1')] });
    expect(threadsAtPosition(doc, -1)).toEqual([]);
  });
});
