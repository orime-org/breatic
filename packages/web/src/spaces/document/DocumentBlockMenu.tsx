// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The five rows of the block handle menu, and what each one runs.
 *
 * Every row acts on the block the pointer is over, never on the reader's
 * selection (A5) — which is why each command here is handed that block's id
 * and why none of them moves the caret.
 *
 * Which rows there are, and in what order, is `document-block-menu-rows.ts`;
 * this file is the wiring.
 */

import { Check } from 'lucide-react';
import * as React from 'react';

import {
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from '@web/components/ui/dropdown-menu';
import { useTranslation } from '@web/i18n/use-translation';
import { UNAVAILABLE_KEYBOARD_FOCUS_ONLY } from '@web/spaces/document/document-coming-tool';
import {
  BLOCK_MENU_ROWS,
  type BlockMenuRow,
} from '@web/spaces/document/document-block-menu-rows';
import { runBlockType } from '@web/spaces/document/document-block-run';
import {
  tickedOver,
  type BlockTypeId,
} from '@web/spaces/document/document-block-ticks';
import {
  BLOCK_TYPE_ITEMS,
  blockTypeItem,
} from '@web/spaces/document/document-block-type';
import {
  deleteRow,
  duplicateRow,
  type HandleEditor,
  type PressedBlock,
} from '@web/spaces/document/document-handle-commands';
import { selectionOverBlockContent } from '@web/spaces/document/document-hovered-block';
import { INSERT_MENU_ROWS } from '@web/spaces/document/document-insert-menu-items';
import { insertRowForMenu } from '@web/spaces/document/document-insert-row';

interface DocumentBlockMenuProps {
  /** The editor to write to. */
  editor: HandleEditor;
  /** The block the pointer is over. */
  block: PressedBlock;
  /** Closes the menu. */
  close: () => void;
}

/**
 * The rows the block type submenu offers for this block.
 * @param editor - The editor to read from.
 * @param blockId - The block the pointer is over.
 * @returns Which rows that block already carries.
 */
function ticksFor(editor: HandleEditor, blockId: string): Set<BlockTypeId> {
  return editor.transact((tr) =>
    tickedOver(tr.doc, selectionOverBlockContent(tr.doc, blockId)),
  );
}

/**
 * The menu's five rows.
 * @param props - See {@link DocumentBlockMenuProps}.
 * @param props.editor - The editor to write to.
 * @param props.block - The block the pointer is over.
 * @param props.close - Closes the menu.
 * @returns The rows.
 */
export function DocumentBlockMenu({
  editor,
  block,
  close,
}: DocumentBlockMenuProps): React.JSX.Element {
  const t = useTranslation();
  const ticked = ticksFor(editor, block.id);

  /**
   * The row this menu is about, as the document holds it right now.
   *
   * The block the strip hands over is a snapshot taken when the pointer
   * arrived: the library refreshes its state on a document change
   * (`SideMenu.ts:683-688`) but `updateStateFromMousePos` returns early while
   * the hovered element still carries the same `data-id` (`:229-236`). The
   * menu meanwhile stays open however long the reader takes, and a co-editor
   * can change that row or take it away. So every command reads the row again
   * here, by the one thing that does not go stale — its id.
   *
   * Measured 2026-09-18: with the snapshot, a row reading `alpha PLUS` on
   * screen was duplicated as `alpha`.
   * @returns The row, or undefined once it is gone.
   */
  function rowNow(): PressedBlock | undefined {
    return editor.getBlock(block.id) as PressedBlock | undefined;
  }

  /**
   * Runs one row and closes the menu.
   *
   * Nothing is the right answer to a command whose subject is gone: the reader
   * sees the menu close and the row stay gone, which is what they are looking
   * at anyway.
   * @param row - The row that was pressed.
   */
  function press(row: BlockMenuRow): void {
    const live = rowNow();
    if (live !== undefined) {
      if (row.id === 'duplicate') {
        duplicateRow(editor, live);
      }
      if (row.id === 'delete') {
        deleteRow(editor, live.id);
      }
    }
    close();
  }

  return (
    <>
      {BLOCK_MENU_ROWS.map((row) => {
        const label = t(row.labelKey);
        const Icon = row.Icon;

        if (row.id === 'blockType') {
          return (
            <DropdownMenuSub key={row.id}>
              <DropdownMenuSubTrigger data-testid='doc-block-row-blockType'>
                <Icon />
                {label}
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                {BLOCK_TYPE_ITEMS.map((item) => {
                  const ItemIcon = item.Icon;
                  return (
                    <DropdownMenuItem
                      key={item.id}
                      data-testid={`doc-block-type-${item.id}`}
                      data-ticked={ticked.has(item.id) ? 'true' : undefined}
                      onSelect={() => {
                        const live = rowNow();
                        if (live !== undefined) {
                          runBlockType(editor, item.id, live.id);
                        }
                        close();
                      }}
                    >
                      <ItemIcon />
                      <span className='flex-1 text-left'>{t(item.labelKey)}</span>
                      {/* What the block already is (A5). Drawn the way the
                          bubble bar's own type menu draws it
                          (`document-bubble-slots.tsx`): the glyph at that
                          weight, and the column on every row whether it is
                          ticked or not, so a ticked row does not lay out
                          narrower than the rest. */}
                      <span
                        data-testid={`doc-block-type-tickcol-${item.id}`}
                        className='ml-1 flex size-4 shrink-0 items-center justify-center'
                      >
                        {ticked.has(item.id) ? (
                          <Check
                            data-testid={`doc-block-type-tick-${item.id}`}
                            className='size-4'
                            strokeWidth={3}
                          />
                        ) : null}
                      </span>
                    </DropdownMenuItem>
                  );
                })}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          );
        }

        if (row.id === 'insertBelow') {
          return (
            <DropdownMenuSub key={row.id}>
              <DropdownMenuSubTrigger data-testid='doc-block-row-insertBelow'>
                <Icon />
                {label}
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                {INSERT_MENU_ROWS.map((id) => {
                  const item = blockTypeItem(id);
                  const ItemIcon = item.Icon;
                  return (
                    <DropdownMenuItem
                      key={id}
                      data-testid={`doc-block-insert-${id}`}
                      onSelect={() => {
                        const live = rowNow();
                        if (live !== undefined) {
                          const made = insertRowForMenu(editor, live);
                          runBlockType(editor, id, made, false);
                        }
                        close();
                      }}
                    >
                      <ItemIcon />
                      {t(item.labelKey)}
                    </DropdownMenuItem>
                  );
                })}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          );
        }

        if (row.id === 'comment') {
          // Stands in the menu so the shape is whole, and says it cannot be
          // used: the treatment is the bubble bar's, which the reader has
          // already met on the comment entry there (A10).
          //
          // THE KEYBOARD STILL HAS TO SEE WHERE IT IS. `aria-disabled` rather
          // than Radix's `disabled` is what the ARIA authoring practices ask
          // of a menu — "Disabled menu items are focusable but cannot be
          // activated" — so an arrow key lands here, and the row's own
          // background is the only thing that says so. `onPointerMove` below
          // keeps the POINTER from focusing it, which is the case the bubble
          // bar's own treatment cancels `:focus` for.
          const comingLabel = t('spaces.document.commands.comingLabel', {
            name: label,
          });
          return (
            <DropdownMenuItem
              key={row.id}
              aria-disabled='true'
              data-testid={`doc-block-row-${row.id}`}
              className={UNAVAILABLE_KEYBOARD_FOCUS_ONLY}
              onSelect={(event) => {
                event.preventDefault();
              }}
              onPointerMove={(event) => {
                event.preventDefault();
              }}
            >
              <Icon />
              {comingLabel}
            </DropdownMenuItem>
          );
        }

        return (
          <DropdownMenuItem
            key={row.id}
            data-testid={`doc-block-row-${row.id}`}
            onSelect={() => {
              press(row);
            }}
          >
            <Icon />
            {label}
          </DropdownMenuItem>
        );
      })}
    </>
  );
}
