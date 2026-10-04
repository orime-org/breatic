// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The insert menu's rows: the eight block types other than text, then the
 * divider and the table in a group of their own.
 *
 * Two places open it — the grip menu's insert-below submenu and the plus on an
 * empty paragraph (#1097) — and they differ only in what a pick does, so the
 * list itself is drawn here once.
 */

import { Minus, Table } from 'lucide-react';
import * as React from 'react';

import {
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from '@web/components/ui/dropdown-menu';
import { useTranslation } from '@web/i18n/use-translation';
import {
  itemWithin,
  rulesAfter,
} from '@web/spaces/document/document-block-menu-parts';
import { blockTypeItem } from '@web/spaces/document/document-block-type';
import { DIVIDER } from '@web/spaces/document/document-divider';
import { INSERT_MENU_ROWS } from '@web/spaces/document/document-insert-menu-items';
import type { InsertChoice, TableSize } from '@web/spaces/document/document-insert-row';
import { DocumentTableSizeGrid } from '@web/spaces/document/DocumentTableSizeGrid';

interface DocumentInsertChoicesProps {
  /** What picking an entry does. */
  onPick: (choice: InsertChoice) => void;
  /**
   * Entries that would do nothing here, drawn out of reach. Every entry is
   * reachable when it is left out.
   */
  unreachable?: ReadonlySet<InsertChoice>;
}

/**
 * The rows, each running `onPick` with what it stands for.
 * @param props - See {@link DocumentInsertChoicesProps}.
 * @param props.onPick - What picking an entry does.
 * @param props.unreachable - Entries that would do nothing here.
 * @returns The rows.
 */
export const DocumentInsertChoices = React.memo(function DocumentInsertChoices({
  onPick,
  unreachable,
}: DocumentInsertChoicesProps): React.JSX.Element {
  const t = useTranslation();
  const onPickTable = React.useCallback(
    (table: TableSize): void => {
      onPick({ table });
    },
    [onPick],
  );
  return (
    <>
      {INSERT_MENU_ROWS.map((id, index) => {
        const item = blockTypeItem(id);
        const ItemIcon = item.Icon;
        const ruled = rulesAfter(id, INSERT_MENU_ROWS[index + 1]);
        return (
          <React.Fragment key={id}>
            <DropdownMenuItem
              data-testid={`doc-block-insert-${id}`}
              {...itemWithin(unreachable?.has(id) !== true, () => {
                onPick(id);
              })}
            >
              <ItemIcon />
              {t(item.labelKey)}
            </DropdownMenuItem>
            {ruled ? <DropdownMenuSeparator className='my-0' /> : null}
          </React.Fragment>
        );
      })}
      {/* Not block types: a divider holds no text and a table holds cells, so
          neither has a row in the block type menu; they sit in a group of
          their own here. */}
      <DropdownMenuSeparator className='my-0' />
      <DropdownMenuItem
        data-testid='doc-block-insert-divider'
        {...itemWithin(unreachable?.has(DIVIDER) !== true, () => {
          onPick(DIVIDER);
        })}
      >
        <Minus />
        {t('spaces.document.commands.divider')}
      </DropdownMenuItem>
      <DropdownMenuSub>
        <DropdownMenuSubTrigger data-testid='doc-block-insert-table'>
          <Table />
          {t('spaces.document.commands.table')}
        </DropdownMenuSubTrigger>
        <DropdownMenuSubContent className='min-w-0'>
          <DocumentTableSizeGrid onPick={onPickTable} />
        </DropdownMenuSubContent>
      </DropdownMenuSub>
    </>
  );
});
