// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The comment mark on the real schema (#18, design §7).
 *
 * Four spec values carry four acceptance items, and each one is a value the
 * library set rather than one we chose — so they are read off the schema this
 * build assembles, not off the library's source. `excludes: ""` is what lets
 * two comments overlap (A20); without it the newer one replaces the older
 * over the shared run and one thread becomes unreachable from the body.
 *
 * TDD: red because the mark is not registered yet.
 */

import { describe, it, expect } from 'vitest';
import * as Y from 'yjs';

import { CommentMark } from '@blocknote/core/comments';

import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';

/**
 * The ProseMirror schema this build assembles.
 * @returns The schema, off a throwaway document.
 */
function schemaNow(): ReturnType<typeof buildDocumentEditor>['pmSchema'] {
  const probe = new Y.Doc();
  return buildDocumentEditor({ fragment: probe.getXmlFragment('probe') })
    .pmSchema;
}

describe('the comment mark', () => {
  it('is on the schema, carrying a thread id and an orphan flag', () => {
    const comment = schemaNow().marks.comment;

    expect(comment).toBeDefined();
    expect(Object.keys(comment.spec.attrs ?? {}).sort()).toEqual([
      'orphan',
      'threadId',
    ]);
  });

  it('excludes nothing, so two comments coexist over one run', () => {
    const comment = schemaNow().marks.comment;
    expect(comment.spec.excludes).toBe('');

    const first = comment.create({ threadId: 't1', orphan: false });
    const second = comment.create({ threadId: 't2', orphan: false });
    const both = second.addToSet(first.addToSet([]));

    expect(both).toHaveLength(2);
    expect(both.map((m) => m.attrs.threadId as string).sort()).toEqual([
      't1',
      't2',
    ]);
  });

  it('is not inclusive, so typing at the end of a comment stays outside it', () => {
    expect(schemaNow().marks.comment.spec.inclusive).toBe(false);
  });

  it('survives a split, so Enter inside a comment leaves both halves marked', () => {
    // Read off the tiptap extension rather than the ProseMirror schema:
    // `keepOnSplit` is tiptap's own config key and never reaches a MarkSpec.
    expect(CommentMark.config.keepOnSplit).toBe(true);
  });
});
