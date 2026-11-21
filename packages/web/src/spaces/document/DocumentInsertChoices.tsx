// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The insert menu's rows, drawn from `INSERT_ENTRY_IDS` (inner#1125 design
 * 5.2): the eight block types other than text, then the divider, the table,
 * columns, the formula and the media in a group of their own.
 *
 * Two places open it — the grip menu's insert-below submenu and the plus on an
 * empty paragraph (#1097) — and they differ only in what a pick does, so the
 * list itself is drawn here once.
 */

import * as React from 'react';

import {
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from '@web/components/ui/dropdown-menu';
import { useTranslation } from '@web/i18n/use-translation';
import { itemWithin, whenOutOfReach } from '@web/spaces/document/document-block-menu-parts';
import {
  INSERT_ENTRY_IDS,
  INSERT_ENTRY_IDS_WITHOUT_MEDIA,
  MEDIA_ENTRY_IDS,
  insertEntryLook,
  ruleBetween,
  type InsertEntryId,
} from '@web/spaces/document/document-insert-entries';
import { COLUMNS, type InsertChoice, type TableSize } from '@web/spaces/document/document-insert-row';
import { DocumentTableSizeGrid } from '@web/spaces/document/DocumentTableSizeGrid';
import { toast } from '@web/lib/toast';
import type { MediaBlockType } from '@web/spaces/document/document-media-types';

interface DocumentInsertChoicesProps {
  /** What picking an entry does. */
  onPick: (choice: InsertChoice) => void;
  /**
   * Entries that cannot be carried out on this row, drawn out of reach
   * (`insertReach`). Every entry is reachable when it is left out.
   */
  unreachable?: ReadonlySet<InsertEntryId>;
  /** What picking a media entry does; left out, the menu offers none. */
  onPickMedia?: (kind: MediaBlockType) => void;
}

/**
 * The rows, each running `onPick` with what it stands for.
 * @param props - See {@link DocumentInsertChoicesProps}.
 * @param props.onPick - What picking an entry does.
 * @param props.unreachable - Entries that cannot be carried out on this row.
 * @param props.onPickMedia - What picking a media entry does.
 * @returns The rows.
 */
export const DocumentInsertChoices = React.memo(function DocumentInsertChoices({
  onPick,
  unreachable,
  onPickMedia,
}: DocumentInsertChoicesProps): React.JSX.Element {
  const t = useTranslation();
  const tableUnreachable = unreachable?.has('table') === true;
  const columnsUnreachable = unreachable?.has(COLUMNS) === true;
  const onPickColumns = React.useCallback((): void => {
    onPick(COLUMNS);
  }, [onPick]);
  const onColumnsRefused = React.useCallback((): void => {
    toast.warning(t('spaces.document.columns.unavailable'));
  }, [t]);
  const onPickTable = React.useCallback(
    (table: TableSize): void => {
      onPick({ table });
    },
    [onPick],
  );
  // Every row comes from `INSERT_ENTRY_IDS`, the list the slash menu draws
  // too; a rule sits wherever two neighbours are in different groups.
  const entries = onPickMedia === undefined ? INSERT_ENTRY_IDS_WITHOUT_MEDIA : INSERT_ENTRY_IDS;
  return (
    <>
      {entries.map((id, index) => {
        const { Icon, labelKey } = insertEntryLook(id);
        const ruled = ruleBetween(entries[index - 1], id);
        let row: React.JSX.Element;
        if (id === 'table') {
          row = (
            <DropdownMenuSub>
              <DropdownMenuSubTrigger data-testid='doc-block-insert-table' {...whenOutOfReach(tableUnreachable)}>
                <Icon />
                {t(labelKey)}
              </DropdownMenuSubTrigger>
              {tableUnreachable ? null : (
                <DropdownMenuSubContent className='min-w-0'>
                  <DocumentTableSizeGrid onPick={onPickTable} />
                </DropdownMenuSubContent>
              )}
            </DropdownMenuSub>
          );
        } else {
          const pick =
            id === COLUMNS
              ? itemWithin(!columnsUnreachable, onPickColumns, onColumnsRefused)
              : itemWithin(unreachable?.has(id) !== true, () => {
                if (MEDIA_ENTRY_IDS.has(id)) onPickMedia?.(id as MediaBlockType);
                else onPick(id as InsertChoice);
              });
          row = (
            <DropdownMenuItem data-testid={`doc-block-insert-${id}`} {...pick}>
              <Icon />
              {t(labelKey)}
            </DropdownMenuItem>
          );
        }
        return (
          <React.Fragment key={id}>
            {ruled ? <DropdownMenuSeparator className='my-0' /> : null}
            {row}
          </React.Fragment>
        );
      })}
    </>
  );
});
