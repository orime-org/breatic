// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import type { Editor } from '@tiptap/react';
import { Bold, Redo2, Undo2 } from 'lucide-react';
import * as React from 'react';

import { Button } from '@web/components/ui/button';
import { Separator } from '@web/components/ui/separator';
import { useTranslation } from '@web/i18n/use-translation';
import { cn } from '@web/lib/utils';
import { ToolButton } from '@web/spaces/document/document-tool-button';
import { MARK_TOOLS, BLOCK_TOOLS } from '@web/spaces/document/document-tools';
import type { DocumentHistoryState } from '@web/spaces/document/use-document-history';

interface DocumentToolbarProps {
  editor: Editor;
  /** Undo / redo availability. */
  history: DocumentHistoryState;
  /**
   * True for a viewer. Every control is disabled — read-only has to be enforced
   * here as well as on the editor body: `setEditable(false)` stops typing, but
   * a toolbar command is a programmatic dispatch and goes straight through it.
   * The server then drops the write, leaving that viewer looking at a private
   * fork of the document that no one else will ever see.
   */
  readOnly?: boolean;
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
 * Undo / redo — the only controls this slice adds.
 *
 * History lives in a Yjs undo manager that tracks only THIS client's
 * transactions, so undo rolls back your own edits and never reaches into a
 * co-editor's work. That is the whole reason it belongs to the collaboration
 * slice rather than to the editing one.
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
 * Document toolbar — undo and redo, then the formatting toggles.
 *
 * History comes in as a prop because it is read from the undo manager, not the
 * editor — see {@link DocumentHistoryState}.
 * @param root0 - Document toolbar props.
 * @param root0.editor - The editor whose state drives the toggles and which the tools act on.
 * @param root0.history - Undo / redo availability.
 * @param root0.readOnly - True for a viewer; every control is disabled.
 * @returns The document toolbar element.
 */
export const DocumentToolbar = React.memo(function DocumentToolbar({
  editor,
  history,
  readOnly = false,
}: DocumentToolbarProps): React.JSX.Element {
  // Whether each formatting control is live is decided by the control itself,
  // against the command it runs — see `ToolDef.canRun` and `ToolButton`. Undo
  // and redo are not part of that: their availability comes from the history
  // state, not from any selection.
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
        <ToolButton
          key={t.id}
          tool={t}
          editor={editor}
          carrier='toolbar'
          readOnly={readOnly}
        />
      ))}
      <Separator orientation='vertical' className='mx-1 h-6' />
      {BLOCK_TOOLS.map((t) => (
        <ToolButton
          key={t.id}
          tool={t}
          editor={editor}
          carrier='toolbar'
          readOnly={readOnly}
        />
      ))}
    </div>
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
      data-testid={`doc-toolbar-tool-${action.id}`}
      className={cn('h-7 w-7')}
    >
      <Icon className='h-4 w-4' />
    </Button>
  );
});
