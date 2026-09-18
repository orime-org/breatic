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
import { UNAVAILABLE } from '@web/spaces/document/document-coming-tool';
import {
  BLOCK_MENU_ROWS,
  type BlockMenuRow,
} from '@web/spaces/document/document-block-menu-rows';
import { runBlockType } from '@web/spaces/document/document-block-run';
import {
  tickedOver,
  type BlockTypeId,
} from '@web/spaces/document/document-block-ticks';
import { BLOCK_TYPE_ITEMS } from '@web/spaces/document/document-block-type';
import {
  deleteRow,
  duplicateRow,
  type HandleEditor,
} from '@web/spaces/document/document-handle-commands';
import { selectionOverBlockContent } from '@web/spaces/document/document-hovered-block';
import { INSERT_MENU_ROWS } from '@web/spaces/document/document-insert-menu-items';
import {
  insertRowForMenu,
  type PressedBlock,
} from '@web/spaces/document/document-insert-row';

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
   * Whether the row this menu is about is still in the document.
   *
   * The menu stays open while the pointer wanders (the side menu is frozen),
   * so a co-editor can remove that row from under it. Every command here
   * addresses the row by id, and three of the four reach an editor call that
   * throws on an id the document no longer holds
   * (`selectionOverBlockContent`, `editor.insertBlocks`). One judgement in
   * front of them all answers that state the way the reader already sees the
   * guarded ones answer it: the menu closes and nothing is written.
   * @returns True while the row is there.
   */
  function rowIsThere(): boolean {
    return editor.getBlock(block.id) !== undefined;
  }

  /**
   * Runs one row and closes the menu.
   * @param row - The row that was pressed.
   */
  function press(row: BlockMenuRow): void {
    if (!rowIsThere()) {
      close();
      return;
    }
    if (row.id === 'duplicate') {
      duplicateRow(editor, block);
    }
    if (row.id === 'delete') {
      deleteRow(editor, block.id);
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
                        if (rowIsThere()) {
                          runBlockType(editor, item.id, block.id);
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
                  const item = BLOCK_TYPE_ITEMS.find((one) => one.id === id);
                  if (item === undefined) return null;
                  const ItemIcon = item.Icon;
                  return (
                    <DropdownMenuItem
                      key={id}
                      data-testid={`doc-block-insert-${id}`}
                      onSelect={() => {
                        if (rowIsThere()) {
                          const made = insertRowForMenu(editor, block);
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

        if (row.kind === 'coming') {
          // Stands in the menu so the shape is whole, and says it cannot be
          // used: the treatment is the bubble bar's, which the reader has
          // already met on the comment entry there (A10).
          const comingLabel = t('spaces.document.commands.comingLabel', {
            name: label,
          });
          return (
            <DropdownMenuItem
              key={row.id}
              aria-disabled='true'
              data-testid={`doc-block-row-${row.id}`}
              className={UNAVAILABLE}
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
