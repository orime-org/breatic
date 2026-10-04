// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The list an `@` opens: the rows the reader can pick, arrow keys to move the
 * highlight, Enter or Tab to pick it. Rendered by the suggestion's
 * ReactRenderer and positioned at the caret (see mention-suggestion). What a
 * row looks like is the caller's; the keys and the frame are shared.
 */

import * as React from 'react';

import { Button } from '@web/components/ui/button';
import { ScrollArea } from '@web/components/ui/scroll-area';

/** Imperative handle so the suggestion can forward key events into the list. */
export interface MentionListRef {
  /** Returns true when the key was handled, false otherwise. */
  onKeyDown: (event: KeyboardEvent) => boolean;
}

/** What the list is given to show. */
export interface MentionListProps<T> {
  /** The rows to choose from (already filtered by the typed query). */
  items: T[];
  /** Picks a row. */
  command: (item: T) => void;
  /**
   * Localized text for an empty list. WHICH sentence it is gets decided one
   * layer up, where both filters are still visible (#1952).
   */
  emptyLabel: string;
  /** A stable key for a row, also used in its test id. */
  itemKey: (item: T) => string;
  /** What is typed after the `@`; a change of it puts the highlight back on the first row. */
  query: string;
  /** What a row shows. */
  renderItem: (item: T) => React.ReactNode;
}

/**
 * Keyboard-navigable list of rows for the `@` popup.
 * @param root0 - Component props.
 * @param root0.items - Rows filtered by the typed query.
 * @param root0.command - Picks a row.
 * @param root0.emptyLabel - Localized empty-state text.
 * @param root0.itemKey - A stable key for a row.
 * @param root0.renderItem - What a row shows.
 * @param root0.query - What is typed after the `@`.
 * @param ref - Imperative handle exposing `onKeyDown` to the suggestion.
 * @returns The popup list.
 */
function MentionListInner<T>(
  { items, command, emptyLabel, itemKey, renderItem, query }: MentionListProps<T>,
  ref: React.ForwardedRef<MentionListRef>,
): React.JSX.Element {
  // The highlight is the row the reader moved to, kept by its key: rows that
  // come and go around it (an upload finishing, a collaborator's edit, a
  // fresh array for the same rows) leave it where it is. It goes back to the
  // first row when the reader changes the query, or when its row is gone.
  const [picked, setPicked] = React.useState<string | null>(null);
  const [pickedUnder, setPickedUnder] = React.useState(query);
  if (pickedUnder !== query) {
    setPickedUnder(query);
    setPicked(null);
  }
  const at = picked === null ? -1 : items.findIndex((item) => itemKey(item) === picked);
  const selected = at >= 0 ? at : 0;
  const listRef = React.useRef<HTMLDivElement>(null);
  const select = React.useCallback(
    (index: number): void => {
      const item = items[index];
      if (item !== undefined) setPicked(itemKey(item));
    },
    [items, itemKey],
  );
  // Keep the keyboard-selected row visible (I1, user 2026-07-12). The popup's
  // own viewport is its only scrolling ancestor while the popup is on screen,
  // so `block: 'nearest'` moves nothing else.
  React.useEffect(() => {
    listRef.current?.children[selected]?.scrollIntoView({ block: 'nearest' });
  }, [selected]);

  const pick = React.useCallback(
    (index: number): void => {
      const item = items[index];
      if (item !== undefined) command(item);
    },
    [items, command],
  );

  React.useImperativeHandle(
    ref,
    () => ({
      onKeyDown: (event: KeyboardEvent): boolean => {
        if (items.length === 0) return false;
        if (event.key === 'ArrowUp') {
          select((selected + items.length - 1) % items.length);
          return true;
        }
        if (event.key === 'ArrowDown') {
          select((selected + 1) % items.length);
          return true;
        }
        // Shift+Tab is the keyboard moving back, and is left to it.
        if (event.key === 'Enter' || (event.key === 'Tab' && !event.shiftKey)) {
          pick(selected);
          return true;
        }
        return false;
      },
    }),
    [items, selected, pick, select],
  );

  if (items.length === 0) {
    return (
      <div
        // Named so a container test can read WHICH of the two sentences landed
        // here; picking the wrong one type-checks (both are strings).
        data-testid='reference-mention-empty'
        className='w-56 rounded-overlay border border-border bg-popover px-3 py-2 text-xs text-muted-foreground shadow-md'
      >
        {emptyLabel}
      </div>
    );
  }

  return (
    // The height cap + padding sit on the viewport (the scroller); `listRef`
    // points at the rows' DIRECT parent so `children[selected]` is a row.
    <ScrollArea
      className='w-56 rounded-overlay border border-border bg-popover shadow-md'
      viewportClassName='max-h-56 p-1'
    >
      <div ref={listRef}>
        {items.map((item, i) => (
          <Button
            key={itemKey(item)}
            variant={null}
            size={null}
            type='button'
            data-testid={`reference-mention-option-${itemKey(item)}`}
            onClick={() => pick(i)}
            onMouseEnter={() => select(i)}
            // justify-start: the Button base centres its content, and these
            // rows read from the left edge.
            className={
              'flex w-full items-center justify-start gap-2 rounded-overlay px-2 py-1 text-left text-xs ' +
              (i === selected ? 'bg-accent text-accent-foreground' : 'text-popover-foreground')
            }
          >
            {renderItem(item)}
          </Button>
        ))}
      </div>
    </ScrollArea>
  );
}

/** {@link MentionListInner} with its ref forwarded, keeping the row type. */
export const MentionList = React.forwardRef(MentionListInner) as <T>(
  props: MentionListProps<T> & { ref?: React.Ref<MentionListRef> },
) => React.JSX.Element;
