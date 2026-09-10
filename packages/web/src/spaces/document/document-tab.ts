// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Tab and Shift-Tab, for every selection rather than for a caret alone.
 *
 * The move and the question of whether it is possible are the same call:
 * `nestBlock` reads `$from.blockRange($to)` and leaves the document alone when
 * the range has nowhere to go (`nestBlock.ts`, `startIndex === 0`). Asking a
 * separate question first is what put the two out of step — `canNestBlock`
 * resolves the block at `selection.anchor`, which is the end the drag started
 * from, so a backwards drag asked about one block and acted on another.
 *
 * WHEN TAB CANNOT MOVE A BLOCK, THE READER IS TOLD. A block already as deep as
 * it can go took the key and did nothing, and there was no way to tell that
 * from a press that missed (user 2026-09-08). The topmost block of the
 * selection is marked `data-tab-blocked` and the stylesheet animates it.
 *
 * THE MARK IS A DECORATION, not an attribute written onto the element. Writing
 * it on the element is what made the first version do nothing at all: measured
 * in a browser, the `.bn-block-outer` the attribute landed on reported
 * `isConnected: false` in the very next task — ProseMirror had already
 * replaced it — so no rule ever reached it, `getAnimations()` came back empty,
 * and the reader saw nothing. A decoration is re-applied to whatever element
 * currently stands for that block, which is what surviving a redraw means.
 * jsdom has no such redraw, so the five cases below passed against the broken
 * version too; the probe that caught it drives a real browser.
 *
 * ONE MARK FOR A SELECTION OF ANY SIZE, on the block highest in the document.
 * Indentation moves a range as one, so the first block moving is what decides
 * whether any of them do — if that one cannot go, none of them did.
 *
 * SHIFT-TAB SAYS NOTHING. A block at the top level is already at the left edge
 * of the body, and a nudge there would take it outside the text (user
 * 2026-09-08).
 *
 * Whether the document moved is read the same way it is caused: the state's
 * `doc` is a persistent value, so an unchanged document is the same object.
 *
 * The key is claimed either way. An unclaimed Tab is one the browser answers,
 * and the browser answers it by moving focus out of the editor: measured,
 * focus went from the editor to `BODY` and the next characters the reader
 * typed reached nothing. BlockNote's own source says the same —
 * `KeyboardShortcutsExtension.ts:958`, "Always returning true for tab key
 * presses ensures they're not captured by the browser. Otherwise, they blur
 * the editor".
 */

import { createExtension } from '@blocknote/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import type { EditorState } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { EditorView } from '@tiptap/pm/view';
import type { Node as PMNode } from '@tiptap/pm/model';

/** The attribute the stylesheet animates. */
const BLOCKED_ATTRIBUTE = 'data-tab-blocked';

/**
 * How long the nudge runs.
 *
 * Defined here rather than in the stylesheet because both halves need it: the
 * animation's length and the wait before the mark comes off. The rule reads it
 * from `--doc-tab-nudge`, written onto the decoration below, so the two can
 * never drift apart.
 */
const NUDGE_MS = 260;

/** Where the marked block is, or null when nothing is marked. */
const nudgeKey = new PluginKey<number | null>('document-tab-nudge');

/** What the editor object offers this file. */
interface TabEditor {
  nestBlock: () => void;
  unnestBlock: () => void;
  prosemirrorView: EditorView;
}

/**
 * Where the first block Tab would have moved begins.
 *
 * Read through the range `nestBlock` itself acts on, so the block that is
 * marked is the block that would have moved: `nestBlock.ts` takes
 * `$from.blockRange($to, node => node.childCount > 0 && (blockGroup ||
 * column))`, gives up when `range.startIndex === 0`, and otherwise moves from
 * `range.start`.
 *
 * Walking the document for the first `blockContainer` instead named the wrong
 * block. Blocks nest inside one another, so the containers reached on the way
 * down to the caret are its ANCESTORS — a block indented once had the nudge
 * drawn on the top-level block holding it, and the animation started from the
 * left edge of the body rather than from the line the reader was on (user
 * 2026-09-08).
 *
 * A position rather than an element: the element is whatever currently draws
 * that block, and the point of a decoration is not to hold on to one.
 *
 * A WHOLE-DOCUMENT SELECTION HAS NO SUCH RANGE, and it is two presses of the
 * platform's select-all away. Its `$from` sits at depth zero, whose parent is
 * the doc rather than a `blockGroup`, so the predicate matches nothing and
 * `blockRange` comes back null — the press was claimed and the reader was
 * told nothing (measured in a browser: `[data-tab-blocked]` came back empty
 * while the same press one block down drew the nudge). The block Tab would
 * have moved is still the document's first, which is exactly the one
 * `nestBlock` gives up on.
 * @param view - The editor view to read.
 * @returns That position, or null for a document holding no block.
 */
function topmostBlockPos(view: EditorView): number | null {
  const { $from, $to } = view.state.selection;
  const range = $from.blockRange(
    $to,
    (node: PMNode) =>
      node.childCount > 0 &&
      (node.type.name === 'blockGroup' || node.type.name === 'column'),
  );
  if (range !== null) return range.start;

  let first: number | null = null;
  view.state.doc.descendants((node: PMNode, pos: number) => {
    if (first !== null) return false;
    if (node.type.name !== 'blockContainer') return true;
    first = pos;
    return false;
  });
  return first;
}

/**
 * The plugin that draws the mark on whichever block is currently blocked.
 * @returns The ProseMirror plugin.
 */
function nudgePlugin(): Plugin<number | null> {
  return new Plugin<number | null>({
    key: nudgeKey,
    state: {
      init: () => null,
      apply: (tr, previous) => {
        const asked = tr.getMeta(nudgeKey) as number | null | undefined;
        if (asked !== undefined) return asked;
        // A changed document takes the mark off. What it marks is a block that
        // could not move, and an edit means the reader has moved on; carrying
        // the position across changes that may have removed the block is more
        // than a 260ms animation is worth.
        return tr.docChanged ? null : previous;
      },
    },
    props: {
      decorations: (state: EditorState) => {
        const pos = nudgeKey.getState(state);
        if (pos === null || pos === undefined) return null;
        const node = state.doc.nodeAt(pos);
        if (node === null) return null;
        return DecorationSet.create(state.doc, [
          Decoration.node(pos, pos + node.nodeSize, {
            [BLOCKED_ATTRIBUTE]: '',
            style: `--doc-tab-nudge:${NUDGE_MS}ms`,
          }),
        ]);
      },
    },
  });
}

/**
 * The extension that binds Tab for the whole document.
 * @returns The extension, for the assembly to register.
 */
export const documentTabExtension = createExtension(() => {
  let timer: ReturnType<typeof setTimeout> | undefined;

  /**
   * Marks the topmost block of the selection, and takes the mark off when the
   * animation is over.
   *
   * A second press while one is still running leaves it running: re-applying
   * the same decoration sets the same attribute on the same element, which
   * restarts nothing, and the reader pressing again inside 260ms is already
   * watching the answer to the first press.
   * @param view - The editor view the selection belongs to.
   */
  function sayItCannotMove(view: EditorView): void {
    const pos = topmostBlockPos(view);
    if (pos === null) return;
    view.dispatch(view.state.tr.setMeta(nudgeKey, pos));
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (view.isDestroyed) return;
      view.dispatch(view.state.tr.setMeta(nudgeKey, null));
    }, NUDGE_MS);
  }

  return {
    key: 'document-tab',
    prosemirrorPlugins: [nudgePlugin()],
    keyboardShortcuts: {
      Tab: ({ editor }: { editor: TabEditor }) => {
        const view = editor.prosemirrorView;
        const before = view.state.doc;
        editor.nestBlock();
        if (view.state.doc === before) sayItCannotMove(view);
        return true;
      },
      'Shift-Tab': ({ editor }: { editor: TabEditor }) => {
        editor.unnestBlock();
        return true;
      },
    },
  } as never;
});
