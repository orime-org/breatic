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
 *
 * NEITHER BUTTON HAS A TOOLTIP (user 2026-09-17: 「这个 tips 出现会影响操作」).
 * Both of these are pressed the moment the pointer arrives, and a tip that
 * fades in over the row is in the way of the very gesture it is describing —
 * the handle's tip also stood outside the scroll viewport on the first row,
 * measured 16px above its top edge. The names stay as `aria-label`, where they
 * cost the reader nothing.
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
import { useTranslation } from '@web/i18n/use-translation';
import {
  readerPlace,
  restoreReaderPlace,
  type ReaderPlace,
} from '@web/spaces/document/document-drag-selection';
import { useStripOnFirstLine } from '@web/spaces/document/document-strip-alignment';
import { DocumentBlockMenu } from '@web/spaces/document/DocumentBlockMenu';
import { rowPaintsSomething } from '@web/spaces/document/document-hovered-block';
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
  // Where the reader was when a drag started, to hand back when it ends.
  const place = React.useRef<ReaderPlace | undefined>(undefined);
  // The carrier is placed on the row's top edge; this brings the two buttons
  // down onto the middle of the row's first line (A2).
  const { ref: strip, offset } = useStripOnFirstLine(
    block?.id,
    editor.prosemirrorView?.dom,
  );

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
    <div
      ref={strip}
      // Which row these two buttons are for. The strip stands outside the
      // editable element, so this is the only thing that says so — and what a
      // test measuring the alignment has to read, since the row under the
      // pointer is not always the row a pointer was aimed at (a heading's top
      // margin answers for the row above it).
      data-row-id={block.id}
      // `select-none`: the strip is chrome standing in the gutter the reader
      // sweeps through whenever they drag a selection out to the left, and a
      // selection that reaches a selectable element OUTSIDE the body takes
      // everything in between with it — measured 2026-09-18: dragging upwards
      // from row 7 and stepping 40px left put the plus under the pointer and
      // selected rows 1 to 5, at every height, while 200px out (bare gutter)
      // correctly gave the line's own start. The handle beside it was already
      // immune by accident: `[draggable=true]` carries `user-select: none` in
      // the UA stylesheet. None of this strip is text, so none of it takes
      // part — the same thing the library does for its own chrome
      // (`.bn-trailing-block`, `.bn-toggle-button`).
      className='flex select-none items-center gap-0.5'
      style={{ transform: `translateY(${String(offset)}px)` }}
    >
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

      {/* A row showing nothing gets the plus alone: there is no block to take
          hold of, and a handle over an empty line would be offering one. */}
      {rowPaintsSomething(block) && (
        <DropdownMenu open={menuOpen} onOpenChange={onMenuOpenChange}>
          <div className='relative'>
            {/* The anchor, and nothing else. It covers the button's box so
                the menu opens beside the handle, and it answers no pointer
                events so Radix's trigger handlers never run. */}
            <DropdownMenuTrigger asChild>
              <span aria-hidden className='pointer-events-none absolute inset-0' />
            </DropdownMenuTrigger>
            <Button
              variant='ghost'
              size={null}
              aria-label={dragTip}
              data-testid='doc-block-handle'
              className={`${STRIP_BUTTON} cursor-grab`}
              draggable
              onDragStart={(event) => {
                // Read before the library takes the selection for its own
                // (`blockDragStart` puts a node selection on the row).
                place.current = readerPlace(editor.prosemirrorView.state);
                sideMenu.blockDragStart(event, block as never);
              }}
              onDragEnd={() => {
                sideMenu.blockDragEnd();
                const held = place.current;
                place.current = undefined;
                if (held !== undefined) {
                  restoreReaderPlace(editor.prosemirrorView, held);
                }
                // The press that started the drag took the focus to this
                // button, and a key pressed after the drag has to land in the
                // document — the same reason the menu hands focus back when
                // it closes.
                editor.focus();
              }}
              onClick={() => {
                onMenuOpenChange(!menuOpen);
              }}
            >
              <GripVertical />
            </Button>
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
