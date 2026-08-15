// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * **A selection in this document never spans the title and the body.**
 *
 * That is one rule, and it is why the two things in this file live together.
 * The title is the document's NAME: the AI slice replaces what is selected, so
 * a rewrite landing on the name is destructive in a way no undo makes
 * acceptable to ship. Whether the selection got there by a key or by a mouse
 * makes no difference to that, and splitting the answer across two files would
 * be writing one rule twice.
 *
 * The reason this cannot be left to the editor is structural: our title is the
 * first block of the same ProseMirror document as the body (content rule
 * `title block*`), so "everything" genuinely includes it. Editors whose title
 * is a separate field get this for free.
 *
 * ## The two ways in
 *
 * **`Mod-a`.** One press, one answer (decided 2026-08-15): in the body it takes
 * the whole body, in the title it takes the title, and with the caret in
 * neither it takes the whole body. Pressing again changes nothing. There is no
 * second tier — an earlier version took the caret's own block first and the
 * whole body on a second press, which is a feature of some editors and not of
 * this key. ProseMirror's own basic example is one tier, measured: a press
 * selects 515 characters and a second press selects the same 515.
 *
 * `@tiptap/core` ships its own `Keymap` extension binding this key to
 * `selectAll()`, and that command is the defect: measured, it produces an
 * `AllSelection` starting at 0, which is inside the title.
 *
 * **Dragging.** Measured 2026-08-15 in a browser, before this: dragging up from
 * the body's first paragraph onto the title gave `6..15` on a document whose
 * title occupies `0..9` — the last two characters of the name were selected,
 * and one keystroke would have taken them. `createSelectionBetween` is where
 * that is answered, below.
 *
 * ## Why it does not live in `document-title`
 *
 * That file defines the title node, and each of its keys asks "is the caret in
 * the title" and declines when it is not. Both halves here have to answer for
 * both sides at once, so putting them there would give the title node the
 * body's selection logic.
 */

import { Extension } from '@tiptap/core';
import type { ResolvedPos } from '@tiptap/pm/model';
import type { EditorState, Transaction } from '@tiptap/pm/state';
import { Plugin, PluginKey, Selection, TextSelection } from '@tiptap/pm/state';
import { DOCUMENT_TITLE_NODE } from '@breatic/shared';

/** A pair of document positions, resolved and ready to select between. */
interface Range {
  from: number;
  to: number;
}

/**
 * Where the body starts — everything the title occupies comes before it.
 * @param state - Editor state to read.
 * @returns The position just past the title node.
 */
function bodyStart(state: EditorState): number {
  return state.doc.child(0).nodeSize;
}

/**
 * The selection covering the whole body, or null when the body has no blocks.
 *
 * `TextSelection.between` is handed the body's two boundary positions and moves
 * each end to the nearest text position, which is what makes this an ordinary
 * text selection: both ends sit in inline content. That matters beyond
 * tidiness. `createParagraphNear`, `deleteSelection` and the rest of
 * `prosemirror-commands` decide whether they apply by asking
 * `$from.parent.inlineContent`, so a selection whose ends sit on block
 * boundaries makes Enter, a typed character and Delete behave differently from
 * every other editor. Measured with a selection type of our own whose ends were
 * the body's boundaries: pressing Enter over the whole body deleted nothing and
 * appended an empty paragraph instead.
 *
 * Which end moves which way is not left to chance. `between` derives its bias
 * from the two positions (`prosemirror-state` `TextSelection.between`): the
 * anchor comes before the head here, so the head searches backwards from the
 * body's end and the anchor forwards from its start — each toward the body,
 * neither toward the title.
 *
 * **There is no guard for "the body has blocks but none of them holds text".**
 * The only textless block this schema still has is `unsupportedBlock`, which is
 * an atom, renders as an empty `div` with no styling, and cannot be reached: a
 * document containing one is intercepted and the editor is never built
 * (`use-document-schema-intercept`). The divider used to be the other one, and
 * it is gone.
 * @param state - Editor state to read.
 * @returns The body's selection, or null when there is nothing to select.
 */
function bodySelection(state: EditorState): Selection | null {
  const start = bodyStart(state);
  const end = state.doc.content.size;
  if (start >= end) return null;
  return TextSelection.between(state.doc.resolve(start), state.doc.resolve(end));
}

/**
 * The range of the block the caret is in.
 *
 * Only the title reaches this now, and asking `$from` where its own block
 * starts and ends needs no knowledge of which block that is. An earlier version
 * had a separate `titleRange` that computed `1 .. 1 + child(0).content.size` —
 * the same two numbers by a different route, carrying two assumptions of its
 * own (that the title starts at 1, and that it is the first child).
 * @param state - Editor state to read.
 * @returns That block's content range.
 */
function currentBlockRange(state: EditorState): Range {
  const { $from } = state.selection;
  return { from: $from.start(), to: $from.end() };
}

/**
 * Which side of the document the caret is on.
 *
 * One question answers every selection shape: is `$from` inside a block that
 * holds text? A whole-body selection and an `AllSelection` both start at a
 * position between top-level blocks, whose parent is the document node, and a
 * document is not a textblock — so both come back "neither" and get answered
 * with the whole body, which is also the right answer for them.
 *
 * Asked of `$from`, not of the selection's shape. A selection that is not
 * collapsed still has a `$from`, and it is what the rule means by "where the
 * caret is": a double-clicked word in the title is a press made in the title,
 * and answering otherwise is how a press there ends up selecting the body.
 * @param state - Editor state to read.
 * @returns Which side the press acts on.
 */
function sideOfCaret(state: EditorState): 'title' | 'body' | 'neither' {
  const { $from } = state.selection;
  if ($from.parent.type.name === DOCUMENT_TITLE_NODE) return 'title';
  // The question is whether the position is INSIDE a block that holds text,
  // not how deep it sits. `depth === 0` only catches the top level, so a node
  // selection on a block inside a list item came back as "in the body" and got
  // answered with the block around it — measured, that produced an empty
  // selection in a paragraph the user was never in.
  if (!$from.parent.isTextblock) return 'neither';
  return 'body';
}

/**
 * The selection the press should produce.
 *
 * "Neither" maps to the body, and that is not the same case as an empty body.
 * A whole block being selected is the common way to get there: `Mod`-clicking a
 * paragraph makes a `NodeSelection` (`prosemirror-view` builds one when the
 * platform's select-node modifier is held, and `document-click-to-write` passes
 * modified clicks straight through), and a selection over a whole block sits
 * OUTSIDE that block, at document level, so `$from.parent` is the document.
 * Answering that with the title would mean: click a paragraph, press this key,
 * type one character, and the document's name is gone — the one outcome this
 * whole extension exists to prevent.
 * @param state - Editor state to read.
 * @returns The selection to apply, or null when there is nothing to select.
 */
function nextSelection(state: EditorState): Selection | null {
  if (sideOfCaret(state) !== 'title') return bodySelection(state);
  const title = currentBlockRange(state);
  return TextSelection.between(
    state.doc.resolve(title.from),
    state.doc.resolve(title.to),
  );
}

/**
 * Select everything on the caret's side of the document.
 *
 * **Always reports the key as handled**, including when it selects what was
 * already selected. Declining would hand `Mod-a` back to `@tiptap/core`'s
 * `Keymap`, whose binding is `selectAll` — the exact behaviour this exists to
 * replace. "Nothing changes" means giving back the same range, not leaving the
 * key to someone else.
 *
 * There is one case where it reports handled without selecting anything: a
 * document whose body has no blocks at all, with the caret in neither side.
 * Nothing to select is not the same as nothing to do — the key still belongs
 * to us, and leaving the selection untouched is the answer. (Whoever took the
 * key there would end up selecting the title, which is all the document holds,
 * so this particular case is about who owns the key rather than about keeping
 * the title out of a selection.)
 * @param state - Editor state to read.
 * @param dispatch - Applies the transaction.
 * @returns True, always.
 */
function selectThisSide(
  state: EditorState,
  dispatch?: (tr: Transaction) => void,
): boolean {
  const selection = nextSelection(state);
  if (!selection || !dispatch) return true;
  dispatch(state.tr.setSelection(selection));
  return true;
}

/**
 * Whether a position sits in the title rather than in the body.
 *
 * Asked of the POSITION, not of the node it resolves inside. A drag can end on
 * a boundary between blocks, where the parent is the document and neither
 * "is a title" nor "is a body block" answers anything; the title occupies
 * `0 .. titleSize` whatever the shape of what lives there.
 * @param $pos - The position to place.
 * @returns True when it is inside the title.
 * @throws {RangeError} Never — reading the first child of a document whose
 * content rule opens with the title.
 */
function inTitle($pos: ResolvedPos): boolean {
  return $pos.pos < $pos.doc.child(0).nodeSize;
}

/**
 * The far end of the anchor's own side — where a head that strayed belongs.
 *
 * The anchor is where the mouse went down, so it is what says which side the
 * user is selecting, and the head is the end that moves back. Clamping the
 * anchor instead would make a drag that overshoots by one character silently
 * switch sides.
 *
 * **The head is not a parameter**, because by the time this is reached it
 * carries no information: the only caller asks it when the two ends are on
 * opposite sides, so knowing where the anchor is already says which side the
 * head strayed from and how far back it has to come.
 *
 * Answering with a text position rather than the boundary itself matters for
 * the same reason it does in {@link bodySelection}: `prosemirror-commands` asks
 * `$from.parent.inlineContent` before it does anything, so a selection ending
 * on a block boundary makes the next keystroke behave unlike every other
 * editor.
 * @param state - Editor state to read.
 * @param $anchor - Where the drag started.
 * @returns The position to clamp the head to, or null when there is none.
 */
function farEndOfAnchorSide(
  state: EditorState,
  $anchor: ResolvedPos,
): ResolvedPos | null {
  const { doc } = state;
  const boundary = bodyStart(state);
  if (inTitle($anchor)) {
    // Into the title: the last position its text reaches.
    return doc.resolve(boundary - 1);
  }
  // Into the body: the first position its text reaches. `Selection.near`
  // searching forwards lands on it whatever the first block turns out to be —
  // a paragraph, a heading, or a quote holding one.
  const near = Selection.near(doc.resolve(boundary), 1);
  return near.from >= boundary ? doc.resolve(near.from) : null;
}

/**
 * Answer ProseMirror's question about a selection it is about to build.
 *
 * This is the official hook for it — `prosemirror-view@1.42.2:2401` reads
 * `createSelectionBetween` and falls back to `TextSelection.between` when no
 * plugin answers, and it is what `prosemirror-gapcursor` and
 * `prosemirror-tables` use for their own selection shapes. It is asked for
 * every selection the DOM produces, which is what makes it the right place: a
 * drag, a shift-click and a double-click that runs over the boundary all
 * arrive here.
 *
 * Returning null means "no opinion", and that is the answer for every
 * selection that stays on one side — the editor's own handling is what should
 * apply there.
 * @param state - Editor state to read.
 * @param $anchor - Where the selection started.
 * @param $head - Where it ended.
 * @returns A clamped selection, or null to leave it to the editor.
 */
function selectionWithinOneSide(
  state: EditorState,
  $anchor: ResolvedPos,
  $head: ResolvedPos,
): Selection | null {
  if (inTitle($anchor) === inTitle($head)) return null;
  const $clamped = farEndOfAnchorSide(state, $anchor);
  if (!$clamped) return null;
  return TextSelection.between($anchor, $clamped);
}

/**
 * The selection rules this document adds.
 *
 * `priority` is above `@tiptap/core`'s `Keymap` extension so this is asked
 * first; `DocumentTitle` claims its own keys at the same height for the same
 * reason.
 *
 * `Mod-` resolves once, when `prosemirror-keymap` is first evaluated, to
 * `Cmd` on macOS and `Ctrl` everywhere else — it is not both at once. Binding
 * `Ctrl-a` as well would be wrong rather than thorough: on macOS `@tiptap/core`
 * already binds it to `selectTextblockStart`.
 *
 * This answers for an editable editor. A read-only one never gets here at all,
 * and moving the binding does not change that: measured in a browser, a
 * read-only editor's DOM carries `contenteditable="false"` and no `tabindex`,
 * so clicking the text leaves focus on `body` and the key press never reaches
 * the editor's DOM node in the first place. What a viewer should get from this
 * key belongs with the rest of read-only behaviour, which is a separate piece
 * of work.
 */
export const DocumentSelection = Extension.create({
  name: 'documentSelection',
  priority: 1000,

  /**
   * Bind the key.
   * @returns The key bindings, by key name.
   */
  addKeyboardShortcuts() {
    return {
      'Mod-a': () => selectThisSide(this.editor.state, this.editor.view.dispatch),
    };
  },

  /**
   * Claim every selection the DOM produces, and keep it on one side.
   *
   * `someProp` walks the registered props and takes the first non-null answer,
   * so returning null from ours leaves the editor's own `TextSelection.between`
   * to run — which is what should happen for every selection that never
   * crosses the boundary.
   * @returns The plugin carrying that prop.
   */
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey('documentSelection'),
        props: {
          createSelectionBetween: (view, $anchor, $head) =>
            selectionWithinOneSide(view.state, $anchor, $head),
        },
      }),
    ];
  },
});
