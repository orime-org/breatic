// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import {
  Copy,
  CopyPlus,
  History,
  ImagePlus,
  Lock,
  Pencil,
  Sparkles,
  Trash2,
  Ungroup,
  Unlock,
  Upload,
  Wrench,
} from 'lucide-react';
import * as React from 'react';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from '@web/components/ui/dropdown-menu';
import { useTranslation } from '@web/i18n/use-translation';
import { formatShortcut } from '@web/spaces/canvas/format-shortcut';

interface NodeContextMenuProps {
  /** Whether the menu is open (driven by the canvas's node right-click handler). */
  open: boolean;
  /** Viewport x of the right-click; the menu anchors here. */
  x: number;
  /** Viewport y of the right-click; the menu anchors here. */
  y: number;
  /** Current lock state of the right-clicked node — picks the lock / unlock label. */
  locked: boolean;
  /** Open-state change (Escape / outside click / selection closes it). */
  onOpenChange: (open: boolean) => void;
  /** Toggle the node's lock state. */
  onToggleLock: () => void;
  /** Whether the right-clicked target is a node or a group — picks the items + wording. */
  target?: 'node' | 'group';
  /** Enter inline rename for the node / group name. */
  onRename?: () => void;
  /** Delete the node / group (routed through the guarded delete path). */
  onDelete?: () => void;
  /**
   * Open the file picker to fill / replace this node's content (node target
   * only). Its presence also gates the Generate / Upload / Tools block — a
   * read-only viewer passes none, so the block hides.
   */
  onUpload?: () => void;
  /**
   * Open the Generate panel for this node. Passed for content nodes that
   * support generation (image); when absent the Generate item stays a disabled
   * placeholder (non-image content nodes, until their slice ships).
   */
  onGenerate?: () => void;
  /**
   * Reset this image node to a fresh blank image (image nodes only, #1623).
   * Passed only for `type === 'image'` non-viewer nodes; when absent the item
   * does not render, so it never appears on text / audio / video nodes.
   */
  onResetImage?: () => void;
  /**
   * Open the node-history panel for this node (#1619, browse + restore past
   * results). Passed for editable content nodes (image / video / audio); when
   * absent the item does not render, so it never appears on text / group /
   * read-only nodes.
   */
  onOpenHistory?: () => void;
  /** Copy the node / group (with its members) to the clipboard. */
  onCopy?: () => void;
  /** Duplicate the node / group (with its members) in place. */
  onDuplicate?: () => void;
  /** Ungroup the group (group target only). */
  onUngroup?: () => void;
}

/**
 * The right-click menu for a single canvas node or group. A controlled
 * `DropdownMenu` anchored to a zero-size element pinned at the cursor
 * (ReactFlow's `onNodeContextMenu` gives a point, not an element Radix can
 * anchor to). A node offers generate / upload / tools (top block) then copy /
 * duplicate / rename / lock / delete; a group offers copy / duplicate (with its
 * members) / ungroup / rename / lock / delete. Generate / Tools are disabled
 * placeholders (coming soon); Upload is
 * the only live action of the top block. Each action item renders only when its
 * handler is supplied, so the parent controls availability (e.g. read-only
 * passes none); lock / unlock is always present. Shortcut hints are
 * platform-aware via {@link formatShortcut}.
 * @param root0 - Component props.
 * @param root0.open - Whether the menu is open.
 * @param root0.x - Viewport x to anchor the menu at.
 * @param root0.y - Viewport y to anchor the menu at.
 * @param root0.locked - Current lock state, selecting the lock / unlock label + icon.
 * @param root0.onOpenChange - Open-state change callback.
 * @param root0.onToggleLock - Toggle the node's lock state.
 * @param root0.target - Whether the menu targets a node or a group (picks items + wording).
 * @param root0.onRename - Enter inline rename.
 * @param root0.onDelete - Delete the node / group.
 * @param root0.onUpload - Fill / replace the node's content via the file picker (node target only).
 * @param root0.onGenerate - Open the Generate panel (content nodes that support it, e.g. image).
 * @param root0.onResetImage - Reset an image node to a fresh blank image (image nodes only).
 * @param root0.onOpenHistory - Open the node-history panel (content nodes only).
 * @param root0.onCopy - Copy the node / group (with its members).
 * @param root0.onDuplicate - Duplicate the node / group (with its members).
 * @param root0.onUngroup - Ungroup the group (group target only).
 * @returns The cursor-anchored node / group action menu.
 */
export const NodeContextMenu = React.memo(function NodeContextMenu({
  open,
  x,
  y,
  locked,
  target = 'node',
  onOpenChange,
  onToggleLock,
  onRename,
  onDelete,
  onUpload,
  onGenerate,
  onResetImage,
  onOpenHistory,
  onCopy,
  onDuplicate,
  onUngroup,
}: NodeContextMenuProps): React.JSX.Element {
  const t = useTranslation();
  const isGroup = target === 'group';
  // Rename opens the node's inline editor, which must take the caret. If we
  // fired `onRename` from the item's `onSelect`, the editor would focus WHILE
  // the menu is still closing — its focus trap (held through the exit
  // animation) yanks the caret back, and on unmount it lands on <body>. So the
  // item only flags the intent; we run `onRename` from `onCloseAutoFocus`,
  // which fires after the menu has fully closed and its focus scope released,
  // preventing the default focus-restore so the editor keeps the caret.
  const renamePending = React.useRef(false);
  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange}>
      <DropdownMenuTrigger asChild>
        <span
          aria-hidden='true'
          data-testid='node-context-anchor'
          style={{ position: 'fixed', left: x, top: y, height: 0, width: 0 }}
        />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align='start'
        onCloseAutoFocus={(event) => {
          if (!renamePending.current) return;
          renamePending.current = false;
          event.preventDefault();
          onRename?.();
        }}
      >
        {!isGroup && onUpload ? (
          <>
            {/* Generate is enabled for content nodes that support it (image),
                gated by the onGenerate handler; Tools is still a disabled
                placeholder (no mini-tool wired yet). A disabled item has no
                side effect when clicked. */}
            <DropdownMenuItem
              disabled={!onGenerate}
              data-testid='node-menu-generate'
              onSelect={onGenerate}
            >
              <Sparkles className='mr-2 h-4 w-4' aria-hidden='true' />
              {t('canvas.nodeMenu.generate')}
            </DropdownMenuItem>
            <DropdownMenuItem data-testid='node-menu-upload' onSelect={onUpload}>
              <Upload className='mr-2 h-4 w-4' aria-hidden='true' />
              {t('canvas.nodeMenu.upload')}
            </DropdownMenuItem>
            {onResetImage ? (
              <DropdownMenuItem
                data-testid='node-menu-reset-image'
                onSelect={onResetImage}
              >
                <ImagePlus className='mr-2 h-4 w-4' aria-hidden='true' />
                {t('canvas.nodeMenu.resetEmpty')}
              </DropdownMenuItem>
            ) : null}
            {onOpenHistory ? (
              <DropdownMenuItem
                data-testid='node-menu-history'
                onSelect={onOpenHistory}
              >
                <History className='mr-2 h-4 w-4' aria-hidden='true' />
                {t('canvas.nodeMenu.history')}
              </DropdownMenuItem>
            ) : null}
            <DropdownMenuItem disabled data-testid='node-menu-tools'>
              <Wrench className='mr-2 h-4 w-4' aria-hidden='true' />
              {t('canvas.nodeMenu.tools')}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
          </>
        ) : null}
        {onCopy || onDuplicate ? (
          <>
            {onCopy ? (
              <DropdownMenuItem data-testid='node-menu-copy' onSelect={onCopy}>
                <Copy className='mr-2 h-4 w-4' aria-hidden='true' />
                {t('canvas.contextMenu.copy')}
                <DropdownMenuShortcut>
                  {formatShortcut({ mod: true, key: 'C' })}
                </DropdownMenuShortcut>
              </DropdownMenuItem>
            ) : null}
            {onDuplicate ? (
              <DropdownMenuItem
                data-testid='node-menu-duplicate'
                onSelect={onDuplicate}
              >
                <CopyPlus className='mr-2 h-4 w-4' aria-hidden='true' />
                {t('canvas.contextMenu.duplicate')}
                <DropdownMenuShortcut>
                  {formatShortcut({ mod: true, key: 'D' })}
                </DropdownMenuShortcut>
              </DropdownMenuItem>
            ) : null}
            <DropdownMenuSeparator />
          </>
        ) : null}
        {isGroup && onUngroup ? (
          <>
            <DropdownMenuItem
              data-testid='node-menu-ungroup'
              onSelect={onUngroup}
            >
              <Ungroup className='mr-2 h-4 w-4' aria-hidden='true' />
              {t('canvas.group.ungroup')}
              <DropdownMenuShortcut>
                {formatShortcut({ mod: true, shift: true, key: 'G' })}
              </DropdownMenuShortcut>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
          </>
        ) : null}
        {onRename ? (
          <DropdownMenuItem
            data-testid='node-menu-rename'
            onSelect={() => {
              renamePending.current = true;
            }}
          >
            <Pencil className='mr-2 h-4 w-4' aria-hidden='true' />
            {t('canvas.contextMenu.rename')}
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuItem
          data-testid='node-menu-lock-toggle'
          onSelect={onToggleLock}
        >
          {locked ? (
            <Unlock className='mr-2 h-4 w-4' aria-hidden='true' />
          ) : (
            <Lock className='mr-2 h-4 w-4' aria-hidden='true' />
          )}
          {locked
            ? t(isGroup ? 'canvas.group.unlock' : 'canvas.nodeMenu.unlock')
            : t(isGroup ? 'canvas.group.lock' : 'canvas.nodeMenu.lock')}
        </DropdownMenuItem>
        {onDelete ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              data-testid='node-menu-delete'
              onSelect={onDelete}
            >
              <Trash2 className='mr-2 h-4 w-4' aria-hidden='true' />
              {t(
                isGroup
                  ? 'canvas.contextMenu.deleteGroup'
                  : 'canvas.contextMenu.deleteNode',
              )}
              <DropdownMenuShortcut>
                {formatShortcut({ key: 'Delete' })}
              </DropdownMenuShortcut>
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
});
