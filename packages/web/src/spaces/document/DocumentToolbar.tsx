// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import type { Editor } from '@tiptap/react';
import { useEditorState } from '@tiptap/react';
import {
  Bold,
  Italic,
  List,
  ListOrdered,
  Quote,
  Redo2,
  Strikethrough,
  Undo2,
} from 'lucide-react';
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
   * True for a viewer. Every control is disabled — read-only has to be enforced
   * here as well as on the editor body: `setEditable(false)` stops typing, but
   * a toolbar command is a programmatic dispatch and goes straight through it.
   * The server then drops the write, leaving that viewer looking at a private
   * fork of the document that no one else will ever see.
   */
  readOnly?: boolean;
}

/** A toggle whose pressed state mirrors what is under the cursor. */
interface ToolDef {
  id: string;
  labelKey: string;
  Icon: typeof Bold;
  isActive: (e: Editor) => boolean;
  run: (e: Editor) => void;
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
 * The formatting controls. What they DO is untouched by this slice — the
 * editing feature set is separate work — and three things about how they do it
 * changed, each because the document is now shared:
 *
 * 1. They are disabled for a viewer. Before, nothing was: there was no viewer
 *    role to speak of, because the document was local to whoever opened it.
 * 2. Their pressed state is subscribed rather than read during render. A
 *    co-editor's change arrives with no React render behind it, so a value
 *    computed in the render body would show whatever was true last time this
 *    component happened to re-render.
 * 3. Their labels go through i18n, where they were hard-coded English. Undo and
 *    redo could not be hard-coded, and a toolbar half translated is worse than
 *    either.
 */
const MARK_TOOLS: ToolDef[] = [
  {
    id: 'bold',
    labelKey: 'spaces.document.toolbar.bold',
    Icon: Bold,
    isActive: (e) => e.isActive('bold'),
    run: (e) => e.chain().focus().toggleBold().run(),
  },
  {
    id: 'italic',
    labelKey: 'spaces.document.toolbar.italic',
    Icon: Italic,
    isActive: (e) => e.isActive('italic'),
    run: (e) => e.chain().focus().toggleItalic().run(),
  },
  {
    id: 'strike',
    labelKey: 'spaces.document.toolbar.strike',
    Icon: Strikethrough,
    isActive: (e) => e.isActive('strike'),
    run: (e) => e.chain().focus().toggleStrike().run(),
  },
];

/** Block-level formatting, likewise unchanged. */
const BLOCK_TOOLS: ToolDef[] = [
  {
    id: 'bullet-list',
    labelKey: 'spaces.document.toolbar.bulletList',
    Icon: List,
    isActive: (e) => e.isActive('bulletList'),
    run: (e) => e.chain().focus().toggleBulletList().run(),
  },
  {
    id: 'ordered-list',
    labelKey: 'spaces.document.toolbar.orderedList',
    Icon: ListOrdered,
    isActive: (e) => e.isActive('orderedList'),
    run: (e) => e.chain().focus().toggleOrderedList().run(),
  },
  {
    id: 'quote',
    labelKey: 'spaces.document.toolbar.quote',
    Icon: Quote,
    isActive: (e) => e.isActive('blockquote'),
    run: (e) => e.chain().focus().toggleBlockquote().run(),
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
        <ToolButton key={t.id} tool={t} editor={editor} disabled={readOnly} />
      ))}
      <Separator orientation='vertical' className='mx-1 h-6' />
      {BLOCK_TOOLS.map((t) => (
        <ToolButton key={t.id} tool={t} editor={editor} disabled={readOnly} />
      ))}
    </div>
  );
});

/**
 * A single toolbar toggle.
 *
 * Subscribes to just its own active flag rather than reading it during render.
 * That matters now the document is shared: a co-editor's change arrives as a
 * transaction with no React render behind it, so a value computed in the render
 * body would keep showing whatever was true when this component last happened
 * to re-render.
 * @param root0 - Tool button props.
 * @param root0.tool - The tool definition (label, icon, active predicate, run command).
 * @param root0.editor - The editor the tool reads from and acts on.
 * @param root0.disabled - True to render the toggle inert (viewer).
 * @returns The toggle button element for one document tool.
 */
const ToolButton = React.memo(function ToolButton({
  tool,
  editor,
  disabled = false,
}: {
  tool: ToolDef;
  editor: Editor;
  disabled?: boolean;
}): React.JSX.Element {
  const t = useTranslation();
  const active = useEditorState({
    editor,
    selector: ({ editor: e }) => (e ? tool.isActive(e) : false),
  });
  const Icon = tool.Icon;
  return (
    <Button
      variant={active ? 'secondary' : 'ghost'}
      size='icon'
      aria-label={t(tool.labelKey)}
      aria-pressed={active}
      disabled={disabled}
      onClick={() => tool.run(editor)}
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
