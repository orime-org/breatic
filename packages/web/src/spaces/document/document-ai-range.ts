// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The AI output dialog's original range (inner#1860, design §4.6, §5.4,
 * §6.3): the range captured when the dialog opened, followed while it stays
 * open through the same local-range carrying the unposted comment uses
 * (`document-local-range.ts`), in an instance of its own.
 *
 * The carrying holds one stretch from the first letter to the last, so what
 * the user types among the words is inside it. Once no letter is left the
 * range is gone, by the user's own edit or one that comes in through Yjs, and
 * gone stays gone, even when undo writes the words back: the comment draft's
 * rule.
 *
 * A range across blocks covers them whole (Plate `captureTextRange`). The
 * carried letters miss an image or an empty line at its edges, so the first
 * and the last block are held by id as well; what replace covers is worked
 * out from both (`aiCoverOf`), and so is what is painted.
 *
 * While the dialog is open the range keeps the body's selected look (design
 * §5.3): the user's own selection moves on, so the words wear the
 * `[data-show-selection]` stand-in the link panel's words wear (`index.css`),
 * and blocks without words the look `document-selection-paint.ts` gives them.
 *
 * Escape typed in the body closes the open dialog and leaves the keyboard in
 * the body (design §5.3): BlockNote's own Escape would blur the editor and
 * mark the key handled, so the dialog would never hear it. The suggestion
 * menu and the link toolbar answer Escape in the body too, and while one of
 * them is up the key is theirs.
 */

import { createExtension } from '@blocknote/core';
import { SuggestionMenu } from '@blocknote/core/extensions';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { Plugin, PluginKey, type EditorState } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';

import { documentBarsOf } from '@web/spaces/document/document-bars';
import { bodyHolds } from '@web/spaces/document/document-body-focus';
import {
  changesText,
  letterBounds,
  localRangeTracker,
  type IsLetter,
  type LocalRange,
} from '@web/spaces/document/document-local-range';
import { blockById } from '@web/spaces/document/document-proposal-landing';
import { noTextPaint } from '@web/spaces/document/document-selection-paint';

/** What the dialog opens the range on (§4.6). */
export interface AiCapture {
  /** The captured range: inside one block, its words; across blocks, the whole blocks. */
  readonly range: LocalRange;
  /** The first block of a range across blocks; null inside one block. */
  readonly firstId: string | null;
  /** The last block of a range across blocks; null inside one block. */
  readonly lastId: string | null;
}

/** The original range: on its words, or gone. */
export type AiRange =
  | {
      readonly kind: 'present';
      /** The one stretch of letters, as carried; a null here turns the range gone. */
      readonly slots: readonly (LocalRange | null)[];
      readonly firstId: string | null;
      readonly lastId: string | null;
      readonly entry: number;
    }
  | { readonly kind: 'gone' };

/** The range while it is on its words. */
type PresentRange = AiRange & { kind: 'present' };

/** What a caller dispatches under the key: a capture opens the range, `null` closes it. */
export type AiRangeCommand = AiCapture | null;

/** The plugin's key, which is also the meta an {@link AiRangeCommand} goes under. */
export const DOCUMENT_AI_RANGE = new PluginKey<AiRange | null>('documentAiRange');

/** How many times the range has been opened in this page. */
let entries = 0;

/**
 * A letter of the range: text, or an inline node such as a hard break.
 * @param node - A node.
 * @returns True for one.
 */
export const inlineLetter: IsLetter = (node) => node.isText || (node.isInline && node.isLeaf);

/**
 * The AI dialog's original range.
 * @param state - The editor state.
 * @returns The range, or null while no dialog holds one.
 */
export function aiRangeIn(state: EditorState): AiRange | null {
  return DOCUMENT_AI_RANGE.getState(state) ?? null;
}

/**
 * The range while it is on its words.
 * @param state - The editor state.
 * @returns It, or null when gone or not open.
 */
function presentIn(state: EditorState): PresentRange | null {
  const range = aiRangeIn(state);
  return range?.kind === 'present' ? range : null;
}

/** What a block is told apart by in the body: a block's container, or a table. */
export const BLOCK_GROUP = 'bnBlock';

/**
 * The position before the innermost block around a position.
 * @param doc - The body.
 * @param pos - The position.
 * @returns Where that block starts, or null outside any.
 */
export function containerAt(doc: ProseMirrorNode, pos: number): number | null {
  const $pos = doc.resolve(pos);
  for (let depth = $pos.depth; depth > 0; depth -= 1) {
    if ($pos.node(depth).type.isInGroup(BLOCK_GROUP)) return $pos.before(depth);
  }
  return null;
}

/**
 * Where a block's own content ends: a container's children left out, a
 * table whole.
 * @param doc - The body.
 * @param blockPos - Where the block starts.
 * @returns The position.
 */
export function ownContentEnd(doc: ProseMirrorNode, blockPos: number): number {
  const block = doc.nodeAt(blockPos)!;
  return block.type.name === 'blockContainer' ? blockPos + 1 + block.firstChild!.nodeSize : blockPos + block.nodeSize;
}

/**
 * What replace covers now (§5.4): inside one block, the carried words;
 * across blocks, from the first block's start to the end of the last
 * block's own content, children left out. A first or last block gone since
 * gives way to the block of the carried letter at that end, and so do both
 * once the first has come after the last.
 * @param doc - The body now.
 * @param letters - The carried letters, or null once gone.
 * @param firstId - The first block, or null inside one block.
 * @param lastId - The last block, or null inside one block.
 * @returns The range, or null once the letters are gone.
 */
export function aiCoverOf(doc: ProseMirrorNode, letters: LocalRange | null, firstId: string | null, lastId: string | null): LocalRange | null {
  if (letters === null) return null;
  if (firstId === null || lastId === null) return letters;
  // A letter always stands in a block.
  const byLetters = { first: containerAt(doc, letters.from)!, last: containerAt(doc, letters.to - 1)! };
  let first = blockById(doc, firstId)?.pos ?? byLetters.first;
  let last = blockById(doc, lastId)?.pos ?? byLetters.last;
  if (first > last) {
    first = byLetters.first;
    last = byLetters.last;
  }
  return { from: first, to: ownContentEnd(doc, last) };
}

/**
 * What replace covers now.
 * @param state - The editor state.
 * @returns The range, or null while no range is open or once it is gone.
 */
export function aiCoverIn(state: EditorState): LocalRange | null {
  const range = presentIn(state);
  return range === null ? null : aiCoverOf(state.doc, range.slots[0] ?? null, range.firstId, range.lastId);
}

/**
 * The selected look over the range, where the user's own selection does not
 * already draw it: while the body holds the focus its selection is painted
 * too, and the two translucent bands over the same words would draw them
 * darker than either.
 * @param state - The editor state.
 * @returns The stand-in decorations.
 */
function paintRange(state: EditorState): DecorationSet {
  const range = presentIn(state);
  const letters = range?.slots[0] ?? null;
  if (range === null || letters === null) return DecorationSet.empty;
  const cover = aiCoverOf(state.doc, letters, range.firstId, range.lastId)!;
  const { selection } = state;
  const drawn = bodyHolds(state) && !selection.empty ? selection : null;
  const parts = drawn === null
    ? [letters]
    : [{ from: letters.from, to: Math.min(letters.to, drawn.from) }, { from: Math.max(letters.from, drawn.to), to: letters.to }];
  return DecorationSet.create(state.doc, [
    ...parts.filter(({ from, to }) => to > from).map(({ from, to }) => Decoration.inline(from, to, { 'data-show-selection': 'true' })),
    ...noTextPaint(state.doc, cover),
  ]);
}

/** Who closes the open dialog when Escape is typed in a given editor's body. */
const escapeListeners = new WeakMap<object, Set<() => void>>();

/**
 * Hear Escape typed in this editor's body while its AI dialog is open.
 * @param editor - The document editor.
 * @param listener - Called once per such Escape.
 * @returns Stops hearing.
 */
export function onAiEscape(editor: object, listener: () => void): () => void {
  const listeners = escapeListeners.get(editor) ?? new Set<() => void>();
  escapeListeners.set(editor, listeners);
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * The extension that keeps the AI dialog's original range on its words.
 * @returns The extension, for the assembly to register.
 */
export const documentAiRange = createExtension(() => {
  const tracker = localRangeTracker(presentIn, inlineLetter);
  return {
    key: 'document-ai-range',
    keyboardShortcuts: {
      /**
       * Closes the open dialog; a suggestion menu or the link toolbar that
       * is up keeps the key, one press taking away one thing.
       * @param ctx - The shortcut's context.
       * @param ctx.editor - The editor the key was typed in.
       * @returns True when the key closed a dialog.
       */
      Escape: ({ editor }): boolean => {
        if (aiRangeIn(editor.prosemirrorState) === null) return false;
        if (editor.getExtension(SuggestionMenu)?.shown() === true) return false;
        if (documentBarsOf(editor).linkToolbarUp) return false;
        const listeners = escapeListeners.get(editor);
        if (listeners === undefined || listeners.size === 0) return false;
        listeners.forEach((listener) => {
          listener();
        });
        return true;
      },
    },
    prosemirrorPlugins: [
      new Plugin<AiRange | null>({
        key: DOCUMENT_AI_RANGE,
        state: {
          /**
           * Starts with no range.
           * @returns Null.
           */
          init: (): AiRange | null => null,

          /**
           * Opens, closes, or carries the range across this change.
           * @param tr - The transaction being applied.
           * @param current - The range before it.
           * @param before - The state the transaction applies to.
           * @returns The range after it.
           */
          apply: (tr, current, before): AiRange | null => {
            const asked = tr.getMeta(DOCUMENT_AI_RANGE) as AiRangeCommand | undefined;
            if (asked === null) return null;
            if (asked !== undefined) {
              entries += 1;
              const letters = letterBounds(tr.doc, asked.range, inlineLetter);
              return letters === null ? { kind: 'gone' } : { kind: 'present', slots: [letters], firstId: asked.firstId, lastId: asked.lastId, entry: entries };
            }
            if (current?.kind !== 'present' || !changesText(tr)) return current;
            const moved = tracker.carry(tr, current, before);
            if (moved === current.slots) return current;
            return moved[0] == null ? { kind: 'gone' } : { ...current, slots: moved };
          },
        },

        props: {
          decorations: paintRange,
        },

        /**
         * Names the range in Yjs terms after every change.
         * @param view - The editor view.
         * @returns The view's update and teardown.
         */
        view: (view) => tracker.view(view),
      }),
    ],
  };
});
