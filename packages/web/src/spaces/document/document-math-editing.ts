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
 * | Backspace / Delete in an empty source | the formula goes |
 * | Backspace at the start of an open block formula's source | does nothing, or removes the formula when its source is empty |
 * | Enter in an inline source | confirms, the caret after the formula, whatever block the line is |
 * | Escape in an open box | takes back what was typed since it opened and closes it |
 * | ArrowLeft / ArrowRight across an inline formula's edge | the caret goes into its source, or out to right beside the formula |
 * | input into a selected, closed block formula | refused: its source is hidden |
 * | a selection reaching into an inline source from outside | widened to the whole formula |
 *
 * The keys run ahead of `document-enter` and `document-table-keys`, which
 * would otherwise split a quoted line or answer a table cell's edge first.
 * Only a `$` from `handleTextInput` arms the rule (`prosemirror-inputrules`
 * 1.5.1 `index.js:74-85` judges there too), so the text an undo, a redo or a
 * co-editor brings back is never converted again.
 */

import { createExtension, type BlockNoteEditor } from '@blocknote/core';
import { SourceBlockWithPreviewExtension } from '@blocknote/core/extensions';
import type { ResolvedPos } from '@tiptap/pm/model';
import { Plugin, PluginKey, Selection, TextSelection, type EditorState } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';

import { cancelOpenFormula, MATH_INLINE } from '@web/spaces/document/document-math';
import { markOwnUndoStep } from '@web/spaces/document/document-undo-step';

/** The editor as this file uses it. */
type MathEditor = BlockNoteEditor<never, never, never>;

/**
 * A closing `$$` and what it encloses at the end of the text before the
 * caret: not preceded by `\` or `$`, no white space right inside either pair.
 * `￼` stands for any inline node, which a source cannot hold.
 */
const CLOSED_FORMULA = /(?<![\\$])\$\$([^\s$￼](?:[^$\n￼]*[^\s$￼])?)\$\$$/;

/**
 * Whether a node type draws a preview with its source in a box.
 * @param editor - The editor.
 * @param name - The node type's name.
 * @returns True for a formula, block or inline.
 */
function hasPreview(editor: MathEditor, name: string): boolean {
  const schema = editor.schema as unknown as {
    blockSpecs: Record<string, { implementation?: { meta?: { hasPreview?: boolean } } } | undefined>;
    inlineContentSpecs: Record<string, { implementation?: { meta?: { hasPreview?: boolean } } } | undefined>;
  };
  return (
    schema.blockSpecs[name]?.implementation?.meta?.hasPreview === true ||
    schema.inlineContentSpecs[name]?.implementation?.meta?.hasPreview === true
  );
}

/**
 * The id of the block formula whose hidden source a position is in, when its
 * box is closed.
 * @param editor - The editor.
 * @param $pos - The position.
 * @returns The block's id, or null when the position is not in a closed one.
 */
export function closedFormulaBlockAt(editor: MathEditor, $pos: ResolvedPos): string | null {
  const { parent } = $pos;
  if (!parent.isTextblock || $pos.depth < 1 || !hasPreview(editor, parent.type.name)) return null;
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
  if ($pos.parent.isTextblock || !hasPreview(editor, $pos.parent.type.name)) return false;
  return !state.selection.$from.sameParent($pos);
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
 * Backspace or Delete by a formula.
 * @param editor - The editor.
 * @param view - The editor view.
 * @param back - Backspace, else Delete.
 * @returns Whether the key was taken.
 */
function deleteByFormula(editor: MathEditor, view: EditorView, back: boolean): boolean {
  const { $cursor } = view.state.selection as TextSelection;
  if (!$cursor) return false;
  const { parent } = $cursor;
  // In an inline formula's source.
  if (!parent.isTextblock && hasPreview(editor, parent.type.name)) {
    if (parent.content.size === 0) return removeInline(view, $cursor);
    // At the start, Backspace has nothing of the source to delete and would
    // reach the line around the formula.
    return back && $cursor.parentOffset === 0;
  }
  // Beside an inline formula: into its source, deleting nothing unseen.
  const beside = back ? $cursor.nodeBefore : $cursor.nodeAfter;
  if (beside !== null && hasPreview(editor, beside.type.name) && beside.isInline) {
    const into = back ? $cursor.pos - 1 : $cursor.pos + 1;
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, into)));
    return true;
  }
  // At the start of an open block formula's source.
  if (back && $cursor.parentOffset === 0 && parent.isTextblock && hasPreview(editor, parent.type.name)) {
    const id = $cursor.node($cursor.depth - 1).attrs['id'] as string;
    if (editor.getExtension(SourceBlockWithPreviewExtension)?.store.state.popupOpen !== id) return false;
    if (parent.content.size === 0) editor.removeBlocks([id]);
    return true;
  }
  return false;
}

/**
 * Enter or Shift+Enter in an inline formula's source confirms it: the caret
 * goes after the formula, the line is not split. BlockNote's own Enter there
 * does the same (`SourceInlineContentWithPreview.ts`); answered here because
 * the quote's, the list's and a stored cell's Enter would reach the key first.
 * @param editor - The editor.
 * @param view - The editor view.
 * @returns Whether the key was taken.
 */
function confirmInline(editor: MathEditor, view: EditorView): boolean {
  const { $from } = view.state.selection;
  if ($from.parent.isTextblock || !hasPreview(editor, $from.parent.type.name)) return false;
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
 * @param editor - The editor.
 * @param view - The editor view.
 * @param forward - ArrowRight, else ArrowLeft.
 * @returns Whether the key was taken.
 */
function arrowByFormula(editor: MathEditor, view: EditorView, forward: boolean): boolean {
  const { $cursor } = view.state.selection as TextSelection;
  if (!$cursor) return false;
  const { parent } = $cursor;
  let to: number | null = null;
  if (!parent.isTextblock && hasPreview(editor, parent.type.name)) {
    if (forward && $cursor.parentOffset === parent.content.size) to = $cursor.after();
    else if (!forward && $cursor.parentOffset === 0) to = $cursor.before();
  } else {
    const beside = forward ? $cursor.nodeAfter : $cursor.nodeBefore;
    if (beside !== null && beside.isInline && hasPreview(editor, beside.type.name)) {
      to = forward ? $cursor.pos + 1 : $cursor.pos - 1;
    }
  }
  if (to === null) return false;
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, to)));
  return true;
}

/**
 * Where a selection end that reaches into an inline formula's source from
 * outside it belongs: on the far edge of the formula, so the whole formula is
 * in the range.
 * @param editor - The editor.
 * @param end - The end that may be in a source.
 * @param other - The selection's other end.
 * @returns The position the end moves to, or null when it stays.
 */
function wholeFormulaEdge(editor: MathEditor, end: ResolvedPos, other: ResolvedPos): number | null {
  const { parent } = end;
  if (parent.isTextblock || !hasPreview(editor, parent.type.name)) return null;
  const start = end.before();
  const stop = end.after();
  if (other.pos > start && other.pos < stop) return null;
  return other.pos <= start ? stop : start;
}

/**
 * Widens a selection that reaches into an inline formula's source from
 * outside it to take in the whole formula. The source is hidden while the
 * box is closed, so a drag that stops on the drawn formula would otherwise
 * copy, cut or delete part of a source nobody can see.
 * @param editor - The editor.
 * @returns The plugin.
 */
function wholeFormulaSelection(editor: MathEditor): Plugin {
  return new Plugin({
    key: new PluginKey('documentMathWholeSelection'),
    appendTransaction: (transactions, _old, state) => {
      if (!transactions.some((tr) => tr.selectionSet || tr.docChanged)) return null;
      const { selection } = state;
      if (!(selection instanceof TextSelection) || selection.empty) return null;
      const anchor = wholeFormulaEdge(editor, selection.$anchor, selection.$head) ?? selection.anchor;
      const head = wholeFormulaEdge(editor, selection.$head, selection.$anchor) ?? selection.head;
      if (anchor === selection.anchor && head === selection.head) return null;
      return state.tr.setSelection(TextSelection.create(state.doc, anchor, head));
    },
  });
}

/**
 * Refuses what would write into a closed block formula's hidden source, and
 * a drop that lands in one.
 * @param editor - The editor.
 * @returns The plugin.
 */
function closedInput(editor: MathEditor): Plugin {
  /**
   * Whether the selection is in a closed block formula.
   * @param view - The editor view.
   * @returns True when it is.
   */
  const closed = (view: EditorView): boolean =>
    editor.isEditable && closedFormulaBlockAt(editor, view.state.selection.$from) !== null;
  return new Plugin({
    key: new PluginKey('documentMathClosedInput'),
    props: {
      handlePaste: (view): boolean => closed(view),
      handleDOMEvents: {
        beforeinput: (view, event): boolean => {
          if (!event.cancelable || !closed(view)) return false;
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
  return {
    key: 'document-math',
    runsBefore: [
      'document-enter',
      'document-table-keys',
      'documentSelectAll',
      // Escape takes back what was typed before BlockNote's own Escape closes the box.
      'sourceBlockWithPreview',
      'sourceInlineContentWithPreview',
    ],
    prosemirrorPlugins: [rule.plugin, closedInput(editor), wholeFormulaSelection(editor)],
    keyboardShortcuts: {
      Backspace: () => rule.takeBack(view()) || deleteByFormula(editor, view(), true),
      Delete: () => deleteByFormula(editor, view(), false),
      Enter: () => confirmInline(editor, view()),
      'Shift-Enter': () => confirmInline(editor, view()),
      Escape: () => cancelOpenFormula(editor),
      ArrowRight: () => arrowByFormula(editor, view(), true),
      ArrowLeft: () => arrowByFormula(editor, view(), false),
    },
  } as never;
});
