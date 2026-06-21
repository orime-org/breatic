// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import {
  Copy,
  CopyPlus,
  Lock,
  Pencil,
  Trash2,
  Ungroup,
  Unlock,
} from 'lucide-react';
import type * as React from 'react';

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
  /** Copy the node to the clipboard (node target only). */
  onCopy?: () => void;
  /** Duplicate the node in place (node target only). */
  onDuplicate?: () => void;
  /** Ungroup the group (group target only). */
  onUngroup?: () => void;
}

/**
 * The right-click menu for a single canvas node or group. A controlled
 * `DropdownMenu` anchored to a zero-size element pinned at the cursor
 * (ReactFlow's `onNodeContextMenu` gives a point, not an element Radix can
 * anchor to). A node offers copy / duplicate / rename / lock / delete; a group
 * offers ungroup / rename / lock / delete. Each action item renders only when
 * its handler is supplied, so the parent controls availability (e.g. read-only
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
 * @param root0.onCopy - Copy the node (node target only).
 * @param root0.onDuplicate - Duplicate the node (node target only).
 * @param root0.onUngroup - Ungroup the group (group target only).
 * @returns The cursor-anchored node / group action menu.
 */
export function NodeContextMenu({
  open,
  x,
  y,
  locked,
  target = 'node',
  onOpenChange,
  onToggleLock,
  onRename,
  onDelete,
  onCopy,
  onDuplicate,
  onUngroup,
}: NodeContextMenuProps): React.JSX.Element {
  const t = useTranslation();
  const isGroup = target === 'group';
  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange}>
      <DropdownMenuTrigger asChild>
        <span
          aria-hidden='true'
          data-testid='node-context-anchor'
          style={{ position: 'fixed', left: x, top: y, height: 0, width: 0 }}
        />
      </DropdownMenuTrigger>
      <DropdownMenuContent align='start'>
        {!isGroup && (onCopy || onDuplicate) ? (
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
          <DropdownMenuItem data-testid='node-menu-rename' onSelect={onRename}>
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
              {t('canvas.contextMenu.delete')}
              <DropdownMenuShortcut>
                {formatShortcut({ key: 'Delete' })}
              </DropdownMenuShortcut>
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
