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
import type { Node as PMNode, ResolvedPos, Slice } from '@tiptap/pm/model';
import { Fragment } from '@tiptap/pm/model';
import type { EditorState, Transaction } from '@tiptap/pm/state';
import { Plugin, PluginKey, Selection, TextSelection } from '@tiptap/pm/state';
import { ReplaceAroundStep, ReplaceStep } from '@tiptap/pm/transform';
/**
 * Marks the transactions this file produces, so they cannot trigger the rule
 * that produced them, and so the enter binding's two paragraphs are not then
 * collapsed back into one.
 */
const CLEARED_BY_US = 'documentSelection:cleared';

/** A pair of document positions, resolved and ready to select between. */
interface Range {
  from: number;
  to: number;
}

/**
 * Where the body starts — everything the title occupies comes before it.
 * @param doc - The document to measure. Taken rather than the whole state so
 * that callers holding only a resolved position can use it too.
 * @returns The position just past the title node.
 */
function bodyStart(doc: PMNode): number {
  return doc.child(0).nodeSize;
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
  const start = bodyStart(state.doc);
  const end = state.doc.content.size;
  if (start >= end) return null;
  return TextSelection.between(state.doc.resolve(start), state.doc.resolve(end));
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
function sideOfCaret(state: EditorState): 'title' | 'body' {
  // Read positions, not the parent's type. A whole block selected with the
  // platform's select-node modifier sits OUTSIDE that block, at document level,
  // so `$from.parent` is the document for BOTH a selected title and a selected
  // body paragraph — the two land in the same bucket and cannot be told apart.
  // The title occupies `0..titleSize`, so a selection ending at or before that
  // boundary is on the title's side and everything else is on the body's.
  return state.selection.to <= bodyStart(state.doc) ? 'title' : 'body';
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
  if (sideOfCaret(state) === 'body') return bodySelection(state);
  // Read the title's own content range rather than `$from.start()`: a title
  // selected from outside puts `$from` at document level, where those helpers
  // answer with the whole document.
  const title = state.doc.child(0);
  return TextSelection.between(state.doc.resolve(1), state.doc.resolve(title.nodeSize - 1));
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
  dispatch: (tr: Transaction) => void,
): boolean {
  const selection = nextSelection(state);
  if (selection) dispatch(state.tr.setSelection(selection));
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
  return $pos.pos < bodyStart($pos.doc);
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
  const boundary = bodyStart(state.doc);
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
 * The span holding every piece of text in the body; null when the body has no
 * blocks at all.
 * @param state - The state to ask.
 * @returns The first and last text positions, or null.
 */
function bodyTextRange(state: EditorState): Range | null {
  const whole = bodySelection(state);
  if (!whole) return null;
  return { from: whole.from, to: whole.to };
}

/**
 * Whether the selection covers every piece of text in the body.
 *
 * Containment rather than equality: Cmd+click over the body's only block
 * selects it from outside (measured `7..21`, where Ctrl+A gives `8..20` on the
 * same document), and on screen the two look identical. The selection also has
 * to be non-empty — in a body holding one empty block the first and last text
 * positions and a collapsed caret are the same position, so without this a
 * fresh empty heading would be demoted to a paragraph by its first keystroke.
 * @param state - The state as it was before the operation.
 * @returns True when the selection covers the body and stays out of the title.
 */
function coversWholeBody(state: EditorState): boolean {
  const range = bodyTextRange(state);
  if (!range) return false;
  const { from, to } = state.selection;
  if (from === to) return false;
  if (from < bodyStart(state.doc)) return false;
  return from <= range.from && to >= range.to;
}

/**
 * Whether what a step puts back holds nothing but inline content.
 *
 * Deleting a body of "list then paragraph" produces a ReplaceAroundStep
 * carrying an `openStart: 3` bulletList shell, empty once those three layers
 * come off, so that counts as a clearing. Pasting two paragraphs gives a slice
 * whose content has two children, the loop cannot descend, and the block check
 * rejects it.
 * @param slice - What the step puts back.
 * @returns True when only inline content remains after the open layers.
 */
function putsBackOnlyInline(slice: Slice): boolean {
  let frag: Fragment = slice.content;
  for (let depth = 0; depth < slice.openStart && frag.childCount === 1; depth += 1) {
    const only: PMNode | null = frag.firstChild;
    if (!only || only.isInline) break;
    frag = only.content;
  }
  let inlineOnly = true;
  frag.forEach((child) => {
    if (!child.isInline) inlineOnly = false;
  });
  return inlineOnly;
}

/**
 * All the text this batch of transactions puts back.
 * @param trs - The batch.
 * @returns The concatenated text.
 */
function insertedText(trs: readonly Transaction[]): string {
  let out = '';
  for (const tr of trs) {
    for (const step of tr.steps) {
      if (step instanceof ReplaceStep || step instanceof ReplaceAroundStep) {
        out += step.slice.content.textBetween(0, step.slice.content.size, '', '');
      }
    }
  }
  return out;
}

/**
 * Whether the batch took the selected stretch away and put back only text.
 *
 * Bolding produces an AddMarkStep and fails at the first branch; a drop lands
 * somewhere else so its step does not span the selection; a paste puts back
 * headings and lists. Seeing at least one step matters because a batch with no
 * steps at all — a second Ctrl+A, a click — satisfies any universal claim.
 * @param trs - The batch.
 * @param sel - The stretch selected before the operation.
 * @returns True when the batch is a clearing of that stretch.
 */
function tookTheSelectionAway(trs: readonly Transaction[], sel: Range): boolean {
  let cleared = false;
  for (const tr of trs) {
    for (const step of tr.steps) {
      if (!(step instanceof ReplaceStep || step instanceof ReplaceAroundStep)) {
        return false;
      }
      if (!putsBackOnlyInline(step.slice)) return false;
      if (step.from > sel.from || step.to < sel.to) return false;
      cleared = true;
    }
  }
  return cleared;
}

/**
 * Whether nothing of what was there survives.
 *
 * Two checks, because each catches half of lifting a blockquote — a
 * ReplaceAroundStep whose slice is empty, since what survives lives in its gap
 * where the check above cannot see it. With text in the quote the first check
 * catches it, since that text is still there afterwards; with only empty
 * paragraphs the second does, since a clearing collapses the body to one block
 * or none while a lift leaves two side by side.
 * @param trs - The batch.
 * @param state - The state after the operation.
 * @returns True when only what this operation inserted is left.
 */
function nothingOldLeft(trs: readonly Transaction[], state: EditorState): boolean {
  const start = bodyStart(state.doc);
  const end = state.doc.content.size;
  const left = start < end ? state.doc.textBetween(start, end, '', '') : '';
  if (left !== insertedText(trs)) return false;
  // The doc is `title block*`, so the body holds childCount - 1 blocks.
  return state.doc.childCount <= 2;
}

/**
 * Whether this batch is the user saying the whole body is done for.
 *
 * The `CLEARED_BY_US` line is a recursion stop, not one of the criteria.
 * `applyTransaction` hands an appended transaction back to every plugin on the
 * next pass (`prosemirror-state` `dist/index.cjs`, the `trs.slice(n)` loop), so
 * what this returns arrives here again. Nothing can currently get past it:
 * whatever the user did collapsed the selection, so `coversWholeBody` answers
 * no on the second pass — measured, deleting the line leaves all tests green.
 * It stays because the cost of being wrong about that is an editor that hangs.
 * @param trs - The batch.
 * @param before - The state before it.
 * @param after - The state after it.
 * @returns True when the body should be collapsed.
 */
function isClearingTheWholeBody(
  trs: readonly Transaction[],
  before: EditorState,
  after: EditorState,
): boolean {
  if (trs.some((tr) => tr.getMeta(CLEARED_BY_US) === true)) return false;
  if (!coversWholeBody(before)) return false;
  if (!tookTheSelectionAway(trs, before.selection)) return false;
  return nothingOldLeft(trs, after);
}

/**
 * The transaction that turns the body into one paragraph holding what is left.
 *
 * Both routes into this rule end here: the transaction-level one for everything
 * that finishes in a single step, and the composition one for the input method,
 * which finishes only when the user picks a candidate.
 * @param state - The state to collapse.
 * @returns The transaction, or null when the body already looks like that.
 */
function bodyAsOneParagraph(state: EditorState): Transaction | null {
  const paragraph = state.schema.nodes.paragraph;
  const wanted = paragraph.create(null, inlineLeftInBody(state));
  if (state.doc.childCount === 2 && state.doc.child(1).eq(wanted)) return null;
  return replaceBodyWith(state.tr, state, [wanted]);
}

/**
 * Every inline node left in the body, marks and all.
 * @param state - The state to read.
 * @returns The inline content as one fragment.
 */
function inlineLeftInBody(state: EditorState): Fragment {
  const start = bodyStart(state.doc);
  const end = state.doc.content.size;
  if (start >= end) return Fragment.empty;
  let out = Fragment.empty;
  state.doc.nodesBetween(start, end, (node) => {
    if (node.isInline) {
      out = out.append(Fragment.from(node));
      return false;
    }
    return true;
  });
  return out;
}

/**
 * Replace the body with the given blocks and leave the caret in the last one.
 *
 * The caret has to be set explicitly. Deleting a two-item list empties the body
 * of blocks, and from there `Selection.near` can only reach the title — which
 * is the very harm this rule exists to prevent, since the next keystroke would
 * land in the document's name.
 * @param tr - The transaction to write into.
 * @param state - The state the positions are read from.
 * @param blocks - What the body becomes.
 * @returns The same transaction, marked as ours.
 */
function replaceBodyWith(
  tr: Transaction,
  state: EditorState,
  blocks: PMNode[],
): Transaction {
  tr.replaceWith(bodyStart(state.doc), state.doc.content.size, blocks);
  tr.setSelection(TextSelection.create(tr.doc, tr.doc.content.size - 1));
  tr.setMeta(CLEARED_BY_US, true);
  return tr;
}

/**
 * Enter over a selection covering the whole body: two empty paragraphs.
 *
 * Clearing plus one line break, which is what enter is. It cannot go through
 * the rule above, because that rule only sees what is left afterwards and
 * cannot tell enter from delete.
 * @param state - The current state.
 * @param dispatch - The editor's dispatch.
 * @returns True when it handled the key.
 */
function clearBodyForEnter(
  state: EditorState,
  dispatch: (tr: Transaction) => void,
): boolean {
  if (!coversWholeBody(state)) return false;
  const paragraph = state.schema.nodes.paragraph;
  dispatch(replaceBodyWith(state.tr, state, [paragraph.create(), paragraph.create()]));
  return true;
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
      Enter: () => clearBodyForEnter(this.editor.state, this.editor.view.dispatch),
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
    const { editor } = this;
    // Whether the selection covered the whole body when composition started.
    // Read at that moment because the input method is about to replace it.
    let composingOverWholeBody = false;
    return [
      new Plugin({
        key: new PluginKey('documentSelection'),
        props: {
          createSelectionBetween: (view, $anchor, $head) =>
            selectionWithinOneSide(view.state, $anchor, $head),
          handleDOMEvents: {
            compositionstart: (view) => {
              composingOverWholeBody = coversWholeBody(view.state);
              return false;
            },
            compositionend: (view) => {
              if (!composingOverWholeBody) return false;
              composingOverWholeBody = false;
              // Asynchronously, because dispatching from inside an event the
              // editor is still handling starts an update in the middle of
              // another one. `prosemirror-view` schedules its own composition
              // cleanup the same way.
              void Promise.resolve().then(() => {
                if (view.isDestroyed) return;
                const tr = bodyAsOneParagraph(view.state);
                if (tr) view.dispatch(tr);
              });
              return false;
            },
          },
        },
        appendTransaction: (trs, before, after) => {
          // While an input method is assembling a character the user has not
          // finished saying anything, so nothing here counts as done yet.
          // Touching the document now also destroys the composition: updating
          // it while composing costs `prosemirror-view` the node it remembered
          // (`dist/index.cjs:5158`), and rebuilding the view drops it for good.
          if (editor.view.composing) return null;
          if (!isClearingTheWholeBody(trs, before, after)) return null;
          return bodyAsOneParagraph(after);
        },
      }),
    ];
  },
});
