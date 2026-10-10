// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * One command, rendered as a toggle — and the definition its carrier reads.
 *
 * This lives apart from the bubble bar so that the block handle menu and the
 * insert menu can reach the same definitions without importing it. The routing
 * that decides which carrier shows a command is the object it acts on
 * (menu-system ruling §9.1 — one object may have several entry points; what a
 * command must NOT do is appear in a carrier whose object differs from its
 * own).
 *
 * The test id names the carrier as well as the command, because the same
 * definitions are meant to be reachable from more than one place — a query for
 * a command has to say which carrier it means, and a second carrier rendering
 * this component would have to bring its own prefix.
 *
 * These buttons come and go with the selection. `SelectionBubbleBar` renders
 * them only while one exists, because each of them dry-runs its command on
 * every transaction and the bar spends almost all of its life away.
 */

import * as React from 'react';
import type { BlockNoteEditor } from '@blocknote/core';
import type { Bold } from 'lucide-react';

import { Button } from '@web/components/ui/button';
import { cn } from '@web/lib/utils';
import { useDocumentProjectId } from '@web/spaces/document/document-project-context';
import { useEditorSnapshot } from '@web/spaces/document/use-editor-snapshot';
import { useTranslation } from '@web/i18n/use-translation';

/**
 * The height every control on the bar shares.
 *
 * Sitting over the text, they are a notch shorter than a free-standing
 * button: the demo's `.bubble-btn` (`2026-08-21-editor-command-surface.html`)
 * is 28 tall, the `--btn-inline` rung, where a chrome button is 32.
 */
export const BUBBLE_CONTROL_HEIGHT = 'h-[var(--btn-inline)]';

/** The height above plus the 28 the same demo rule gives an icon button. */
export const BUBBLE_ICON_BUTTON_SIZE = `${BUBBLE_CONTROL_HEIGHT} w-7`;

/**
 * A pressed button on a bar over the body: the fill every chosen option in
 * the product reads in (the theme menu's current row), held through hover so
 * pointing at it does not take the mark away.
 */
export const PRESSED_CLASS = 'bg-accent-strong hover:bg-accent-strong';

/**
 * The frame of a bar of these buttons floating over the body: the selection
 * bubble bar, and a media block's toolbar (inner#1127), which looks the same.
 */
export const BUBBLE_BAR_CLASS =
  'flex items-center gap-0.5 rounded-overlay border border-border bg-popover px-1.5 py-1 shadow-md';

/** The document editor, as far as a tool needs to know. */
export type ToolEditor = BlockNoteEditor<never, never, never>;

/** A toggle whose pressed state mirrors what is under the cursor. */
export interface ToolDef {
  id: string;
  labelKey: string;
  Icon: typeof Bold;
  isActive: (e: ToolEditor) => boolean;
  /**
   * Whether the style can go on the current selection.
   *
   * Answered off the runs the selection covers — `reachesAnyRun`, the same
   * walk `isActive` reads and `run` writes over, so the three cannot disagree.
   * R7 asks for one thing: no control that looks usable and does nothing when
   * pressed.
   */
  canRun: (e: ToolEditor) => boolean;
  /**
   * What pressing it does.
   * @param e - The editor.
   * @param projectId - The project the document is in, for a command that
   *   reaches outside the document; null or left out outside a project.
   */
  run: (e: ToolEditor, projectId?: string | null) => void;
  /**
   * Whether the button is on the bar at all, for a command that belongs to
   * one kind of selection only. Left out, it always is.
   */
  shownWhen?: (e: ToolEditor) => boolean;
  /**
   * True for a command that hands something to the project, which is not on
   * the bar where there is no project to hand it to.
   */
  needsProject?: boolean;
}

/**
 * The answer for a tool that is always on the bar.
 * @returns True.
 */
function alwaysShown(): boolean {
  return true;
}

/**
 * A single command button.
 * @param root0 - Button props.
 * @param root0.tool - The command definition.
 * @param root0.editor - The editor the command acts on.
 * @returns The button element.
 */
export const ToolButton = React.memo(function ToolButton({
  tool,
  editor,
}: {
  tool: ToolDef;
  editor: ToolEditor;
}): React.JSX.Element | null {
  const t = useTranslation();
  // Both answers are scalars, so identity is the right comparison and the
  // default one.
  const active = useEditorSnapshot(editor, tool.isActive);
  const available = useEditorSnapshot(editor, tool.canRun);
  const shown = useEditorSnapshot(editor, tool.shownWhen ?? alwaysShown);
  const projectId = useDocumentProjectId();
  const state = { active, available };
  const Icon = tool.Icon;
  if (!shown || (tool.needsProject === true && projectId === null)) return null;
  return (
    <Button
      variant='ghost'
      size='icon'
      aria-label={t(tool.labelKey)}
      aria-pressed={state.active}
      disabled={!state.available}
      onClick={() => tool.run(editor, projectId)}
      data-testid={`doc-bubble-tool-${tool.id}`}
      // The bar stays out of the tab order entirely (ruling §5.2): it floats
      // over the body, and anything floating over the body that takes focus
      // collides with the body's own focus. The keyboard route to these
      // commands is their shortcuts.
      tabIndex={-1}
      className={cn(BUBBLE_ICON_BUTTON_SIZE, state.active && PRESSED_CLASS)}
    >
      <Icon className='h-4 w-4' />
    </Button>
  );
});
