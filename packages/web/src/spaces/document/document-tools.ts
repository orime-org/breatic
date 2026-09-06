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

import { isMarkActive } from '@tiptap/core';
import { toggleMark } from '@tiptap/pm/commands';

import type { ToolDef, ToolEditor } from '@web/spaces/document/document-tool-button';

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
    // pressed state has meant since it shipped. `getActiveStyles()` reads the
    // marks at `$to` alone, so a half-styled selection answered one way when
    // the reader dragged left and the other way when they dragged right.
    isActive: (editor) => isMarkActive(editor.prosemirrorState, id),
    canRun: (editor) => {
      const run = command(editor);
      return run !== null && editor.canExec(run);
    },
    // Covering the whole selection is the other half of the same rule: over a
    // selection the style does not cover, a press puts it on rather than
    // taking it off the part that had it.
    run: (editor) => {
      editor.toggleStyles({ [id]: true } as never);
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

