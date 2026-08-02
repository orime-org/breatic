// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import type { Editor } from '@tiptap/react';
import { Bold, Italic, Redo2, Strikethrough, Undo2 } from 'lucide-react';
import * as React from 'react';

import { Button } from '@web/components/ui/button';
import { Separator } from '@web/components/ui/separator';
import { useTranslation } from '@web/i18n/use-translation';
import { cn } from '@web/lib/utils';
import type { DocumentHistoryState } from '@web/spaces/document/use-document-history';

interface DocumentToolbarProps {
  editor: Editor;
  /** Undo / redo availability. */
  history: DocumentHistoryState;
  /**
   * True for a viewer. Every control is disabled, for two different reasons.
   *
   * Undo and redo MUST be: read-only has to be enforced here as well as on the
   * editor body, because `setEditable(false)` stops typing while a toolbar
   * command is a programmatic dispatch and goes straight through it. The server
   * then drops the write, leaving that viewer looking at a private fork of the
   * document that no one else will ever see.
   *
   * The formatting buttons run nothing yet, so nothing would escape either way;
   * they are disabled so that a viewer's toolbar looks uniformly unavailable,
   * which is the truth about their role.
   */
  readOnly?: boolean;
}

/**
 * A formatting button that is on screen but not yet connected to anything.
 *
 * It carries no command and no active predicate, because neither exists: the
 * marks are switched off in `document-extensions.ts`, and StarterKit's
 * `toggleBold` and friends go with them. Calling one would throw.
 */
interface MarkToolDef {
  id: string;
  labelKey: string;
  Icon: typeof Bold;
}

/** An action that is either available or not — history, in practice. */
interface ActionDef {
  id: string;
  labelKey: string;
  Icon: typeof Bold;
  /**
   * Reads its own availability off the history state. Kept on the definition
   * rather than looked up by id: a lookup that misses just yields `false`, so
   * a renamed id would disable the button permanently with every test still
   * green.
   */
  isEnabled: (history: DocumentHistoryState) => boolean;
  run: (e: Editor) => void;
}

/**
 * Undo / redo.
 *
 * History lives in a Yjs undo manager that tracks only THIS client's
 * transactions — so undo rolls back your own edits and never reaches into a
 * co-editor's work.
 *
 * Keyboard shortcuts come from the Collaboration extension and already cover
 * both platforms: `Mod-z` (undo), `Mod-y` and `Shift-Mod-z` (redo), where `Mod`
 * resolves to Cmd on macOS and Ctrl on Windows.
 */
const HISTORY_TOOLS: ActionDef[] = [
  {
    id: 'undo',
    labelKey: 'spaces.document.toolbar.undo',
    Icon: Undo2,
    isEnabled: (history) => history.canUndo,
    run: (e) => e.chain().focus().undo().run(),
  },
  {
    id: 'redo',
    labelKey: 'spaces.document.toolbar.redo',
    Icon: Redo2,
    isEnabled: (history) => history.canRedo,
    run: (e) => e.chain().focus().redo().run(),
  },
];

/**
 * Bold, italic, strike — present, and deliberately doing nothing.
 *
 * This slice delivers the collaborative surface: a body bound to Yjs, carets,
 * undo, persistence. Formatting is a separate body of work that arrives whole
 * in the next one — the marks, their toolbar, and the body stylesheet that
 * makes block formatting visible at all.
 *
 * The buttons stay on screen through that gap so the toolbar has its final
 * shape from the start, and the slice that adds formatting changes behaviour
 * rather than layout. They are NOT disabled: a greyed-out control already means
 * "you do not have permission" here — that is what a viewer sees — and reusing
 * that appearance for "not built yet" would leave two people looking at
 * identical toolbars for opposite reasons.
 */
const MARK_TOOLS: MarkToolDef[] = [
  {
    id: 'bold',
    labelKey: 'spaces.document.toolbar.bold',
    Icon: Bold,
  },
  {
    id: 'italic',
    labelKey: 'spaces.document.toolbar.italic',
    Icon: Italic,
  },
  {
    id: 'strike',
    labelKey: 'spaces.document.toolbar.strike',
    Icon: Strikethrough,
  },
];

/**
 * Document toolbar — undo and redo, then the formatting buttons.
 *
 * Undo and redo are the working half. History comes in as a prop because it is
 * read from the undo manager, not the editor — see {@link DocumentHistoryState}.
 *
 * The formatting buttons do nothing yet; {@link MARK_TOOLS} says why they are
 * on screen anyway.
 * @param root0 - Document toolbar props.
 * @param root0.editor - The editor undo and redo act on.
 * @param root0.history - Undo / redo availability.
 * @param root0.readOnly - True for a viewer; every control is disabled.
 * @returns The document toolbar element.
 */
export const DocumentToolbar = React.memo(function DocumentToolbar({
  editor,
  history,
  readOnly = false,
}: DocumentToolbarProps): React.JSX.Element {
  return (
    <div
      data-testid='document-toolbar'
      className='flex h-10 shrink-0 items-center gap-1 border-b border-border bg-background px-2'
    >
      {HISTORY_TOOLS.map((t) => (
        <ActionButton
          key={t.id}
          action={t}
          editor={editor}
          enabled={!readOnly && t.isEnabled(history)}
        />
      ))}
      <Separator orientation='vertical' className='mx-1 h-6' />
      {MARK_TOOLS.map((t) => (
        <ToolButton key={t.id} tool={t} disabled={readOnly} />
      ))}
    </div>
  );
});

/**
 * A single formatting button.
 *
 * It takes no editor and subscribes to nothing: with the marks switched off
 * there is no state for it to track and no command for it to run. A subscriber
 * that could only ever report `false` would be a claim this button reflects
 * something about the document, and it does not — see {@link MARK_TOOLS}.
 * @param root0 - Tool button props.
 * @param root0.tool - The tool definition (id, label, icon).
 * @param root0.disabled - True to render the button inert (viewer).
 * @returns The button element for one formatting tool.
 */
const ToolButton = React.memo(function ToolButton({
  tool,
  disabled = false,
}: {
  tool: MarkToolDef;
  disabled?: boolean;
}): React.JSX.Element {
  const t = useTranslation();
  const Icon = tool.Icon;
  return (
    <Button
      variant='ghost'
      size='icon'
      aria-label={t(tool.labelKey)}
      disabled={disabled}
      data-testid={`doc-tool-${tool.id}`}
      className={cn('h-7 w-7')}
    >
      <Icon className='h-4 w-4' />
    </Button>
  );
});

/**
 * A single toolbar action, enabled or disabled by the caller.
 * @param root0 - Action button props.
 * @param root0.action - The action definition (label, icon, run command).
 * @param root0.editor - The editor the action acts on.
 * @param root0.enabled - Whether the action is currently available.
 * @returns The action button element.
 */
const ActionButton = React.memo(function ActionButton({
  action,
  editor,
  enabled,
}: {
  action: ActionDef;
  editor: Editor;
  enabled: boolean;
}): React.JSX.Element {
  const t = useTranslation();
  const Icon = action.Icon;
  return (
    <Button
      variant='ghost'
      size='icon'
      aria-label={t(action.labelKey)}
      disabled={!enabled}
      onClick={() => action.run(editor)}
      data-testid={`doc-tool-${action.id}`}
      className={cn('h-7 w-7')}
    >
      <Icon className='h-4 w-4' />
    </Button>
  );
});
