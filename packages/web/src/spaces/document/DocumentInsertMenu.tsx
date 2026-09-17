// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The list the plus opens: what it holds, and what happens when it closes.
 *
 * Handed to `SuggestionMenuController` in place of the library's own list, so
 * the surface and the rows are ours — the same tokens, row height, radius and
 * spacing as the bubble bar's menus (A17).
 *
 * Where it sits is not ours: the controller places it with floating-ui, and
 * flips it above the row when there is no room below, which is what keeps
 * every row reachable for a plus pressed on the last visible line (A12).
 */

import * as React from 'react';

import { Button } from '@web/components/ui/button';
import { cn } from '@web/lib/utils';
import { useTranslation } from '@web/i18n/use-translation';
import type { BlockTypeId } from '@web/spaces/document/document-block-ticks';
import { BLOCK_TYPE_ITEMS } from '@web/spaces/document/document-block-type';
import {
  INSERT_GROUP_LABEL_KEY,
  INSERT_MENU_ROWS,
} from '@web/spaces/document/document-insert-menu-items';

/** One entry of the insert menu. */
export interface InsertMenuItem {
  /** Which block type it makes. */
  readonly id: BlockTypeId;
  /** What the reader reads, and what the query is matched against. */
  readonly title: string;
  /** The glyph beside it. */
  readonly Icon: (typeof BLOCK_TYPE_ITEMS)[number]['Icon'];
}

/** What the controller hands the list. */
export interface DocumentInsertMenuProps {
  /** The entries that survived the query. */
  items: InsertMenuItem[];
  /** Runs an entry and closes the menu. */
  onItemClick?: (item: InsertMenuItem) => void;
  /** Which entry the arrow keys are on. */
  selectedIndex?: number;
}

/** The surface, at the same values `DropdownMenuContent` gives every menu. */
const SURFACE =
  'min-w-[13rem] overflow-hidden rounded-overlay border border-border'
  + ' bg-popover p-1 text-popover-foreground shadow-md';

/**
 * A row. The measurements come from `size='menu-item'` and the hover fill
 * from `variant='ghost'`, which is how the bubble bar's menu rows get theirs
 * (`document-bubble-rows.tsx`) — so a change to either reaches both menus.
 */
const ROW =
  'w-full justify-start gap-2 font-normal cursor-default select-none'
  + ' transition-colors [&_svg]:size-4 [&_svg]:shrink-0';

/** The group heading, at the bubble menus' heading size, weight and colour. */
const HEADING = 'px-2 pb-[3px] pt-1.5 text-2xs font-semibold text-muted-foreground';

/**
 * Every entry the menu can offer, named and drawn by the block type table.
 * @param t - The translator.
 * @returns The entries, in the order the first batch settled.
 */
export function insertMenuItems(
  t: (key: string) => string,
): InsertMenuItem[] {
  return INSERT_MENU_ROWS.flatMap((id) => {
    const item = BLOCK_TYPE_ITEMS.find((one) => one.id === id);
    return item === undefined
      ? []
      : [{ id, title: t(item.labelKey), Icon: item.Icon }];
  });
}

/**
 * The entries whose name holds what the reader has typed.
 * @param items - Every entry.
 * @param query - What the reader typed after the menu opened.
 * @returns The ones that match.
 */
export function filterInsertItems(
  items: readonly InsertMenuItem[],
  query: string,
): InsertMenuItem[] {
  const needle = query.trim().toLowerCase();
  if (needle === '') return [...items];
  return items.filter((item) => item.title.toLowerCase().includes(needle));
}

/**
 * The list itself.
 * @param props - See {@link DocumentInsertMenuProps}.
 * @param props.items - The entries that survived the query.
 * @param props.onItemClick - Runs an entry and closes the menu.
 * @param props.selectedIndex - Which entry the arrow keys are on.
 * @returns The menu.
 */
export function DocumentInsertMenu({
  items,
  onItemClick,
  selectedIndex,
}: DocumentInsertMenuProps): React.JSX.Element {
  const t = useTranslation();

  return (
    <div className={SURFACE} data-testid='doc-insert-menu'>
      {items.length === 0 ? (
        <div className={cn(ROW, 'text-muted-foreground')}>
          {t('spaces.document.insertMenu.empty')}
        </div>
      ) : (
        <>
          <div className={HEADING}>{t(INSERT_GROUP_LABEL_KEY)}</div>
          {items.map((item, index) => {
            const Icon = item.Icon;
            return (
              <Button
                key={item.id}
                variant='ghost'
                size='menu-item'
                tabIndex={-1}
                data-testid={`doc-insert-${item.id}`}
                data-selected={index === selectedIndex ? 'true' : undefined}
                className={cn(ROW, index === selectedIndex && 'bg-accent')}
                onClick={() => {
                  onItemClick?.(item);
                }}
              >
                <Icon />
                {item.title}
              </Button>
            );
          })}
        </>
      )}
    </div>
  );
}
