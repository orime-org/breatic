// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Content arriving into the body keeps its comments only when it was moved
 * here from inside the body (#18, A19 · A19.1).
 *
 * PASTED CONTENT ARRIVES AS PLAIN TEXT. The rule is the user's (2026-09-22,
 * extended to cutting 2026-09-23): copying text copies the content, not the
 * discussion about it, and a cut is a copy with a delete behind it — the
 * words may never be pasted at all, may be pasted an hour later, may be
 * pasted into another document. Google Docs answers copying the same way, and
 * the library answers neither: nothing in it reads the clipboard for comment
 * marks, so a copied run would carry its `threadId` into wherever it lands.
 *
 * Landing in ANOTHER document is the obvious half: the id names a thread that
 * document has never heard of, so the mark points at nothing and paints a
 * highlight nobody can open.
 *
 * Landing in the SAME document is the half worth spelling out, because the
 * mark there names a thread that really does exist. The library derives a
 * thread's range by merging every mark carrying its id into one span,
 * `min(from) → max(to)` (`comments/extension.ts:28-57`), so the second copy
 * does not become a second highlight — it stretches the one thread across
 * both copies and every word between them.
 *
 * DRAGGED CONTENT KEEPS ITS COMMENTS, because a drag is one continuous act
 * the reader watches from start to finish: the same words, in a new place,
 * and what was said about them still applies (user 2026-09-23). Dragging away
 * part of a commented run leaves both halves carrying the comment — the half
 * that moved brings its marks along, the half left behind was never touched —
 * which is the shape the body already takes when an Enter splits a comment in
 * two (measured 2026-09-23).
 *
 * A drop reaches `transformPasted` through the same door a paste does
 * (`parseFromClipboard` is what the drop handler calls). `view.dragging` is
 * what tells them apart: ProseMirror's maintainer deferred clearing it until
 * after the drop is handled for exactly this, and it carries `move`, which is
 * false while the modifier turns the drag into a copy.
 */

import { createExtension } from '@blocknote/core';
import {
  Fragment,
  Slice,
  type Node as PMNode,
  type Schema,
} from '@tiptap/pm/model';
import { Plugin, PluginKey } from '@tiptap/pm/state';

import { COMMENT_MARK } from '@web/spaces/document/document-comment-extension';


/**
 * Rebuilds a pasted slice without any comment mark.
 *
 * `Slice` and `Fragment` are immutable, so this returns a new slice rather
 * than editing one. `openStart` and `openEnd` travel across untouched: they
 * say how much of the copied structure is open at each end, and a slice that
 * lost them pastes as whole blocks where it should have joined a line.
 * @param slice - The slice about to be inserted.
 * @param schema - The schema it was parsed against.
 * @returns The same content and open depths, with no comment marks left.
 */
export function stripCommentMarks(slice: Slice, schema: Schema): Slice {
  const commentType = schema.marks[COMMENT_MARK];
  // Registered unconditionally by `documentCommentMarkExtension`, so this is
  // only reached by a caller holding some other schema — and a paste is a
  // bad place to throw.
  if (commentType === undefined) return slice;

  /**
   * Rebuilds one fragment, dropping comment marks at every depth.
   * @param fragment - The fragment to rebuild.
   * @returns The fragment with no comment marks.
   */
  const rebuild = (fragment: Fragment): Fragment => {
    const out: PMNode[] = [];
    fragment.forEach((child) => {
      const inner =
        child.content.size > 0 ? child.copy(rebuild(child.content)) : child;
      out.push(inner.mark(inner.marks.filter((m) => m.type !== commentType)));
    });
    return Fragment.fromArray(out);
  };

  return new Slice(rebuild(slice.content), slice.openStart, slice.openEnd);
}

/** What this needs of the view: the schema, and what is being dragged. */
interface LandingView {
  /** The editor state, for the schema the slice was parsed against. */
  readonly state: { readonly schema: Schema };
  /** What is being dragged right now, and whether it is moving or copying. */
  readonly dragging: { readonly move: boolean } | null;
}

/**
 * The content as it should land, comments kept or taken off.
 * @param slice - The parsed clipboard or drop content.
 * @param view - The view it is landing in.
 * @returns The same content, with comment marks only where they belong.
 */
export function commentsArrivingWith(slice: Slice, view: LandingView): Slice {
  if (view.dragging?.move === true) return slice;
  return stripCommentMarks(slice, view.state.schema);
}

/**
 * The extension that decides whether comments arrive with content.
 * @returns The extension, for the assembly to register.
 */
export const documentCommentPasteExtension = createExtension(() => ({
  key: 'document-comment-paste',
  prosemirrorPlugins: [
    new Plugin({
      key: new PluginKey('documentCommentPaste'),
      props: {
        /**
         * Decides whether the comments come with this content.
         * @param slice - The parsed clipboard or drop content.
         * @param view - The view it is landing in.
         * @returns The content as it should land.
         */
        transformPasted: (slice, view): Slice =>
          commentsArrivingWith(slice, view),
      },
    }),
  ],
}));
