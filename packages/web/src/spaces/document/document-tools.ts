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

import {
  everyRunCarries,
  markTypeOf,
  reachesAnyRun,
} from '@web/spaces/document/document-style-range';
import {
  dropStyles,
  putStyle,
} from '@web/spaces/document/document-style-write';
import type { ToolDef } from '@web/spaces/document/document-tool-button';

/**
 * The five inline tools are named after the five styles the schema declares,
 * which is what lets the pressed state read straight off the selection.
 * @param id - The tool's id, which is also the style's name.
 * @returns The three answers a tool owes, wired to that style.
 */
function styleTool(id: string): Pick<ToolDef, 'isActive' | 'canRun' | 'run'> {
  return {
    // Every run of text the selection covers has to carry it. `run` below
    // branches on this same call, so the button and the press cannot disagree.
    isActive: (editor) => {
      const mark = markTypeOf(editor.prosemirrorState, id);
      return (
        mark !== undefined && everyRunCarries(editor.prosemirrorState, mark)
      );
    },
    // Whether a press would reach anything, judged the way the colour panel
    // greys itself: one run of text the style could land on is enough. Over a
    // stretch of inline code — whose `excludes` is every other mark — there is
    // none, and the tool goes grey (R7).
    canRun: (editor) => {
      const mark = markTypeOf(editor.prosemirrorState, id);
      return mark !== undefined && reachesAnyRun(editor.prosemirrorState, mark);
    },
    // The direction comes off the same call `isActive` reads, and the write
    // covers the runs that same walk reaches — so the button, the press and
    // tiptap's own `isMarkActive`, which the Mod-b / Mod-i shortcuts branch
    // on, all answer for one set of runs.
    run: (editor) => {
      const mark = markTypeOf(editor.prosemirrorState, id);
      if (mark !== undefined && everyRunCarries(editor.prosemirrorState, mark)) {
        dropStyles(editor, id);
        return;
      }
      putStyle(editor, id, true);
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

