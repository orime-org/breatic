// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The formatting commands, and nothing about where they are shown.
 *
 * They live apart from any carrier so that the block handle menu and the
 * insert menu can reach them without importing the selection bubble bar. The
 * ruling routes a command by the object it acts on (menu-system ruling §9.1 —
 * one object may have several entry points), so more than one carrier will
 * legitimately show some of these; kept inside one of them, the others would
 * carry a dependency that does not exist. No carrier owns the commands.
 *
 * What these commands DO is untouched by the document slices — the editing
 * feature set is separate work — and three things about how they do it changed
 * when the document became shared:
 *
 * 1. A viewer never reaches them: the bubble bar is the only thing that shows
 *    them today, and it renders nothing at all for a viewer. Before, everyone
 *    who opened the document could use them, because it was theirs alone.
 * 2. Their pressed state is subscribed rather than read during render. A
 *    co-editor's change arrives with no React render behind it, so a value
 *    computed in the render body would show whatever was true last time the
 *    button happened to re-render.
 * 3. Their labels go through i18n, where they were hard-coded English.
 */

import {
  Bold,
  Code,
  Italic,
  Strikethrough,
  Underline,
} from 'lucide-react';

import { toggleMark } from '@tiptap/pm/commands';
import { TextSelection } from '@tiptap/pm/state';

import {
  readStyle,
  styleReading,
  trimmedRange,
  type StyleReading,
} from '@web/spaces/document/document-style-range';
import type { ToolDef, ToolEditor } from '@web/spaces/document/document-tool-button';

/**
 * Pulls the selection in to `trimmedRange`.
 *
 * Only for a press that ADDS the style. Taking one off covers exactly what the
 * reader highlighted, which is what leaves a styled word and the space after
 * it in one press.
 *
 * Exported for the colour panel, whose cells add a style the same way
 * (`document-colour-run.ts`).
 * @param editor - The editor whose selection to pull in.
 */
export function trimEdges(editor: ToolEditor): void {
  editor.transact((tr) => {
    const { from, to } = trimmedRange(tr.doc, tr.selection);
    if (from === tr.selection.from && to === tr.selection.to) {
      return;
    }
    tr.setSelection(TextSelection.create(tr.doc, from, to));
  });
}

/**
 * How one of the five marks reads off a run: it is on, or it is not.
 * @param editor - The editor, for its schema.
 * @param id - The mark's name.
 * @returns The reading, or nothing where this build has no such mark.
 */
function markReading(
  editor: ToolEditor,
  id: string,
): StyleReading<boolean> | undefined {
  return styleReading(
    editor.prosemirrorState,
    id,
    (marks) => marks.some((mark) => mark.type.name === id),
    false,
    false,
  );
}

/**
 * The five inline tools are named after the five styles the schema declares,
 * which is what lets the pressed state read straight off the selection.
 * @param id - The tool's id, which is also the style's name.
 * @returns The three answers a tool owes, wired to that style.
 */
function styleTool(id: string): Pick<ToolDef, 'isActive' | 'canRun' | 'run'> {
  /**
   * The ProseMirror command behind this style.
   * @param editor - The editor to read the schema off.
   * @returns The command, or null when this build has no such mark.
   */
  const command = (editor: ToolEditor): ReturnType<typeof toggleMark> | null => {
    const mark = editor.pmSchema.marks[id];
    return mark === undefined ? null : toggleMark(mark);
  };
  return {
    // Whether the WHOLE selection carries it, which is what the button's
    // pressed state has meant since it shipped, read the way
    // `document-style-range.ts` sets out: the space a drag picked up carries
    // no style and is not what the reader is asking about. Judged with that
    // space counted, the button read OFF over a word it had just styled, and
    // the press then trimmed onto the word and took the style back off.
    isActive: (editor) => {
      const reading = markReading(editor, id);
      return (
        reading !== undefined &&
        readStyle(editor.prosemirrorState, reading).value === true
      );
    },
    // Whether a press would land anything, judged the way the colour panel
    // greys itself. `canExec` asks only whether the block allows the mark
    // type, never what the runs already carry, so it drew these live over a
    // stretch of inline code — whose `excludes` is every other mark — and the
    // press left the document byte-identical (R7).
    canRun: (editor) => {
      const reading = markReading(editor, id);
      if (reading === undefined) {
        return false;
      }
      const across = readStyle(editor.prosemirrorState, reading);
      // A press over a selection the style is on REMOVES it, which covers the
      // whole highlight and needs no room for a new mark. Judged on the add
      // range alone, a button could be drawn pressed and unavailable at once.
      if (across.value === true) {
        return true;
      }
      const run = command(editor);
      return run !== null && editor.canExec(run) && across.addReaches;
    },
    // Which way a press goes is the button's own reading, spelled out rather
    // than left to `toggleStyles`. That decides for itself, counting every
    // run — including the unstyled space between two styled words, which the
    // button skips — so a lit button handed to it grew the style onto that
    // space and stayed lit, and the style took two presses to come off.
    //
    // Covering the whole selection is the other half of the same rule: over a
    // selection the style does not cover, a press puts it on rather than
    // taking it off the part that had it.
    run: (editor) => {
      const reading = markReading(editor, id);
      const on =
        reading !== undefined &&
        readStyle(editor.prosemirrorState, reading).value === true;
      if (on) {
        editor.removeStyles({ [id]: true } as never);
        return;
      }
      trimEdges(editor);
      editor.addStyles({ [id]: true } as never);
    },
  };
}

/** The four marks the demo groups together as `B I S U`. */
export const MARK_TOOLS: ToolDef[] = [
  {
    id: 'bold',
    labelKey: 'spaces.document.commands.bold',
    Icon: Bold,
    ...styleTool('bold'),
  },
  {
    id: 'italic',
    labelKey: 'spaces.document.commands.italic',
    Icon: Italic,
    ...styleTool('italic'),
  },
  {
    id: 'strike',
    labelKey: 'spaces.document.commands.strike',
    Icon: Strikethrough,
    ...styleTool('strike'),
  },
  {
    id: 'underline',
    labelKey: 'spaces.document.commands.underline',
    Icon: Underline,
    ...styleTool('underline'),
  },
];

/**
 * The group the demo draws between `B I S U` and the AI entry.
 *
 * Inline code sits here rather than beside the other marks because that is
 * where the demo puts it (`§3.3` reads `B I S U │ link code A∨ comment`).
 * Neither the demo nor the design says why, so this comment does not invent a
 * reason: the grouping is the decision, and the slices that follow fill the
 * group out with the link control and the colour picker.
 */
export const INLINE_TOOLS: ToolDef[] = [
  {
    id: 'code',
    labelKey: 'spaces.document.commands.code',
    Icon: Code,
    ...styleTool('code'),
  },
];

