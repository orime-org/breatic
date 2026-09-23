// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import {
  Bookmark,
  Copy,
  CopyPlus,
  Download,
  History,
  ImagePlus,
  Lock,
  Pencil,
  ScanText,
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
   * Open the Generate panel for this node. Passed for content nodes of a
   * modality that generates (`canGenerate`); when
   * absent the Generate item stays a disabled placeholder (the modalities
   * whose slice has not shipped). Which PANEL opens is decided downstream by
   * the modality, so this stays one handler however many panels exist.
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
   * results). Passed for editable content nodes; when absent the item does
   * not render, so it never appears on a group or to a read-only reader.
   */
  onOpenHistory?: () => void;
  /**
   * Whether this node has the item at all. Only a text node does: every other
   * modality's content is an asset that already has a row of its own, while
   * words are replaced by the next keystroke and nothing keeps them unless
   * the reader says so.
   */
  snapshotOffered?: boolean;
  /**
   * Keep a copy of what this node says right now (#2175). Absent on an
   * offered item disables it rather than dropping it: a node saying nothing
   * has nothing to keep, and the reader sees that where the item always is.
   */
  onSnapshot?: () => void;

  /**
   * Whether this node holds an asset at all, which is what Download,
   * Understand and Tools each act on. A text node holds words and never an
   * asset, so the three are left out of its menu entirely: an item greyed on
   * every text node forever says "not right now" about something that is
   * never going to be offered (user 2026-09-20). Defaults to true, because
   * every other content kind shows one.
   *
   * Separate from the three handlers below, which answer the other question:
   * whether THIS node can act right now. A node offering an asset it has not
   * finished loading keeps all three items, greyed.
   */
  assetActionsOffered?: boolean;
  /**
   * Download this node's content. Passed when the node is showing content on
   * screen; when absent the item is disabled, so a node whose content the
   * reader cannot see says so rather than dropping the item off the menu.
   */
  onDownload?: () => void;
  /** Read what this node is showing into a text node downstream; absent disables the item rather than hiding it. */
  onUnderstand?: () => void;
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
 * members) / ungroup / rename / lock / delete. Tools is a disabled placeholder
 * (coming soon). Two different questions decide what a reader sees. Whether
 * this KIND of node is ever offered an item is answered by leaving it out:
 * `snapshotOffered` and `assetActionsOffered` drop Snapshot and the three
 * asset items whole, because an item greyed on every text node forever says
 * "not right now" about something never on offer. Whether THIS node can act
 * on an item it is offered is answered by greying it: Generate, Snapshot,
 * Download, Understand and Tools render without their handler and disable,
 * the work being built and only the material missing, which is also why their
 * cursor refuses rather than saying nothing. The rest — reset, history, copy,
 * duplicate, rename, delete — render only when their handler is supplied.
 * Lock / unlock is always present. Shortcut hints are platform-aware via
 * {@link formatShortcut}.
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
 * @param root0.snapshotOffered - Whether this node has a Snapshot item (text nodes only).
 * @param root0.onSnapshot - Keep a copy of what this node says right now; absent disables the item.
 * @param root0.assetActionsOffered - Whether this node holds an asset, which Download / Understand / Tools act on (text nodes hold words).
 * @param root0.onDownload - Download what this node is showing; absent disables the item rather than hiding it.
 * @param root0.onUnderstand - Read what this node is showing into a text node downstream; absent disables the item rather than hiding it.
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
  snapshotOffered,
  assetActionsOffered = true,
  onSnapshot,
  onDownload,
  onUnderstand,
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
            {snapshotOffered ? (
              <DropdownMenuItem
                disabled={!onSnapshot}
                data-testid='node-menu-snapshot'
                className='data-[disabled]:pointer-events-auto data-[disabled]:cursor-not-allowed'
                onSelect={onSnapshot}
              >
                <Bookmark className='mr-2 h-4 w-4' aria-hidden='true' />
                {t('canvas.nodeMenu.snapshot')}
              </DropdownMenuItem>
            ) : null}
            {/* The three that act on the asset a node is showing. A node
                that holds words instead leaves all three out: greying an
                item on every text node forever says "not right now" about
                something never going to be offered.
                On a node that does hold one, each is greyed while this
                particular node cannot act — the feature is built, what is
                missing is something to act on, so the pointer says "not
                here, not now" rather than reading as an inert label. The
                primitive turns pointer events off on a disabled item
                (`dropdown-menu.tsx:43`), which hands the cursor back to the
                menu underneath; turning them on again is what lets the
                cursor show. Radix still refuses the press: `onSelect` never
                fires on a disabled item. */}
            {assetActionsOffered ? (
              <>
                <DropdownMenuItem
                  disabled={!onDownload}
                  data-testid='node-menu-download'
                  className='data-[disabled]:pointer-events-auto data-[disabled]:cursor-not-allowed'
                  onSelect={onDownload}
                >
                  <Download className='mr-2 h-4 w-4' aria-hidden='true' />
                  {t('canvas.nodeMenu.download')}
                </DropdownMenuItem>
                {/* What it produces lands on a new text node of its own,
                    which is why this is not an edit of the node it reads. */}
                <DropdownMenuItem
                  disabled={!onUnderstand}
                  data-testid='node-menu-understand'
                  className='data-[disabled]:pointer-events-auto data-[disabled]:cursor-not-allowed'
                  onSelect={onUnderstand}
                >
                  <ScanText className='mr-2 h-4 w-4' aria-hidden='true' />
                  {t('canvas.nodeMenu.understand')}
                </DropdownMenuItem>
                <DropdownMenuItem
                  disabled
                  data-testid='node-menu-tools'
                  className='data-[disabled]:pointer-events-auto data-[disabled]:cursor-not-allowed'
                >
                  <Wrench className='mr-2 h-4 w-4' aria-hidden='true' />
                  {t('canvas.nodeMenu.tools')}
                </DropdownMenuItem>
              </>
            ) : null}
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
