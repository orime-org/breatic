// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

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
 * A range that is not words inside one line covers whole blocks (Plate
 * `captureTextRange`). The carried letters miss an image or an empty line at
 * its edges, so the first and the last block are held by id as well; what
 * replace covers is worked out from both (`aiCoverOf`), and so is what is
 * painted.
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
import type { Node as ProseMirrorNode, ResolvedPos } from '@tiptap/pm/model';
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
import { cellDepthOf, tableAround } from '@web/spaces/document/document-table-nodes';

/** What the dialog opens the range on (§4.6). */
export interface AiCapture {
  /** The captured range: inside one line of words, those words; otherwise the whole blocks. */
  readonly range: LocalRange;
  /** The first of the whole blocks; null for words inside one line. */
  readonly firstId: string | null;
  /** The last of the whole blocks; null for words inside one line. */
  readonly lastId: string | null;
  /** The block a result is inserted under (§5.4): the range's last block. */
  readonly insertId: string;
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

/** The schema group of the body's blocks: a block's container, or a table. */
export const BN_BLOCK = 'bnBlock';

/**
 * The position before the innermost block around a position.
 * @param doc - The body.
 * @param pos - The position.
 * @returns Where that block starts, or null outside any.
 */
export function containerAt(doc: ProseMirrorNode, pos: number): number | null {
  const $pos = doc.resolve(pos);
  for (let depth = $pos.depth; depth > 0; depth -= 1) {
    if ($pos.node(depth).type.isInGroup(BN_BLOCK)) return $pos.before(depth);
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
 * The block a position counts in (§4.6): the innermost one around it, or
 * the whole table when the range does not stay in one of its cells.
 * @param $pos - The position.
 * @param oneCell - Whether the range stays in one cell.
 * @returns Where the block starts, or null outside any block.
 */
export function blockAround($pos: ResolvedPos, oneCell: boolean): number | null {
  return (oneCell ? null : tableAround($pos)?.pos) ?? containerAt($pos.doc, $pos.pos);
}

/**
 * Whether two positions stand in the same table cell.
 * @param $a - One.
 * @param $b - The other.
 * @returns True when one cell holds both.
 */
export function inOneCell($a: ResolvedPos, $b: ResolvedPos): boolean {
  const a = cellDepthOf($a);
  const b = cellDepthOf($b);
  return a > 0 && b > 0 && $a.before(a) === $b.before(b);
}

/**
 * One end of a range taken the way §4.6 takes blocks: in a table it does
 * not stay in one cell of, the table's edge; in a legacy table's line, whose
 * block holds lines of its own, that block's edge; otherwise where it is.
 * @param $pos - The end.
 * @param oneCell - Whether the range stays in one cell.
 * @param side - Which end.
 * @returns The position.
 */
function blockEdge($pos: ResolvedPos, oneCell: boolean, side: 'start' | 'end'): number {
  const table = oneCell ? null : tableAround($pos);
  if (table !== null) return side === 'start' ? table.pos : table.pos + table.node.nodeSize;
  const block = containerAt($pos.doc, $pos.pos);
  if (block === null || !$pos.parent.isTextblock || $pos.before($pos.depth) === block + 1) return $pos.pos;
  return side === 'start' ? block : ownContentEnd($pos.doc, block);
}

/**
 * The range as it stands now (§5.4), one for what is painted and what
 * replace covers, the way Plate's range anchor maps (`association:
 * 'inward'`): from the carried letters, reaching back to the first block
 * and on to the last block where those hold no letters, and to a block's
 * edge where the letter at that end still sits at its line's edge; then
 * each end taken as §4.6 takes blocks.
 * @param doc - The body now.
 * @param letters - The carried letters, or null once gone.
 * @param firstId - The first block, or null for words inside one line.
 * @param lastId - The last block, or null for words inside one line.
 * @returns The range, or null once the letters are gone.
 */
export function aiCoverOf(doc: ProseMirrorNode, letters: LocalRange | null, firstId: string | null, lastId: string | null): LocalRange | null {
  if (letters === null) return null;
  const $first = doc.resolve(letters.from);
  const $last = doc.resolve(letters.to);
  // A letter always stands in a block.
  const firstBlock = containerAt(doc, letters.from)!;
  const lastBlock = containerAt(doc, letters.to - 1)!;
  let from = letters.from;
  let to = letters.to;
  if (firstId !== null) {
    const byId = blockById(doc, firstId)?.pos;
    if (byId !== undefined && byId < firstBlock) from = byId;
    else if (letters.from === $first.start()) from = firstBlock;
  }
  if (lastId !== null) {
    const byId = blockById(doc, lastId)?.pos;
    if (byId !== undefined && byId > lastBlock) to = ownContentEnd(doc, byId);
    else if (letters.to === $last.end()) to = ownContentEnd(doc, lastBlock);
  }
  const $from = doc.resolve(from);
  const $to = doc.resolve(to);
  if ($from.parent.isTextblock && $from.sameParent($to)) return { from, to };
  const oneCell = inOneCell($from, $to);
  return { from: blockEdge($from, oneCell, 'start'), to: blockEdge($to, oneCell, 'end') };
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
 * The selected look over the range replace covers, where the user's own
 * selection does not already draw it: while the body holds the focus its selection is painted
 * too, and the two translucent bands over the same words would draw them
 * darker than either.
 * @param state - The editor state.
 * @returns The stand-in decorations.
 */
function paintRange(state: EditorState): DecorationSet {
  const cover = aiCoverIn(state);
  if (cover === null) return DecorationSet.empty;
  const { selection } = state;
  const drawn = bodyHolds(state) && !selection.empty ? selection : null;
  const parts = drawn === null
    ? [cover]
    : [{ from: cover.from, to: Math.min(cover.to, drawn.from) }, { from: Math.max(cover.from, drawn.to), to: cover.to }];
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
