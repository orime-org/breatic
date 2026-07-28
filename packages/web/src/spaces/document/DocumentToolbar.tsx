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
import type * as React from 'react';

import { Button } from '@web/components/ui/button';
import { Separator } from '@web/components/ui/separator';
import { useTranslation } from '@web/i18n/use-translation';
import { cn } from '@web/lib/utils';
import { useDocumentHistory } from '@web/spaces/document/use-document-history';

interface DocumentToolbarProps {
  editor: Editor;
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
  run: (e: Editor) => void;
}

/**
 * Undo / redo.
 *
 * History lives in the Collaboration extension's Yjs undo manager, which tracks
 * only THIS client's transactions — so undo rolls back your own edits and never
 * reaches into a co-editor's work.
 *
 * Keyboard shortcuts come from that same extension and already cover both
 * platforms: `Mod-z` (undo), `Mod-y` and `Shift-Mod-z` (redo), where `Mod`
 * resolves to Cmd on macOS and Ctrl on Windows.
 */
const HISTORY_TOOLS: ActionDef[] = [
  {
    id: 'undo',
    labelKey: 'spaces.document.toolbar.undo',
    Icon: Undo2,
    run: (e) => e.chain().focus().undo().run(),
  },
  {
    id: 'redo',
    labelKey: 'spaces.document.toolbar.redo',
    Icon: Redo2,
    run: (e) => e.chain().focus().redo().run(),
  },
];

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
 * Document toolbar — history, then mark and block toggles.
 *
 * Toggles subscribe to the editor for their own slice of state, so each tracks
 * the live selection instead of freezing at mount. History is read from the undo
 * manager instead (see {@link useDocumentHistory}) — its stacks are not part of
 * the editor state and settle after the transaction that changes them.
 * @param root0 - Document toolbar props.
 * @param root0.editor - The editor whose state drives the buttons and which the tools act on.
 * @returns The document toolbar element.
 */
export function DocumentToolbar({
  editor,
}: DocumentToolbarProps): React.JSX.Element {
  const { canUndo, canRedo } = useDocumentHistory(editor);
  const historyEnabled: Record<string, boolean> = {
    undo: canUndo,
    redo: canRedo,
  };
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
          enabled={historyEnabled[t.id] ?? false}
        />
      ))}
      <Separator orientation='vertical' className='mx-1 h-6' />
      {MARK_TOOLS.map((t) => (
        <ToolButton key={t.id} tool={t} editor={editor} />
      ))}
      <Separator orientation='vertical' className='mx-1 h-6' />
      {BLOCK_TOOLS.map((t) => (
        <ToolButton key={t.id} tool={t} editor={editor} />
      ))}
    </div>
  );
}

/**
 * A single toolbar toggle. Subscribes to just its own active flag, so it
 * re-renders when the cursor moves in or out of its mark / block and stays put
 * otherwise.
 * @param root0 - Tool button props.
 * @param root0.tool - The tool definition (label, icon, active predicate, run command).
 * @param root0.editor - The editor the tool reads from and acts on.
 * @returns The toggle button element for one document tool.
 */
function ToolButton({
  tool,
  editor,
}: {
  tool: ToolDef;
  editor: Editor;
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
      onClick={() => tool.run(editor)}
      data-testid={`doc-tool-${tool.id}`}
      className={cn('h-7 w-7')}
    >
      <Icon className='h-4 w-4' />
    </Button>
  );
}

/**
 * A single toolbar action, enabled or disabled by the caller.
 * @param root0 - Action button props.
 * @param root0.action - The action definition (label, icon, run command).
 * @param root0.editor - The editor the action acts on.
 * @param root0.enabled - Whether the action is currently available.
 * @returns The action button element.
 */
function ActionButton({
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
}
