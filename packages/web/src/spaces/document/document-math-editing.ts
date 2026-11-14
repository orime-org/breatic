// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Typing and keys around a formula (inner#1423 design §6.4, §6.5).
 *
 * A formula holds no text of the body, so the body's caret, selections and
 * deletions only ever take it whole. The keys here open its box or select it:
 *
 * | what | how |
 * |---|---|
 * | `$$x$$` | the closing `$` lands as text; a `$` that came through `handleTextInput` arms the rule, and the conversion follows in a transaction of its own, its own undo step |
 * | Backspace right after converting | turns it back into the text `$$x$$` |
 * | ArrowLeft or Backspace right after an inline formula, ArrowRight or Delete right before one | opens its box, the caret at the end or the start of its source |
 * | Backspace at the start of the line after a block formula, Delete at the end of the line before one, in reading order, a word or line deletion too | selects the formula whole; the next press deletes it; from an empty line, the line goes first |
 * | Enter on a selected block formula | opens its box |
 *
 * The keys run ahead of `document-enter`, `document-table-keys` and the
 * select-all guard, which would otherwise answer a quoted line, a table
 * cell's edge or a deletion first. A deletion the browser makes from a
 * binding of its own (Ctrl+K) never reaches a keymap, so `beforeinput` takes
 * those beside a block formula the same way, and a line deletion across an
 * inline formula is made here. Only a `$` from
 * `handleTextInput` arms the rule (`prosemirror-inputrules` 1.5.1
 * `index.js:74-85` judges there too), so the text an undo, a redo or a
 * co-editor brings back is never converted again.
 */

import { createExtension, type BlockNoteEditor } from '@blocknote/core';
import { isMacOS } from '@tiptap/core';
import type { Node as PMNode, ResolvedPos } from '@tiptap/pm/model';
import { NodeSelection, Plugin, PluginKey, TextSelection, type EditorState } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';

import { MATH_BLOCK, MATH_INLINE, openFormulaAt, removeFormulaBlock } from '@web/spaces/document/document-math';
import { markOwnUndoStep } from '@web/spaces/document/document-undo-step';

/** The editor as this file uses it. */
type MathEditor = BlockNoteEditor<never, never, never>;

/** The deletions `beforeinput` states with a direction. */
const DELETION = /^delete(Content|Word|SoftLine|HardLine)(Backward|Forward)$/;

/**
 * A closing `$$` and what it encloses at the end of the text before the
 * caret: not preceded by `\` or `$`, no white space right inside either pair.
 * `￼` stands for any inline node, which a source cannot hold.
 */
const CLOSED_FORMULA = /(?<![\\$])\$\$([^\s$￼](?:[^$\n￼]*[^\s$￼])?)\$\$$/;


/** A conversion just made, which a Backspace right after takes back. */
interface Converted {
  readonly from: number;
  readonly to: number;
  readonly text: string;
  readonly after: EditorState;
}

/**
 * Whether the conversion is still the last thing that happened: nothing has
 * changed the text or moved the caret since. A collaborator's caret moving
 * sends transactions that change neither.
 * @param last - The conversion.
 * @param state - The editor state now.
 * @returns True while it is.
 */
function stillLast(last: Converted, state: EditorState): boolean {
  return last.after.doc === state.doc && last.after.selection.eq(state.selection);
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
    const node = type.create({ source: match[1]! });
    const tr = state.tr.replaceWith(from, $cursor.pos, node);
    tr.setSelection(TextSelection.create(tr.doc, from + node.nodeSize));
    view.dispatch(markOwnUndoStep(tr));
    converted = { from, to: from + node.nodeSize, text: match[0], after: view.state };
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
        if (converted !== null && !stillLast(converted, view.state)) converted = null;
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
      if (last === null || !stillLast(last, view.state)) return false;
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
 * Opens the box of an inline formula right beside the caret, as the arrow
 * keys and Backspace / Delete step into its source (Notion).
 * @param view - The editor view.
 * @param back - Toward the formula before the caret, else after it.
 * @returns Whether there was one.
 */
function openBeside(view: EditorView, back: boolean): boolean {
  const { $cursor } = view.state.selection as TextSelection;
  if (!$cursor) return false;
  const beside = back ? $cursor.nodeBefore : $cursor.nodeAfter;
  if (beside === null || beside.type.name !== MATH_INLINE) return false;
  return openFormulaAt(view, back ? $cursor.pos - beside.nodeSize : $cursor.pos, back ? 'end' : 'start');
}

/**
 * Deletes a block formula selected whole, whatever the deletion: the lines
 * indented under it come up into its place, and the lines around it stay
 * apart.
 * @param editor - The editor.
 * @param view - The editor view.
 * @param back - Backward, else forward.
 * @returns Whether a formula was selected whole.
 */
function removeSelected(editor: MathEditor, view: EditorView, back: boolean): boolean {
  const { selection } = view.state;
  if (!(selection instanceof NodeSelection) || selection.node.type.name !== MATH_BLOCK) return false;
  removeFormulaBlock(editor, view, selection.from, back);
  return true;
}

/**
 * A deletion beside a formula, from a key or from the browser's `beforeinput`:
 * a block formula selected whole goes; a character deletion right beside an
 * inline formula opens its box; any deletion at a line's edge that would
 * reach a block formula selects it.
 * @param editor - The editor.
 * @param view - The editor view.
 * @param back - Backward, else forward.
 * @param character - Whether it takes one character, else a word or a line.
 * @returns Whether the deletion was taken.
 */
function deleteBeside(editor: MathEditor, view: EditorView, back: boolean, character: boolean): boolean {
  if (removeSelected(editor, view, back)) return true;
  const { $cursor } = view.state.selection as TextSelection;
  if (!$cursor) return false;
  if (character && openBeside(view, back)) return true;
  const formula = formulaBlockBeside($cursor, back);
  // A word or line deletion that cannot select it would join the line into it.
  return formula !== null && (selectFormula(editor, $cursor, formula, back) || !character);
}

/**
 * Enter on a selected block formula opens its box.
 * @param state - The editor state.
 * @param view - The editor view.
 * @returns Whether the key was taken.
 */
function openSelected(state: EditorState, view: EditorView): boolean {
  const { selection } = state;
  if (!(selection instanceof NodeSelection) || selection.node.type.name !== MATH_BLOCK) return false;
  return openFormulaAt(view, selection.from, 'end');
}

/**
 * Whether a stretch of the document holds an inline formula.
 * @param doc - The document.
 * @param from - Where the stretch starts.
 * @param to - Where it ends.
 * @returns True when it does.
 */
function holdsInlineFormula(doc: PMNode, from: number, to: number): boolean {
  let holds = false;
  doc.nodesBetween(from, to, (node) => {
    holds ||= node.type.name === MATH_INLINE;
    return !holds;
  });
  return holds;
}

/**
 * Deletes from the caret to the edge of its paragraph, or of its line on
 * screen, when an inline formula lies in that stretch. Chrome deletes only the
 * formula there (its target range ends past the paragraph); the line's edge
 * `Selection.modify` finds is right, as Lexical's `deleteLine` relies on.
 * @param view - The editor view.
 * @param forward - Toward the end, else the start.
 * @param paragraph - To the paragraph's edge, else the line's on screen.
 * @returns Whether it deleted.
 */
function deleteLine(view: EditorView, forward: boolean, paragraph: boolean): boolean {
  const { $cursor } = view.state.selection as TextSelection;
  if (!$cursor) return false;
  let edge = forward ? $cursor.end() : $cursor.start();
  if (paragraph) {
    // A line break inside the paragraph ends the deletion, as it does the browser's.
    $cursor.parent.forEach((child, offset) => {
      if (child.type.name !== 'hardBreak') return;
      const at = $cursor.start() + offset;
      if (forward && at >= $cursor.pos) edge = Math.min(edge, at);
      if (!forward && at < $cursor.pos) edge = Math.max(edge, at + child.nodeSize);
    });
  } else {
    const selection = view.dom.ownerDocument.getSelection();
    if (selection?.focusNode == null) return false;
    const { anchorNode, anchorOffset } = selection;
    selection.modify('extend', forward ? 'forward' : 'backward', 'lineboundary');
    const reached = view.posAtDOM(selection.focusNode, selection.focusOffset);
    selection.collapse(anchorNode, anchorOffset);
    edge = Math.min(Math.max(reached, $cursor.start()), $cursor.end());
  }
  const from = Math.min($cursor.pos, edge);
  const to = Math.max($cursor.pos, edge);
  if (!holdsInlineFormula(view.state.doc, from, to)) return false;
  view.dispatch(view.state.tr.delete(from, to).scrollIntoView());
  return true;
}

/**
 * Takes the browser's own deletions at a line's edge beside a block formula,
 * its line deletions across an inline formula, and an input method's start
 * over a selection that holds one.
 * @param editor - The editor.
 * @returns The plugin.
 */
function besideInput(editor: MathEditor): Plugin {
  return new Plugin({
    key: new PluginKey('documentMathBesideInput'),
    props: {
      handleDOMEvents: {
        // A composition over a selection that holds an inline formula starts
        // inside the formula's drawing, and Chrome then drops what is composed;
        // the selection goes first, as typing over it takes it.
        compositionstart: (view): boolean => {
          const { from, to, empty } = view.state.selection;
          if (!empty && editor.isEditable && holdsInlineFormula(view.state.doc, from, to)) {
            view.dispatch(view.state.tr.deleteSelection());
          }
          return false;
        },
        beforeinput: (view, event): boolean => {
          const deletion = DELETION.exec((event as InputEvent).inputType);
          if (!event.cancelable || !editor.isEditable || deletion === null) return false;
          const back = deletion[2] === 'Backward';
          const { $cursor } = view.state.selection as TextSelection;
          if (removeSelected(editor, view, back)) {
            event.preventDefault();
            return true;
          }
          if (!$cursor) return false;
          if (formulaBlockBeside($cursor, back) !== null) deleteBeside(editor, view, back, false);
          else if (deletion[1] === 'Word' || deletion[1] === 'Content') return false;
          else if (!deleteLine(view, !back, deletion[1] === 'HardLine')) return false;
          event.preventDefault();
          return true;
        },
      },
    },
  });
}

/**
 * The extension that carries the rule and the keys.
 * @returns The extension, for the assembly to register.
 */
export const documentMathEditingExtension = createExtension(({ editor }: { editor: MathEditor }) => {
  const rule = inputRule(editor);
  /**
   * The view, once the editor is mounted.
   * @returns It.
   */
  const view = (): EditorView => editor.prosemirrorView!;
  /**
   * A deletion key's handler.
   * @param back - Backward, else forward.
   * @param character - Whether it takes one character.
   * @returns The handler.
   */
  const remove =
    (back: boolean, character: boolean): (() => boolean) =>
      (): boolean =>
        deleteBeside(editor, view(), back, character);
  // The deletion chords the editor's own keymap binds (`DELETE_CHORDS_BASE`,
  // `DELETE_CHORDS_MAC`): its commands would join the line into a formula first.
  return {
    key: 'document-math',
    runsBefore: ['document-enter', 'document-table-keys', 'documentSelectAll'],
    prosemirrorPlugins: [rule.plugin, besideInput(editor)],
    keyboardShortcuts: {
      Backspace: () => rule.takeBack(view()) || deleteBeside(editor, view(), true, true),
      'Shift-Backspace': remove(true, true),
      Delete: remove(false, true),
      // Cmd+Backspace and Cmd+Delete on Apple platforms delete to the edge of
      // the line on screen.
      'Mod-Backspace': () => remove(true, false)() || (isMacOS() && deleteLine(view(), false, false)),
      'Mod-Delete': () => remove(false, false)() || (isMacOS() && deleteLine(view(), true, false)),
      ...(isMacOS()
        ? {
          'Ctrl-h': remove(true, true),
          'Ctrl-d': remove(false, true),
          'Alt-Backspace': remove(true, false),
          'Ctrl-Alt-Backspace': remove(true, false),
          'Alt-Delete': remove(false, false),
        }
        : {}),
      Enter: () => openSelected(view().state, view()),
      ArrowLeft: () => openBeside(view(), true),
      ArrowRight: () => openBeside(view(), false),
    },
  } as never;
});
