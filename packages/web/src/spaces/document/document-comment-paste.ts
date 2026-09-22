// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Pasted words arrive without their comments (#18, A19).
 *
 * The rule is the user's (2026-09-22): copying text copies the content, not
 * the discussion about it. Google Docs answers the same way, in both
 * directions, and the library answers neither — nothing in it reads the
 * clipboard for comment marks, so a copied run would carry its `threadId`
 * into wherever it lands.
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
 * Both are answered by taking the mark off on the way in. ProseMirror hands a
 * pasted slice to `transformPasted` after parsing and before insertion, and a
 * drop arrives through the same door (`parseFromClipboard` is what the drop
 * handler calls), so one plugin covers pasting and dragging alike.
 */

import { createExtension } from '@blocknote/core';
import {
  Fragment,
  Slice,
  type Node as PMNode,
  type Schema,
} from '@tiptap/pm/model';
import { Plugin, PluginKey } from '@tiptap/pm/state';

/** The mark's name on the schema, as the library registers it. */
const COMMENT_MARK = 'comment';

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

/**
 * The extension that keeps comments out of pasted and dropped content.
 * @returns The extension, for the assembly to register.
 */
export const documentCommentPasteExtension = createExtension(() => ({
  key: 'document-comment-paste',
  prosemirrorPlugins: [
    new Plugin({
      key: new PluginKey('documentCommentPaste'),
      props: {
        /**
         * Takes the comment marks off content on its way into the body.
         * @param slice - The parsed clipboard or drop content.
         * @param view - The view it is landing in, for its schema.
         * @returns The same content without comment marks.
         */
        transformPasted: (slice, view): Slice =>
          stripCommentMarks(slice, view.state.schema),
      },
    }),
  ],
}));
