// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The insert menu's rows: the eight block types other than text, then the
 * divider, the table, columns and the formula in a group of their own.
 *
 * Two places open it — the grip menu's insert-below submenu and the plus on an
 * empty paragraph (#1097) — and they differ only in what a pick does, so the
 * list itself is drawn here once.
 */

import { Columns2, Image as ImageIcon, Minus, Music, Sigma, Table, Video } from 'lucide-react';
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
  whenOutOfReach,
} from '@web/spaces/document/document-block-menu-parts';
import { blockTypeItem } from '@web/spaces/document/document-block-type';
import { DIVIDER } from '@web/spaces/document/document-divider';
import { INSERT_MENU_ROWS } from '@web/spaces/document/document-insert-menu-items';
import type { InsertEntryId } from '@web/spaces/document/document-insert-entries';
import { COLUMNS, FORMULA, type InsertChoice, type TableSize } from '@web/spaces/document/document-insert-row';
import { DocumentTableSizeGrid } from '@web/spaces/document/DocumentTableSizeGrid';
import { toast } from '@web/lib/toast';
import type { MediaBlockType } from '@web/spaces/document/document-media-types';

/** The media entries, in the order the menu shows them (inner#1127 A1). */
const MEDIA_ENTRIES: readonly { kind: MediaBlockType; Icon: typeof ImageIcon }[] = [
  { kind: 'image', Icon: ImageIcon },
  { kind: 'audio', Icon: Music },
  { kind: 'video', Icon: Video },
];

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
      {/* Not block types: a divider holds no text, a table holds cells,
          columns hold blocks and a formula holds its source, so none has a
          row in the block type menu; they sit in a group of their own here. */}
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
        <DropdownMenuSubTrigger data-testid='doc-block-insert-table' {...whenOutOfReach(tableUnreachable)}>
          <Table />
          {t('spaces.document.commands.table')}
        </DropdownMenuSubTrigger>
        {tableUnreachable ? null : (
          <DropdownMenuSubContent className='min-w-0'>
            <DocumentTableSizeGrid onPick={onPickTable} />
          </DropdownMenuSubContent>
        )}
      </DropdownMenuSub>
      <DropdownMenuItem
        data-testid='doc-block-insert-columns'
        {...itemWithin(!columnsUnreachable, onPickColumns, onColumnsRefused)}
      >
        <Columns2 />
        {t('spaces.document.commands.columns')}
      </DropdownMenuItem>
      <DropdownMenuItem
        data-testid='doc-block-insert-formula'
        {...itemWithin(unreachable?.has(FORMULA) !== true, () => {
          onPick(FORMULA);
        })}
      >
        <Sigma />
        {t('spaces.document.commands.formula')}
      </DropdownMenuItem>
      {onPickMedia !== undefined &&
        MEDIA_ENTRIES.map(({ kind, Icon }) => (
          <DropdownMenuItem
            key={kind}
            data-testid={`doc-block-insert-${kind}`}
            {...itemWithin(true, () => {
              onPickMedia(kind);
            })}
          >
            <Icon />
            {t(`spaces.document.media.${kind}`)}
          </DropdownMenuItem>
        ))}
    </>
  );
});
