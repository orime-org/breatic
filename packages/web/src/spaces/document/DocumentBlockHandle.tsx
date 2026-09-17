// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The strip beside the row under the pointer: the plus and the drag handle.
 *
 * Handed to `SideMenuController` in place of the library's own strip, which
 * cannot serve here for two reasons: its buttons draw `react-icons` glyphs at
 * a fixed size where the demo asks for lucide at 16 (A2), and its handle is a
 * `DropdownMenu.Trigger`, whose `onPointerDown` calls `preventDefault()` and
 * so stops the browser from ever starting a drag (A11).
 *
 * The handle carries both gestures by keeping them apart: a
 * `pointer-events-none` span is the menu's anchor and receives nothing, while
 * the button beside it is a plain draggable button that opens the menu on
 * click. Radix still owns the menu itself — outside-click, Escape, collision
 * flipping and focus all stay its job.
 */

import { SideMenuExtension, SuggestionMenu } from '@blocknote/core/extensions';
import { GripVertical, Plus } from 'lucide-react';
import * as React from 'react';

import { useBlockNoteEditor } from '@blocknote/react';
import { useExtension, useExtensionState } from '@blocknote/react';

import { Button } from '@web/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@web/components/ui/dropdown-menu';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@web/components/ui/tooltip';
import { useTranslation } from '@web/i18n/use-translation';
import { DocumentBlockMenu } from '@web/spaces/document/DocumentBlockMenu';
import { rowShowsSomething } from '@web/spaces/document/document-hovered-block';
import { INSERT_TRIGGER } from '@web/spaces/document/document-insert-menu-items';
import {
  insertRowForMenu,
  type PressedBlock,
} from '@web/spaces/document/document-insert-row';
import { useInsertSession } from '@web/spaces/document/document-insert-session';

/**
 * A button on the strip: 24 square, which is the smallest a pointer target may
 * be (WCAG 2.2 SC 2.5.8), around the demo's 16 icon.
 */
const STRIP_BUTTON = 'size-6 shrink-0 [&_svg]:size-4 text-muted-foreground';

/**
 * The strip, for the block the side menu currently points at.
 * @returns The two buttons, or null while no block is pointed at.
 */
export function DocumentBlockHandle(): React.JSX.Element | null {
  const t = useTranslation();
  const editor = useBlockNoteEditor();
  const sideMenu = useExtension(SideMenuExtension);
  const suggestionMenu = useExtension(SuggestionMenu);
  const session = useInsertSession();
  const block = useExtensionState(SideMenuExtension, {
    selector: (state) => state?.block,
  }) as PressedBlock | undefined;
  const [menuOpen, setMenuOpen] = React.useState(false);

  // While the menu is open the strip has to stay on the row the menu is
  // about, however far the pointer wanders.
  const onMenuOpenChange = React.useCallback(
    (open: boolean) => {
      setMenuOpen(open);
      if (open) {
        sideMenu.freezeMenu();
      } else {
        sideMenu.unfreezeMenu();
      }
    },
    [sideMenu],
  );

  const onAdd = React.useCallback(() => {
    if (block === undefined) return;
    const made = insertRowForMenu(
      editor as Parameters<typeof insertRowForMenu>[0],
      block,
    );
    session.current = {
      blockId: made ?? block.id,
      made: made !== undefined,
    };
    suggestionMenu.openSuggestionMenu(INSERT_TRIGGER);
  }, [block, editor, session, suggestionMenu]);

  if (block === undefined) {
    return null;
  }

  const dragTip = t('spaces.document.blockHandle.dragTip');
  const addTip = t('spaces.document.blockHandle.addTip');

  return (
    <div className='flex items-center gap-0.5'>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant='ghost'
            size={null}
            aria-label={addTip}
            data-testid='doc-block-add'
            className={STRIP_BUTTON}
            onClick={onAdd}
          >
            <Plus />
          </Button>
        </TooltipTrigger>
        <TooltipContent>{addTip}</TooltipContent>
      </Tooltip>

      {/* A row showing nothing gets the plus alone: there is no block to take
          hold of, and a handle over an empty line would be offering one. */}
      {rowShowsSomething(block) && (
        <DropdownMenu open={menuOpen} onOpenChange={onMenuOpenChange}>
          <div className='relative'>
            {/* The anchor, and nothing else. It covers the button's box so
                the menu opens beside the handle, and it answers no pointer
                events so Radix's trigger handlers never run. */}
            <DropdownMenuTrigger asChild>
              <span aria-hidden className='pointer-events-none absolute inset-0' />
            </DropdownMenuTrigger>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant='ghost'
                  size={null}
                  aria-label={dragTip}
                  data-testid='doc-block-handle'
                  className={`${STRIP_BUTTON} cursor-grab`}
                  draggable
                  onDragStart={(event) => {
                    sideMenu.blockDragStart(event, block as never);
                  }}
                  onDragEnd={() => {
                    sideMenu.blockDragEnd();
                  }}
                  onClick={() => {
                    onMenuOpenChange(!menuOpen);
                  }}
                >
                  <GripVertical />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{dragTip}</TooltipContent>
            </Tooltip>
          </div>
          <DropdownMenuContent
            side='bottom'
            align='start'
            // Back to the body, at the caret the reader left there: the strip
            // is not a place to be after the menu closes, and typing has to
            // land in the document (A11).
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              editor.focus();
            }}
          >
            <DocumentBlockMenu
              editor={editor as never}
              block={block}
              close={() => {
                onMenuOpenChange(false);
              }}
            />
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}
