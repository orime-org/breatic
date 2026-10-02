// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The insert menu's rows: the eight block types other than text, then the
 * divider in a group of its own.
 *
 * Two places open it — the grip menu's insert-below submenu and the plus on an
 * empty paragraph (#1097) — and they differ only in what a pick does, so the
 * list itself is drawn here once.
 */

import { Minus } from 'lucide-react';
import * as React from 'react';

import {
  DropdownMenuItem,
  DropdownMenuSeparator,
} from '@web/components/ui/dropdown-menu';
import { useTranslation } from '@web/i18n/use-translation';
import {
  itemWithin,
  rulesAfter,
} from '@web/spaces/document/document-block-menu-parts';
import { blockTypeItem } from '@web/spaces/document/document-block-type';
import { DIVIDER } from '@web/spaces/document/document-divider';
import { INSERT_MENU_ROWS } from '@web/spaces/document/document-insert-menu-items';
import type { InsertChoice } from '@web/spaces/document/document-insert-row';

interface DocumentInsertChoicesProps {
  /** What picking an entry does. */
  onPick: (choice: InsertChoice) => void;
  /**
   * Whether an entry would do anything here; an entry it answers false for is
   * drawn out of reach. Every entry is reachable when it is left out.
   */
  reachable?: (choice: InsertChoice) => boolean;
}

/**
 * The rows, each running `onPick` with what it stands for.
 * @param props - See {@link DocumentInsertChoicesProps}.
 * @param props.onPick - What picking an entry does.
 * @param props.reachable - Whether an entry would do anything here.
 * @returns The rows.
 */
export const DocumentInsertChoices = React.memo(function DocumentInsertChoices({
  onPick,
  reachable,
}: DocumentInsertChoicesProps): React.JSX.Element {
  const t = useTranslation();
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
              {...itemWithin(reachable?.(id) ?? true, () => {
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
      {/* Not a block type: a divider holds no text, so it has no row in the
          block type menu and sits in a group of its own here. */}
      <DropdownMenuSeparator className='my-0' />
      <DropdownMenuItem
        data-testid='doc-block-insert-divider'
        {...itemWithin(reachable?.(DIVIDER) ?? true, () => {
          onPick(DIVIDER);
        })}
      >
        <Minus />
        {t('spaces.document.commands.divider')}
      </DropdownMenuItem>
    </>
  );
});
