// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Typing and keys around a formula (inner#1423 design §6.2, §6.4, §6.5).
 *
 * | what | how |
 * |---|---|
 * | `$$x$$` | the closing `$` lands as text; a `$` that came through `handleTextInput` arms the rule, and the conversion follows in a transaction of its own, its own undo step |
 * | Backspace right after converting | turns it back into the text `$$x$$` |
 * | Backspace / Delete beside an inline formula | the caret goes into its source; nothing the user cannot see is deleted |
 * | any deletion in an open source, by a key or the browser's own binding (a character, a word, a line) | deleted inside the source only, the caret staying in it |
 * | a deletion at the edge of an open source | does nothing, or removes the formula when its source is empty; a block formula's indented lines stay, lifted into its place |
 * | Backspace at the start of the line after a closed block formula, Delete at the end of the line before one, in reading order | selects the formula, box closed; the next press deletes it; from an empty line, the line goes first |
 * | a word or line deletion that runs over an inline formula | takes the whole formula |
 * | Shift+Backspace / Shift+Delete | as without Shift |
 * | Enter in an inline source | confirms, the caret after the formula, whatever block the line is |
 * | ArrowLeft / ArrowRight across an inline formula's edge | the caret goes into its source, or out to right beside the formula |
 * | input into a selected, closed block formula | refused: its source is hidden |
 * | a selection reaching into a hidden source from outside | widened to the whole formula |
 * | a selection starting in an open source | ends inside it, as in a text box |
 *
 * The keys run ahead of `document-enter` and `document-table-keys`, which
 * would otherwise split a quoted line or answer a table cell's edge first.
 * A deletion the browser makes from a binding of its own (Alt+Backspace,
 * Ctrl+K) never reaches a keymap, so `beforeinput` takes every deletion the
 * same way.
 * Only a `$` from `handleTextInput` arms the rule (`prosemirror-inputrules`
 * 1.5.1 `index.js:74-85` judges there too), so the text an undo, a redo or a
 * co-editor brings back is never converted again.
 */

import { createExtension, type BlockNoteEditor } from '@blocknote/core';
import { SourceBlockWithPreviewExtension } from '@blocknote/core/extensions';
import { isMacOS } from '@tiptap/core';
import type { Node as PMNode, ResolvedPos } from '@tiptap/pm/model';
import { Plugin, PluginKey, Selection, TextSelection, type EditorState } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';

import { isFormula, MATH_BLOCK, MATH_INLINE } from '@web/spaces/document/document-math';
import { cellDepthOf } from '@web/spaces/document/document-table-nodes';
import { markOwnUndoStep } from '@web/spaces/document/document-undo-step';

/** The editor as this file uses it. */
type MathEditor = BlockNoteEditor<never, never, never>;

/** How much one deletion takes: a line as laid out, or a paragraph up to its edge. */
type Unit = 'character' | 'word' | 'line' | 'paragraph';

/** The deletions `beforeinput` states with a direction. */
const DELETION = /^delete(Content|Word|SoftLine|HardLine)(Backward|Forward)$/;

/** How much each of them takes. */
const UNITS: Readonly<Record<string, Unit>> = { Content: 'character', Word: 'word', SoftLine: 'line', HardLine: 'paragraph' };

/** Characters as the user sees them: an emoji is one, though it is two code units. */
const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/** Words, for a word deletion inside a source. */
const WORDS = new Intl.Segmenter(undefined, { granularity: 'word' });

/**
 * A closing `$$` and what it encloses at the end of the text before the
 * caret: not preceded by `\` or `$`, no white space right inside either pair.
 * `￼` stands for any inline node, which a source cannot hold.
 */
const CLOSED_FORMULA = /(?<![\\$])\$\$([^\s$￼](?:[^$\n￼]*[^\s$￼])?)\$\$$/;

/**
 * The id of the block formula whose hidden source a position is in, when its
 * box is closed.
 * @param editor - The editor.
 * @param $pos - The position.
 * @returns The block's id, or null when the position is not in a closed one.
 */
export function closedFormulaBlockAt(editor: MathEditor, $pos: ResolvedPos): string | null {
  const { parent } = $pos;
  if (!parent.isTextblock || $pos.depth < 1 || !isFormula(parent)) return null;
  const id = $pos.node($pos.depth - 1).attrs['id'] as string | undefined;
  if (id === undefined) return null;
  return editor.getExtension(SourceBlockWithPreviewExtension)?.store.state.popupOpen === id ? null : id;
}

/**
 * Whether a position sits in a formula's hidden source: a closed block
 * formula, or an inline formula the selection is not in.
 * @param editor - The editor.
 * @param $pos - The position.
 * @param state - The state the selection is read from.
 * @returns True when the user cannot see the source there.
 */
function inHiddenSource(editor: MathEditor, $pos: ResolvedPos, state: EditorState): boolean {
  if (closedFormulaBlockAt(editor, $pos) !== null) return true;
  if ($pos.parent.isTextblock || !isFormula($pos.parent)) return false;
  return !state.selection.$from.sameParent($pos);
}

/**
 * The source a position is in when the user is editing it: an inline
 * formula's, or a block formula's with its box open.
 * @param editor - The editor.
 * @param $pos - The position.
 * @returns Where the source starts and ends, or null.
 */
function openSourceRange(editor: MathEditor, $pos: ResolvedPos): { start: number; end: number } | null {
  if (!isFormula($pos.parent) || ($pos.parent.isTextblock && closedFormulaBlockAt(editor, $pos) !== null)) return null;
  return { start: $pos.start(), end: $pos.end() };
}

/**
 * Where one deletion from an offset in a text ends: the next character, the
 * next word with the spaces before it, or the line's edge; a line deletion
 * at a line's edge takes the line break.
 * @param text - The text.
 * @param offset - Where the deletion starts.
 * @param back - Backward, else forward.
 * @param unit - How much it takes.
 * @returns The offset at its other end, `offset` when there is nothing to take.
 */
function deletionEdge(text: string, offset: number, back: boolean, unit: Unit): number {
  if (unit === 'line' || unit === 'paragraph') {
    const edge = back ? text.lastIndexOf('\n', offset - 1) + 1 : text.indexOf('\n', offset);
    const at = edge < 0 ? text.length : edge;
    return at === offset ? Math.min(Math.max(offset + (back ? -1 : 1), 0), text.length) : at;
  }
  const segments = [...(unit === 'word' ? WORDS : GRAPHEMES).segment(text)];
  let at = offset;
  for (const segment of back ? segments.reverse() : segments) {
    const end = segment.index + segment.segment.length;
    if (back ? segment.index >= at : end <= at) continue;
    at = back ? segment.index : end;
    // A character is one segment; a word deletion runs over the spaces up to a word and takes it.
    if (unit === 'character' || segment.isWordLike === true) break;
  }
  return at;
}

/** A conversion just made, which a Backspace right after takes back. */
interface Converted {
  readonly from: number;
  readonly to: number;
  readonly text: string;
  readonly state: EditorState;
}

/**
 * The `$$x$$` rule and the memory of its last conversion.
 * @param editor - The editor.
 * @returns The plugin, and the Backspace that takes a conversion back.
 */
function inputRule(editor: MathEditor): { plugin: Plugin; takeBack: (view: EditorView) => boolean } {
  // ponytail: one armed `$` per view; a second view of the same plugin instance would share it.
  let armed: number | null = null;
  let converted: Converted | null = null;

  /**
   * Converts the closed `$$x$$` before the caret, when the `$` armed at
   * `at` is the one that closed it.
   * @param view - The editor view.
   * @param at - Where the armed `$` was typed.
   */
  const convert = (view: EditorView, at: number): void => {
    if (view.isDestroyed) return;
    const { state } = view;
    const { $cursor } = state.selection as TextSelection;
    if (!$cursor || $cursor.pos !== at + 1 || $cursor.parent.type.spec.code === true) return;
    const before = $cursor.parent.textBetween(0, $cursor.parentOffset, undefined, '￼');
    const match = CLOSED_FORMULA.exec(before);
    if (match === null) return;
    const type = state.schema.nodes[MATH_INLINE];
    if (type === undefined) return;
    const from = $cursor.pos - match[0].length;
    const node = type.create(null, state.schema.text(match[1]!));
    const tr = state.tr.replaceWith(from, $cursor.pos, node);
    tr.setSelection(TextSelection.create(tr.doc, from + node.nodeSize));
    view.dispatch(markOwnUndoStep(tr));
    converted = { from, to: from + node.nodeSize, text: match[0], state: view.state };
  };

  const plugin = new Plugin({
    key: new PluginKey('documentMathInput'),
    props: {
      handleTextInput: (view, from, _to, text): boolean => {
        armed = null;
        if (text !== '$' || view.composing) return false;
        const $from = view.state.doc.resolve(from);
        if ($from.parent.type.spec.code === true) return false;
        const code = view.state.schema.marks['code'];
        if (code !== undefined && code.isInSet(view.state.storedMarks ?? $from.marks()) !== undefined) return false;
        armed = from;
        return false;
      },
      handleDOMEvents: {
        compositionend: (view): boolean => {
          // After the input method's own text is in; `prosemirror-inputrules`
          // re-checks the same way.
          setTimeout(() => {
            if (view.isDestroyed || view.composing || !editor.isEditable) return;
            const { $cursor } = view.state.selection as TextSelection;
            if (!$cursor || $cursor.parent.type.spec.code === true || !$cursor.parent.textBetween(0, $cursor.parentOffset).endsWith('$')) {
              return;
            }
            convert(view, $cursor.pos - 1);
          }, 0);
          return false;
        },
      },
    },
    view: () => ({
      update: (view, prevState): void => {
        if (converted !== null && converted.state !== view.state) converted = null;
        if (armed === null) return;
        const at = armed;
        armed = null;
        if (view.state.doc === prevState.doc) return;
        // A transaction of its own, after the one that typed the `$`.
        queueMicrotask(() => {
          convert(view, at);
        });
      },
    }),
  });

  return {
    plugin,
    takeBack: (view): boolean => {
      const last = converted;
      if (last === null || last.state !== view.state) return false;
      const { state } = view;
      const tr = state.tr.replaceWith(last.from, last.to, state.schema.text(last.text));
      tr.setSelection(TextSelection.create(tr.doc, last.from + last.text.length));
      view.dispatch(tr);
      converted = null;
      return true;
    },
  };
}

/**
 * Removes the inline formula the caret's source belongs to, the caret where it stood.
 * @param view - The editor view.
 * @param $pos - A position inside its source.
 * @returns True.
 */
function removeInline(view: EditorView, $pos: ResolvedPos): boolean {
  const at = $pos.before();
  const tr = view.state.tr.delete(at, $pos.after());
  tr.setSelection(TextSelection.create(tr.doc, at));
  view.dispatch(tr);
  return true;
}

/**
 * Removes an emptied block formula, the lines indented under it lifted into
 * its place, as an empty paragraph's Backspace does; the caret goes to the
 * end of what came before it for Backspace, to the start of what follows for
 * Delete.
 * @param editor - The editor.
 * @param view - The editor view.
 * @param $cursor - The caret, in the formula's source.
 * @param back - Backspace, else Delete.
 * @returns True.
 */
function removeFormulaBlock(editor: MathEditor, view: EditorView, $cursor: ResolvedPos, back: boolean): boolean {
  const at = $cursor.before($cursor.depth - 1);
  const id = $cursor.node($cursor.depth - 1).attrs['id'] as string;
  // The cell's start lies before the formula, so the removal leaves it where it is.
  const cell = cellDepthOf($cursor);
  const cellStart = cell < 0 ? -1 : $cursor.start(cell);
  const children = (editor.getBlock(id) as { children: never[] } | undefined)?.children ?? [];
  if (children.length > 0) editor.replaceBlocks([id], children);
  else editor.removeBlocks([id]);
  const { state } = view;
  const $at = state.doc.resolve(Math.min(at, state.doc.content.size));
  let near = Selection.near($at, back ? -1 : 1);
  if (cellStart >= 0) {
    const $cell = state.doc.resolve(cellStart);
    if (near.from < cellStart || near.from > $cell.end()) near = Selection.near($at, back ? 1 : -1);
  }
  view.dispatch(state.tr.setSelection(near));
  return true;
}

/**
 * Deletes in the open source the selection is in, never past its edges:
 * the selection, or one character, word or line from the caret. The deletion
 * is ours rather than the browser's, so the source's element stays in place
 * when the source empties and the next keystroke lands in it. At an edge
 * nothing is deleted, unless the source is empty: then the formula goes.
 * @param editor - The editor.
 * @param view - The editor view.
 * @param back - Backward, else forward.
 * @param unit - How much one deletion takes.
 * @returns True.
 */
function deleteInSource(editor: MathEditor, view: EditorView, back: boolean, unit: Unit): boolean {
  const { selection } = view.state;
  const { $from } = selection;
  const start = $from.start();
  let from = selection.from;
  let to = Math.min(selection.to, $from.end());
  if (selection.empty) {
    const offset = $from.parentOffset;
    const edge = deletionEdge($from.parent.textContent, offset, back, unit);
    if (edge === offset) {
      if ($from.parent.content.size > 0) return true;
      return $from.parent.isTextblock ? removeFormulaBlock(editor, view, $from, back) : removeInline(view, $from);
    }
    from = start + Math.min(edge, offset);
    to = start + Math.max(edge, offset);
  }
  const tr = view.state.tr.delete(from, to);
  view.dispatch(tr.setSelection(TextSelection.create(tr.doc, from)));
  return true;
}

/**
 * The block next to the caret's line in reading order, inside its table
 * cell: before it, the last line of the block above, indented lines
 * included; after it, the line's own first indented line, else the next
 * line at the nearest level out. The first line under a block has none
 * before it, since Backspace there unindents it first.
 * @param $cursor - The caret.
 * @param back - Before, else after.
 * @returns The block, or null.
 */
function blockBeside($cursor: ResolvedPos, back: boolean): PMNode | null {
  const depth = $cursor.depth - 1;
  const block = $cursor.node(depth);
  if (block.type.name !== 'blockContainer') return null;
  if (back) {
    let node = $cursor.node(depth - 1).maybeChild($cursor.index(depth - 1) - 1);
    // A block's indented lines are the last child it holds.
    while (node !== null && node.childCount > 1) node = node.lastChild!.lastChild;
    return node;
  }
  if (block.childCount > 1) return block.lastChild!.firstChild;
  for (let level = depth; level > 0 && $cursor.node(level).type.name === 'blockContainer'; level -= 2) {
    const next = $cursor.node(level - 1).maybeChild($cursor.index(level - 1) + 1);
    if (next !== null) return next;
  }
  return null;
}

/**
 * The closed block formula the caret's line borders, with the caret at the
 * line's start for Backspace or its end for Delete.
 * @param $cursor - The caret.
 * @param back - Backspace, else Delete.
 * @returns The formula's block, or null.
 */
function formulaBlockBeside($cursor: ResolvedPos, back: boolean): PMNode | null {
  if ($cursor.parentOffset !== (back ? 0 : $cursor.parent.content.size)) return null;
  const beside = blockBeside($cursor, back);
  return beside?.firstChild?.type.name === MATH_BLOCK ? beside : null;
}

/**
 * Selects a formula block the caret's line borders, its box closed; the next
 * press deletes it (`SourceBlockWithPreview.ts:166-171`). Joining the line
 * into the formula would write the line into a source nobody can see. From
 * an empty line, the line goes in the same step, as it does under an image.
 * A heading or a list item takes its own first step on Backspace first.
 * @param editor - The editor.
 * @param $cursor - The caret.
 * @param formula - The formula's block.
 * @param back - Backspace, else Delete.
 * @returns Whether the formula was selected.
 */
function selectFormula(editor: MathEditor, $cursor: ResolvedPos, formula: PMNode, back: boolean): boolean {
  const { parent } = $cursor;
  if (back && parent.type.name !== 'paragraph') return false;
  const line = $cursor.node($cursor.depth - 1);
  editor.transact(() => {
    if (back && parent.content.size === 0 && line.childCount === 1) editor.removeBlocks([line.attrs['id'] as string]);
    editor.setTextCursorPosition(formula.attrs['id'] as string, 'end');
  });
  return true;
}

/**
 * Deletes the range a word or line deletion takes, widened to the whole of
 * every inline formula in it, inside the caret's line.
 * @param view - The editor view.
 * @param $cursor - The caret.
 * @param range - The range the browser would delete, or null when it states none.
 * @returns Whether the deletion was taken: false when it reaches no formula.
 */
function deleteOverFormulas(view: EditorView, $cursor: ResolvedPos, range: readonly [number, number] | null): boolean {
  if (range === null) return false;
  let [from, to] = range;
  let touched = false;
  view.state.doc.nodesBetween(from, to, (node, pos) => {
    if (!node.isInline || !isFormula(node)) return true;
    touched = true;
    from = Math.min(from, pos);
    to = Math.max(to, pos + node.nodeSize);
    return false;
  });
  if (!touched) return false;
  from = Math.max(from, $cursor.start());
  to = Math.min(to, $cursor.end());
  const tr = view.state.tr.delete(from, to);
  view.dispatch(tr.setSelection(TextSelection.create(tr.doc, from)));
  return true;
}

/**
 * A deletion by a formula, from a key or from the browser's `beforeinput`.
 * @param editor - The editor.
 * @param view - The editor view.
 * @param back - Backward, else forward.
 * @param unit - How much it takes.
 * @param target - The range the browser would delete, for a word or line deletion it makes itself.
 * @returns Whether the deletion was taken.
 */
function deleteByFormula(
  editor: MathEditor,
  view: EditorView,
  back: boolean,
  unit: Unit = 'character',
  target: () => readonly [number, number] | null = () => null,
): boolean {
  const { selection } = view.state;
  if (openSourceRange(editor, selection.$from) !== null) return deleteInSource(editor, view, back, unit);
  const { $cursor } = selection as TextSelection;
  // A range is widened over hidden sources already; a selected, closed block
  // formula is the library's to delete.
  if (!$cursor || isFormula($cursor.parent)) return false;
  if (unit === 'character') {
    // Beside an inline formula: into its source, deleting nothing unseen.
    const beside = back ? $cursor.nodeBefore : $cursor.nodeAfter;
    if (beside !== null && isFormula(beside) && beside.isInline) {
      const into = back ? $cursor.pos - 1 : $cursor.pos + 1;
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, into)));
      return true;
    }
  }
  const formula = formulaBlockBeside($cursor, back);
  // A word or line deletion that cannot select it would join the line into its hidden source.
  if (formula !== null) return selectFormula(editor, $cursor, formula, back) || unit !== 'character';
  if (unit === 'character') return false;
  // A paragraph deletion runs to the line's edge. The browser's own range for
  // it stops at the source box inside an inline formula, which it takes for a
  // paragraph's end.
  const range: readonly [number, number] | null =
    unit === 'paragraph' ? (back ? [$cursor.start(), $cursor.pos] : [$cursor.pos, $cursor.end()]) : target();
  return deleteOverFormulas(view, $cursor, range);
}

/**
 * The range a deletion the browser makes itself would take.
 * @param view - The editor view.
 * @param event - The `beforeinput` event.
 * @returns The range, or null when the event states none.
 */
function targetRange(view: EditorView, event: InputEvent): readonly [number, number] | null {
  const [range] = 'getTargetRanges' in event ? event.getTargetRanges() : [];
  if (range === undefined) return null;
  const from = view.posAtDOM(range.startContainer, range.startOffset);
  const to = view.posAtDOM(range.endContainer, range.endOffset);
  return from === to ? null : [Math.min(from, to), Math.max(from, to)];
}

/**
 * Enter or Shift+Enter in an inline formula's source confirms it: the caret
 * goes after the formula, the line is not split. BlockNote's own Enter there
 * does the same (`SourceInlineContentWithPreview.ts`); answered here because
 * the quote's, the list's and a stored cell's Enter would reach the key first.
 * @param view - The editor view.
 * @returns Whether the key was taken.
 */
function confirmInline(view: EditorView): boolean {
  const { $from } = view.state.selection;
  if ($from.parent.isTextblock || !isFormula($from.parent)) return false;
  view.dispatch(view.state.tr.setSelection(Selection.near(view.state.doc.resolve($from.after()), 1)));
  return true;
}

/**
 * ArrowLeft or ArrowRight across an inline formula's edge: out of its source
 * to right before or after the formula, and from right beside it into its
 * source. The open box draws the source away from the formula, so the
 * browser's own caret movement out of it lands one character past the
 * formula; BlockNote places the caret itself for the other keys that leave a
 * source (`moveSelectionOut` in `SourceInlineContentWithPreview.ts`).
 * @param view - The editor view.
 * @param forward - ArrowRight, else ArrowLeft.
 * @returns Whether the key was taken.
 */
function arrowByFormula(view: EditorView, forward: boolean): boolean {
  const { $cursor } = view.state.selection as TextSelection;
  if (!$cursor) return false;
  const { parent } = $cursor;
  let to: number | null = null;
  if (!parent.isTextblock && isFormula(parent)) {
    if (forward && $cursor.parentOffset === parent.content.size) to = $cursor.after();
    else if (!forward && $cursor.parentOffset === 0) to = $cursor.before();
  } else {
    const beside = forward ? $cursor.nodeAfter : $cursor.nodeBefore;
    if (beside !== null && beside.isInline && isFormula(beside)) {
      to = forward ? $cursor.pos + 1 : $cursor.pos - 1;
    }
  }
  if (to === null) return false;
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, to)));
  return true;
}

/**
 * The nearest text a selection end can stand on from a position, going one
 * way, that is no closed block formula's hidden source: such a source is
 * stepped over whole. The search stays inside the table cell around the
 * formula it starts from.
 * @param editor - The editor.
 * @param $from - Where the formula the end leaves starts its search.
 * @param pos - Where to search from.
 * @param dir - Which way.
 * @returns The position, or null when there is none inside.
 */
function visibleText(editor: MathEditor, $from: ResolvedPos, pos: number, dir: -1 | 1): number | null {
  const depth = Math.max(cellDepthOf($from), 0);
  const [low, high] = [$from.start(depth), $from.end(depth)];
  let at = pos;
  for (;;) {
    const found = Selection.findFrom($from.doc.resolve(at), dir, true);
    if (found === null || found.head < low || found.head > high) return null;
    if (closedFormulaBlockAt(editor, found.$head) === null) return found.head;
    at = dir < 0 ? found.$head.before(found.$head.depth - 1) : found.$head.after();
  }
}

/**
 * Where a selection end that reaches into a formula's hidden source from
 * outside it belongs, so the formula is in the range whole or not at all.
 * An inline formula: its edge on the side the end moves to. A closed block
 * formula, moving forward from before it: the end of its source, which
 * leaves the lines indented under it out; otherwise the nearest visible text
 * on the side the end moves to, or, with none in the cell, on the other.
 * @param editor - The editor.
 * @param end - The end that may be in a source.
 * @param other - The selection's other end.
 * @param way - The way the end moved; 0 when it did not, and it moves away from the other end.
 * @returns The position the end moves to, or null when it stays.
 */
function wholeFormulaEdge(editor: MathEditor, end: ResolvedPos, other: ResolvedPos, way: number): number | null {
  const { parent } = end;
  if (!isFormula(parent)) return null;
  if (!parent.isTextblock) {
    const start = end.before();
    const stop = end.after();
    if (other.pos > start && other.pos < stop) return null;
    return (way === 0 ? other.pos <= start : way > 0) ? stop : start;
  }
  if (closedFormulaBlockAt(editor, end) === null) return null;
  const from = end.start();
  const to = end.end();
  if (other.pos >= from && other.pos <= to) return null;
  const otherBefore = other.pos < from;
  /**
   * The visible text before the formula's line.
   * @returns Its position, or null.
   */
  const before = (): number | null => visibleText(editor, end, end.before(end.depth - 1), -1);
  /**
   * The visible text after the formula's own line, its indented lines first.
   * @returns Its position, or null.
   */
  const after = (): number | null => visibleText(editor, end, end.after(), 1);
  const target = (way === 0 ? otherBefore : way > 0)
    ? otherBefore ? to : after() ?? before()
    : before() ?? after();
  return target === end.pos ? null : target;
}

/**
 * Widens a selection that reaches into a formula's hidden source from
 * outside it to take in the whole formula. The source is hidden while the
 * box is closed, so a drag that stops on the drawn formula would otherwise
 * copy, cut or delete part of a source nobody can see. The head goes the way
 * it moved, so Shift+Arrow back over a formula shrinks the selection. A
 * selection that starts in an open source ends inside it, as one in a text
 * box does: Shift+Home there would otherwise reach the lines around it.
 * @param editor - The editor.
 * @returns The plugin.
 */
function wholeFormulaSelection(editor: MathEditor): Plugin {
  return new Plugin({
    key: new PluginKey('documentMathWholeSelection'),
    appendTransaction: (transactions, old, state) => {
      if (!transactions.some((tr) => tr.selectionSet || tr.docChanged)) return null;
      const { selection } = state;
      if (!(selection instanceof TextSelection) || selection.empty) return null;
      const held = openSourceRange(editor, selection.$anchor);
      if (held !== null) {
        const head = Math.min(Math.max(selection.head, held.start), held.end);
        return head === selection.head ? null : state.tr.setSelection(TextSelection.create(state.doc, selection.anchor, head));
      }
      let { anchor: oldAnchor, head: oldHead } = old.selection;
      for (const tr of transactions) {
        oldAnchor = tr.mapping.map(oldAnchor);
        oldHead = tr.mapping.map(oldHead);
      }
      const way = oldAnchor === selection.anchor ? Math.sign(selection.head - oldHead) : 0;
      const anchor = wholeFormulaEdge(editor, selection.$anchor, selection.$head, 0) ?? selection.anchor;
      const head = wholeFormulaEdge(editor, selection.$head, selection.$anchor, way) ?? selection.head;
      if (anchor === selection.anchor && head === selection.head) return null;
      return state.tr.setSelection(TextSelection.create(state.doc, anchor, head));
    },
  });
}

/**
 * Refuses what would write into a closed block formula's hidden source, and
 * a drop that lands in one; takes the browser's own deletions by a formula.
 * @param editor - The editor.
 * @returns The plugin.
 */
function formulaInput(editor: MathEditor): Plugin {
  /**
   * Whether the selection is in a closed block formula.
   * @param view - The editor view.
   * @returns True when it is.
   */
  const closed = (view: EditorView): boolean => {
    const { $from, $to } = view.state.selection;
    return editor.isEditable && $from.sameParent($to) && closedFormulaBlockAt(editor, $from) !== null;
  };
  return new Plugin({
    key: new PluginKey('documentMathClosedInput'),
    props: {
      handlePaste: (view): boolean => closed(view),
      handleDOMEvents: {
        beforeinput: (view, event): boolean => {
          if (!event.cancelable || !editor.isEditable) return false;
          if (!closed(view)) {
            const deletion = DELETION.exec((event as InputEvent).inputType);
            if (deletion === null) return false;
            const unit = UNITS[deletion[1]!]!;
            const back = deletion[2] === 'Backward';
            if (!deleteByFormula(editor, view, back, unit, () => targetRange(view, event as InputEvent))) return false;
          }
          event.preventDefault();
          return true;
        },
        drop: (view, event): boolean => {
          const at = view.posAtCoords({ left: event.clientX, top: event.clientY });
          if (at === null || !inHiddenSource(editor, view.state.doc.resolve(at.pos), view.state)) return false;
          event.preventDefault();
          return true;
        },
      },
    },
  });
}

/**
 * The extension that carries the rule, the keys and the refusals.
 * @returns The extension, for the assembly to register.
 */
export const documentMathEditingExtension = createExtension(({ editor }: { editor: MathEditor }) => {
  const rule = inputRule(editor);
  /**
   * The view, once the editor is mounted.
   * @returns It.
   */
  const view = (): EditorView => editor.prosemirrorView!;
  const mac = isMacOS();
  /**
   * A deletion key's handler.
   * @param back - Backward, else forward.
   * @param unit - How much it takes.
   * @returns The handler.
   */
  const remove =
    (back: boolean, unit: Unit): (() => boolean) =>
      (): boolean =>
        deleteByFormula(editor, view(), back, unit);
  return {
    key: 'document-math',
    runsBefore: ['document-enter', 'document-table-keys', 'documentSelectAll'],
    prosemirrorPlugins: [rule.plugin, formulaInput(editor), wholeFormulaSelection(editor)],
    // The chords the editor's own keymap deletes with (`DELETE_CHORDS_BASE`,
    // `DELETE_CHORDS_MAC`): its commands would reach past a source's edge first.
    keyboardShortcuts: {
      Backspace: () => rule.takeBack(view()) || deleteByFormula(editor, view(), true),
      'Shift-Backspace': () => rule.takeBack(view()) || deleteByFormula(editor, view(), true),
      Delete: remove(false, 'character'),
      'Shift-Delete': remove(false, 'character'),
      'Mod-Backspace': remove(true, mac ? 'line' : 'word'),
      'Mod-Delete': remove(false, mac ? 'line' : 'word'),
      ...(mac
        ? {
          'Ctrl-h': remove(true, 'character'),
          'Ctrl-d': remove(false, 'character'),
          'Alt-Backspace': remove(true, 'word'),
          'Ctrl-Alt-Backspace': remove(true, 'word'),
          'Alt-Delete': remove(false, 'word'),
          'Alt-d': remove(false, 'word'),
        }
        : {}),
      Enter: () => confirmInline(view()),
      'Shift-Enter': () => confirmInline(view()),
      ArrowRight: () => arrowByFormula(view(), true),
      ArrowLeft: () => arrowByFormula(view(), false),
    },
  } as never;
});
