// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Content arriving into the body keeps its comments only when it was moved
 * here from inside the body (#18, A19 · A19.1).
 *
 * PASTED CONTENT ARRIVES WITHOUT ITS COMMENTS. The rule is the user's (2026-09-22,
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
 * `min(from) → max(to)` (its position table, `dist/comments.js`), so the
 * second copy
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
 * WHICH OF THE TWO THIS IS, `view.dragging` answers. A drop from inside the
 * body hands `transformPasted` the slice ProseMirror snapshotted at dragstart
 * (`prosemirror-view/dist/index.js:3843-3846`); a paste and a drop from
 * outside go through `parseFromClipboard` instead (`:2911`) with `dragging`
 * null. ProseMirror's maintainer deferred clearing it until after the drop is
 * handled for exactly this.
 *
 * WHETHER THE DRAG COPIES is read from the drop, not from that snapshot. The
 * snapshot carries `move`, answered at dragstart; ProseMirror asks the same
 * question a second time against the drop event before deleting the source
 * (`:3850`), five lines after handing over the slice. A modifier pressed or
 * released mid-drag moves the two apart, and the one that decides whether the
 * source survives is the second.
 *
 * ROWS DRAGGED AS A COPY ARRIVE WITHOUT THEIR IDS, so the editor gives them
 * new ones. BlockNote means to do this itself — "only create new ids for
 * dropped content while holding `alt`" (`UniqueID.ts`) — but it asks whether
 * the drop's `effectAllowed` is `"copy"`, and ProseMirror sets `"copyMove"`
 * on every drag it starts (`prosemirror-view/dist/index.js:3815`), so the
 * copied rows kept their source's ids. A row id names one row: moving rows,
 * and finding a comment's line again, look rows up by it.
 */

import { createExtension } from '@blocknote/core';
import { isMacOS } from '@tiptap/core';
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
  // Either registrar `commentWiring` picks puts the mark on the schema, so
  // this is only reached by a caller holding some other schema — and a paste
  // is a bad place to throw.
  if (commentType === undefined) return slice;

  /**
   * Rebuilds one fragment, dropping comment marks at every depth.
   * @param fragment - The fragment to rebuild.
   * @returns The fragment with no comment marks.
   */
  const rebuild = (fragment: Fragment): Fragment => {
    const out: PMNode[] = [];
    fragment.forEach((child) => {
      const inner = child.copy(rebuild(child.content));
      out.push(inner.mark(inner.marks.filter((m) => m.type !== commentType)));
    });
    return Fragment.fromArray(out);
  };

  return new Slice(rebuild(slice.content), slice.openStart, slice.openEnd);
}

/** What this needs of the view: the schema, and whether a drag is in flight. */
interface LandingView {
  /** The editor state, for the schema the slice was parsed against. */
  readonly state: { readonly schema: Schema };
  /** The drag in flight, or null for a paste and for a drop from outside. */
  readonly dragging: object | null;
}

/**
 * Rebuilds a slice with no row ids. The editor fills an id that is null with
 * a new one (BlockNote's `UniqueID`, `appendTransaction`).
 * @param slice - The slice about to be inserted.
 * @returns The same content and open depths, every row's id null.
 */
function withoutRowIds(slice: Slice): Slice {
  /**
   * Rebuilds one fragment, clearing ids at every depth.
   * @param fragment - The fragment to rebuild.
   * @returns The fragment with no ids.
   */
  const rebuild = (fragment: Fragment): Fragment => {
    const out: PMNode[] = [];
    fragment.forEach((child) => {
      if (child.isText) {
        out.push(child);
        return;
      }
      const attrs = 'id' in child.attrs ? { ...child.attrs, id: null } : child.attrs;
      out.push(child.type.create(attrs, rebuild(child.content), child.marks));
    });
    return Fragment.fromArray(out);
  };
  return new Slice(rebuild(slice.content), slice.openStart, slice.openEnd);
}

/**
 * The content as it should land. A drag moving content keeps it as it is; a
 * paste arrives without its comments; a drag that copies arrives without its
 * comments and without its row ids, which the editor then renews.
 * @param slice - The parsed clipboard or drop content.
 * @param view - The view it is landing in.
 * @param dropCopies - Whether the modifier was down at the drop that brought
 *   this content, which is what leaves the source in place.
 * @returns The content as it should land.
 */
export function landingSlice(
  slice: Slice,
  view: LandingView,
  dropCopies: boolean,
): Slice {
  if (view.dragging === null) {
    return stripCommentMarks(slice, view.state.schema);
  }
  if (!dropCopies) return slice;
  return withoutRowIds(stripCommentMarks(slice, view.state.schema));
}

/**
 * Whether this drop leaves the source where it is.
 *
 * The same key ProseMirror reads: `dragCopyModifier` is `altKey` on a Mac and
 * `ctrlKey` elsewhere (`prosemirror-view/dist/index.js:3783`).
 * @param event - The drop.
 * @returns True when the modifier turns this drag into a copy.
 */
function dropCopiesWith(event: MouseEvent): boolean {
  return isMacOS() ? event.altKey : event.ctrlKey;
}

/**
 * The plugin that decides whether comments, and the row ids of copied rows,
 * arrive with content.
 *
 * One per editor, because the flag it keeps is about the drop happening in
 * that editor right now.
 * @returns The plugin.
 */
export function commentPastePlugin(): Plugin {
  // Read at the drop rather than from `view.dragging.move`, which is the
  // answer to the same question asked at dragstart: ProseMirror asks it a
  // second time against the drop event before deleting the source
  // (`prosemirror-view/dist/index.js:3850`), five lines after it hands the
  // slice to `transformPasted`, so a modifier pressed or released mid-drag
  // changes what happens to the source and not the snapshot.
  let dropCopies = false;
  return new Plugin({
    key: new PluginKey('documentCommentPaste'),
    props: {
      handleDOMEvents: {
        /**
         * Takes down what the modifier said, and leaves the drop alone.
         *
         * `handleDOMEvents` runs ahead of the built-in drop handler: the
         * listener `initInput` puts on the editor's DOM calls
         * `runCustomHandler` first (`prosemirror-view/dist/index.js:3121-3124`),
         * so this lands before the slice reaches `transformPasted`.
         * @param _view - The view the drop was in.
         * @param event - The drop.
         * @returns False, so ProseMirror handles the drop as it would.
         */
        drop: (_view, event): boolean => {
          dropCopies = dropCopiesWith(event);
          return false;
        },
      },
      /**
       * Decides whether the comments, and the row ids, come with this
       * content.
       * @param slice - The parsed clipboard or drop content.
       * @param view - The view it is landing in.
       * @returns The content as it should land.
       */
      transformPasted: (slice, view): Slice =>
        landingSlice(slice, view, dropCopies),
    },
  });
}

/**
 * The extension that decides whether comments, and the row ids of copied rows,
 * arrive with content.
 * @returns The extension, for the assembly to register.
 */
export const documentCommentPasteExtension = createExtension(() => ({
  key: 'document-comment-paste',
  prosemirrorPlugins: [commentPastePlugin()],
}));
