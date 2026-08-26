// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Holding on to one link while co-editors change the document around it.
 *
 * The panel acts on the link it was opened over, and it has to still mean that
 * link a minute later. Two mechanisms cannot answer this:
 *
 * A transaction's own mapping cannot, because a remote update does not arrive
 * as the edit the peer made. Measured: a peer inserting two characters lands
 * as ONE `ReplaceStep` spanning the whole document (`from: 0, to: 21`), and
 * `mapping.map` sends every position in the old document to the end of the new
 * one — both ends of a link at 4..12 came back as 23.
 *
 * Re-reading the selection cannot either, because it answers "which link does
 * this selection hold" rather than "where did MY link go". Those differ the
 * moment a second link exists inside the selection: a peer linking a word
 * earlier in the same sentence takes over the answer, and a confirm then writes
 * the user's address onto the peer's word.
 *
 * Yjs relative positions do answer it. They are how the sync plugin restores a
 * selection after a remote update, and they survive edits on either side
 * because they name a place in the shared structure rather than an offset.
 */

import type { Editor } from '@tiptap/core';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import type * as Y from 'yjs';
import {
  absolutePositionToRelativePosition,
  relativePositionToAbsolutePosition,
  ySyncPluginKey,
} from '@tiptap/y-tiptap';

/**
 * The binding's index from Yjs types to the nodes it produced.
 *
 * Restated here because `@tiptap/y-tiptap` declares `ProsemirrorMapping` in an
 * inner module its entry point does not re-export, while the two functions
 * below take it by that name.
 */
type ProsemirrorMapping = Map<
  Y.AbstractType<unknown>,
  ProseMirrorNode | ProseMirrorNode[]
>;

/**
 * The link a panel holds, in a form co-editors cannot invalidate.
 *
 * Both ends, so the span survives an edit that lands inside the link as well as
 * one before it. What sits between them is read back from the document, so a
 * link whose text a peer extended is still the same link.
 */
export interface TrackedLink {
  start: Y.RelativePosition;
  end: Y.RelativePosition;
}

/**
 * What the sync plugin keeps, in the shape this module reads.
 *
 * Declared here rather than imported: `@tiptap/y-tiptap` types the plugin
 * state loosely, and the two fields below are all that is needed. The same
 * narrowing is done in `collab-editor/collab-caret-refresh.ts`.
 */
interface SyncPluginState {
  type?: Y.XmlFragment;
  binding?: { mapping: ProsemirrorMapping };
  doc?: Y.Doc;
}

/**
 * Read the collaboration binding, when there is one.
 * @param editor - The editor to read from.
 * @returns The three things a position conversion needs, or null when this
 *   editor is not bound to a shared document.
 */
function binding(editor: Editor): {
  doc: Y.Doc;
  type: Y.XmlFragment;
  mapping: ProsemirrorMapping;
} | null {
  const state = ySyncPluginKey.getState(editor.state) as SyncPluginState | undefined;
  if (!state?.type || !state.binding || !state.doc) return null;
  return { doc: state.doc, type: state.type, mapping: state.binding.mapping };
}

/**
 * Take hold of the link now occupying the given span.
 * @param editor - The editor the span belongs to.
 * @param span - Where the link is at this moment.
 * @param span.from - Its start.
 * @param span.to - Its end.
 * @returns A handle that follows the link, or null with no shared document to
 *   track against — an editor built without collaboration, which the unit
 *   suites for other document behaviour use.
 * @throws {never}
 */
export function trackLink(
  editor: Editor,
  span: { from: number; to: number },
): TrackedLink | null {
  const bound = binding(editor);
  if (!bound) return null;
  return {
    start: absolutePositionToRelativePosition(
      span.from,
      bound.type,
      bound.mapping,
    ) as Y.RelativePosition,
    end: absolutePositionToRelativePosition(
      span.to,
      bound.type,
      bound.mapping,
    ) as Y.RelativePosition,
  };
}

/**
 * Where the tracked link sits in the document as it is now.
 *
 * The span comes back first and the link is then read out of it, so a link the
 * peer lengthened is reported at its new extent. A null span means the text it
 * covered is gone.
 *
 * The two ends meeting is one way for that to read: a peer deleting the whole
 * link leaves both positions at the deletion point. Measured, the caller does
 * not need telling — a zero-width span holds no link either, so it reaches the
 * same answer through `resolveLinkInSpan`. What the comparison is here for is
 * the reversed case, which would hand `nodesBetween` a backwards range.
 * @param editor - The editor to resolve against.
 * @param tracked - The handle from {@link trackLink}.
 * @returns The span the link now occupies, or null when it has gone.
 * @throws {never}
 */
export function resolveTrackedSpan(
  editor: Editor,
  tracked: TrackedLink,
): { from: number; to: number } | null {
  const bound = binding(editor);
  if (!bound) return null;
  const from = relativePositionToAbsolutePosition(
    bound.doc,
    bound.type,
    tracked.start,
    bound.mapping,
  );
  const to = relativePositionToAbsolutePosition(
    bound.doc,
    bound.type,
    tracked.end,
    bound.mapping,
  );
  if (from === null || to === null || to <= from) return null;
  return { from, to };
}
